import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import type { ApexCEO } from '@workspace/agents';
import { db, voiceChatSessions, voiceChatTurns } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { CHAT_SYSTEM_PROMPT, CHAT_TOOLS, buildLiveSnapshot, executeTool } from './routes/chat.js';

const GEMINI_LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const GEMINI_LIVE_MODEL = 'gemini-3.8-live';
const INITIAL_SETUP_TIMEOUT_MS = 5000;
const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_BASE_MS = 250;
const MAX_BUFFERED_AUDIO_FRAMES = 100;

interface GeminiFunctionCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

interface GeminiServerContent {
  interrupted?: boolean;
  turnComplete?: boolean;
  inputTranscription?: { text?: string };
  outputTranscription?: { text?: string };
  modelTurn?: {
    parts?: Array<{
      inlineData?: { data?: string; mimeType?: string };
      text?: string;
    }>;
  };
}

interface GeminiLiveOptions {
  client: WebSocket;
  ceo: ApexCEO;
  apiKey: string;
  startPage?: string;
}

export async function tryStartGeminiLiveSession({
  client,
  ceo,
  apiKey,
  startPage,
}: GeminiLiveOptions): Promise<boolean> {
  let currentPageNote = startPage
    ? '\n\nDon\'s current screen: he is looking at the "' + startPage + '" page.'
    : '';
  let pendingScreenContext: string | null = null;

  let upstream: WebSocket | null = null;
  let upstreamReady = false;
  let sessionHandle: string | undefined;
  let intentionallyClosed = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let voiceSessionId: string | null = null;
  let lastSpeechStartedAt: number | null = null;
  let lastUserTranscriptAt: number | null = null;
  let firstAudioPending = false;
  let bufferedAudio: string[] = [];
  const cancelledToolIds = new Set<string>();

  const safeSendClient = (payload: Record<string, unknown>) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
  };

  const persistTurn = (role: 'user' | 'assistant', text: string) => {
    if (!voiceSessionId || !text) return;
    db.insert(voiceChatTurns)
      .values({ id: randomUUID(), sessionId: voiceSessionId, role, text })
      .catch((err) =>
        console.error(
          '[gemini-live] failed to persist turn:',
          err instanceof Error ? err.message : String(err),
        ),
      );
  };

  const ensureSessionRow = () => {
    if (voiceSessionId) return;
    voiceSessionId = randomUUID();
    db.insert(voiceChatSessions)
      .values({ id: voiceSessionId, startPage: startPage ?? null })
      .catch((err) =>
        console.error(
          '[gemini-live] failed to persist session start:',
          err instanceof Error ? err.message : String(err),
        ),
      );
  };

  const buildSystemPrompt = async (): Promise<string> => {
    let snapshot = '';
    try {
      snapshot = await buildLiveSnapshot();
    } catch (err) {
      console.error('[gemini-live] buildLiveSnapshot failed:', err);
    }

    return (
      CHAT_SYSTEM_PROMPT +
      '\n\nThis is a LIVE VOICE call, not text chat — Don is talking to you out loud in real time. ' +
      'Speak naturally and conversationally with short turns. No markdown or bullet dumps unless he explicitly asks. ' +
      'Your job is to stay responsive while the APEX workforce does heavy work. For multi-step debugging, deployments, ' +
      'architecture, research, repository work, or anything that can outlive this spoken turn, call create_goal immediately, ' +
      'briefly acknowledge the dispatch, and remain available for another command. Do not wait for long-running work inside ' +
      'the realtime voice turn. Simple questions, status checks, approvals, and quick lookups can be handled directly. ' +
      'If Don interrupts you, stop immediately and follow the new instruction. The user can redirect, cancel, ask for progress, ' +
      'or start another task at any time. Screen-context notes are silent context only: use them to resolve words like "this" ' +
      'and "that", but never read or comment on the notes themselves.' +
      currentPageNote +
      '\n\nCurrent live snapshot:\n' +
      snapshot
    );
  };

  const functionDeclarations = CHAT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    behavior: 'NON_BLOCKING',
  }));

  const sendGemini = (payload: Record<string, unknown>) => {
    if (upstreamReady && upstream?.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify(payload));
      return true;
    }
    return false;
  };

  const flushBufferedAudio = () => {
    if (!upstream || upstream.readyState !== WebSocket.OPEN || bufferedAudio.length === 0) return;
    const frames = bufferedAudio;
    bufferedAudio = [];
    for (const data of frames) {
      upstream.send(
        JSON.stringify({
          realtimeInput: {
            audio: { data, mimeType: 'audio/pcm;rate=16000' },
          },
        }),
      );
    }
  };

  const sendToolResult = (
    fc: GeminiFunctionCall,
    result: Record<string, unknown>,
    scheduling: 'WHEN_IDLE' | 'INTERRUPT' | 'SILENT' = 'WHEN_IDLE',
  ) => {
    if (cancelledToolIds.has(fc.id)) return;
    sendGemini({
      toolResponse: {
        functionResponses: [
          {
            id: fc.id,
            name: fc.name,
            response: {
              result,
              scheduling,
            },
          },
        ],
      },
    });
  };

  const handleToolCall = (fc: GeminiFunctionCall) => {
    void (async () => {
      if (cancelledToolIds.has(fc.id)) return;
      const dispatchedAt = Date.now();
      safeSendClient({ type: 'toolActivity', name: fc.name });

      if (lastSpeechStartedAt !== null) {
        safeSendClient({
          type: 'latency',
          stage: 'tool_dispatch',
          ms: dispatchedAt - lastSpeechStartedAt,
        });
      }
      if (lastUserTranscriptAt !== null) {
        safeSendClient({
          type: 'latency',
          stage: 'command_classification',
          ms: dispatchedAt - lastUserTranscriptAt,
        });
      }

      let result: Record<string, unknown>;
      try {
        result = await executeTool({ name: fc.name, args: fc.args ?? {} }, ceo);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }

      safeSendClient({
        type: 'latency',
        stage: 'tool_complete',
        ms: Date.now() - dispatchedAt,
      });

      if (cancelledToolIds.has(fc.id)) return;

      if (fc.name === 'create_goal' && result.goalId) {
        safeSendClient({
          type: 'goalCreated',
          id: String(result.goalId),
          title: String(result.title ?? fc.args?.title ?? ''),
        });
      }

      if (
        (fc.name === 'approve_pending_approval' ||
          fc.name === 'reject_pending_approval' ||
          fc.name === 'acknowledge_escalation') &&
        !result.error
      ) {
        safeSendClient({
          type: 'approvalResolved',
          id: fc.args?.id,
          action: fc.name,
        });
      }

      sendToolResult(fc, result, 'WHEN_IDLE');
    })();
  };

  const connect = async (resumeHandle?: string): Promise<boolean> => {
    const systemPrompt = await buildSystemPrompt();
    const url = GEMINI_LIVE_URL + '?key=' + encodeURIComponent(apiKey);
    const ws = new WebSocket(url);
    upstream = ws;
    upstreamReady = false;

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let setupComplete = false;

      const setupTimer = setTimeout(() => {
        if (setupComplete || settled) return;
        settled = true;
        try {
          ws.close(1000, 'setup timeout');
        } catch {
          // ignore close race
        }
        resolve(false);
      }, INITIAL_SETUP_TIMEOUT_MS);

      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(setupTimer);
        resolve(ok);
      };

      ws.on('open', () => {
        const setup: Record<string, unknown> = {
          model: 'models/' + GEMINI_LIVE_MODEL,
          generationConfig: { responseModalities: ['AUDIO'] },
          systemInstruction: {
            parts: [{ text: systemPrompt }],
          },
          tools: [{ functionDeclarations }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
              prefixPaddingMs: 20,
              endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
              silenceDurationMs: 300,
            },
            activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
            turnCoverage: 'TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO',
          },
          contextWindowCompression: {
            slidingWindow: {},
          },
          sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
        };

        ws.send(JSON.stringify({ setup }));
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        let msg: any;
        try {
          const rawBuffer = Buffer.isBuffer(raw)
            ? raw
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw)
              : Array.isArray(raw)
                ? Buffer.concat(raw)
                : Buffer.from(raw as Uint8Array);
          msg = JSON.parse(rawBuffer.toString('utf8'));
        } catch {
          return;
        }

        if (msg.setupComplete) {
          setupComplete = true;
          upstreamReady = true;
          reconnectAttempts = 0;
          ensureSessionRow();
          safeSendClient({ type: 'ready', provider: 'gemini', model: GEMINI_LIVE_MODEL });
          flushBufferedAudio();
          settle(true);
          console.log('[gemini-live] setup complete');
          return;
        }

        if (msg.sessionResumptionUpdate) {
          const update = msg.sessionResumptionUpdate as {
            resumable?: boolean;
            newHandle?: string;
          };
          if (update.resumable && update.newHandle) sessionHandle = update.newHandle;
        }

        if (msg.goAway) {
          console.warn('[gemini-live] server sent GoAway; session will resume on reconnect');
        }

        if (msg.toolCallCancellation?.ids) {
          for (const id of msg.toolCallCancellation.ids as string[]) {
            cancelledToolIds.add(id);
          }
        }

        if (msg.toolCall?.functionCalls) {
          for (const rawCall of msg.toolCall.functionCalls as GeminiFunctionCall[]) {
            handleToolCall({
              id: rawCall.id,
              name: rawCall.name,
              args: rawCall.args ?? {},
            });
          }
        }

        const serverContent = msg.serverContent as GeminiServerContent | undefined;
        if (!serverContent) return;

        if (serverContent.interrupted) {
          if (lastSpeechStartedAt !== null) {
            safeSendClient({
              type: 'latency',
              stage: 'speech_vad',
              ms: Math.max(0, Date.now() - lastSpeechStartedAt),
            });
          }
          safeSendClient({ type: 'interrupted' });
        }

        const inputText = serverContent.inputTranscription?.text?.trim();
        if (inputText) {
          lastUserTranscriptAt = Date.now();
          if (lastSpeechStartedAt !== null) {
            safeSendClient({
              type: 'latency',
              stage: 'transcript_ready',
              ms: lastUserTranscriptAt - lastSpeechStartedAt,
            });
          }
          safeSendClient({ type: 'transcript', role: 'user', text: inputText });
          persistTurn('user', inputText);
        }

        const outputText = serverContent.outputTranscription?.text?.trim();
        if (outputText) {
          safeSendClient({ type: 'transcript', role: 'assistant', text: outputText });
          persistTurn('assistant', outputText);
        }

        if (serverContent.modelTurn?.parts) {
          for (const part of serverContent.modelTurn.parts) {
            const audio = part.inlineData;
            if (!audio?.data) continue;
            if (firstAudioPending && lastSpeechStartedAt !== null) {
              safeSendClient({
                type: 'latency',
                stage: 'first_audio',
                ms: Date.now() - lastSpeechStartedAt,
              });
              firstAudioPending = false;
            }
            safeSendClient({ type: 'audio', data: audio.data });
          }
        }

        if (serverContent.turnComplete) {
          safeSendClient({ type: 'turnComplete' });
        }
      });

      ws.on('error', (err) => {
        console.error('[gemini-live] websocket error:', err.message);
      });

      ws.on('close', (code, reason) => {
        upstreamReady = false;
        clearTimeout(setupTimer);

        if (!setupComplete) {
          console.warn(
            '[gemini-live] initial setup failed: ' +
              code +
              ' ' +
              reason.toString().slice(0, 180),
          );
          settle(false);
          return;
        }

        if (intentionallyClosed || client.readyState !== WebSocket.OPEN) return;

        if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
          safeSendClient({
            type: 'error',
            message: 'Gemini Live disconnected and could not resume after several attempts.',
          });
          client.close();
          return;
        }

        const delay = Math.min(2000, RECONNECT_BASE_MS * 2 ** reconnectAttempts);
        reconnectAttempts += 1;
        console.warn(
          '[gemini-live] connection dropped (' +
            code +
            '); resuming in ' +
            delay +
            'ms (attempt ' +
            reconnectAttempts +
            '/' +
            RECONNECT_MAX_ATTEMPTS +
            ')',
        );

        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (intentionallyClosed || client.readyState !== WebSocket.OPEN) return;
          void connect(sessionHandle).then((ok) => {
            if (!ok && client.readyState === WebSocket.OPEN) {
              safeSendClient({
                type: 'error',
                message: 'Gemini Live could not resume the session.',
              });
              client.close();
            }
          });
        }, delay);
      });
    });
  };

  const initialConnected = await connect();
  if (!initialConnected) {
    intentionallyClosed = true;
    // connect() already closes the initial socket on setup timeout, and the
    // close/error path has already fired for transport/provider rejection.
    // Nothing else owns the browser socket yet, so return cleanly and let
    // live-voice.ts activate its Deepgram fallback on this same call.
    return false;
  }

  client.on('message', (raw, isBinary) => {
    if (isBinary) return;

    let msg: any;
    try {
      const bytes = Buffer.isBuffer(raw)
        ? raw
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.from(raw as Uint8Array);
      msg = JSON.parse(bytes.toString('utf8'));
    } catch {
      return;
    }

    if (msg.type === 'audio' && typeof msg.data === 'string') {
      if (upstreamReady && upstream?.readyState === WebSocket.OPEN) {
        sendGemini({
          realtimeInput: {
            audio: {
              data: msg.data,
              mimeType: 'audio/pcm;rate=16000',
            },
          },
        });
      } else {
        bufferedAudio.push(msg.data);
        if (bufferedAudio.length > MAX_BUFFERED_AUDIO_FRAMES) {
          bufferedAudio = bufferedAudio.slice(-MAX_BUFFERED_AUDIO_FRAMES);
        }
      }
      return;
    }

    if (msg.type === 'speech_started') {
      lastSpeechStartedAt = Date.now();
      lastUserTranscriptAt = null;
      firstAudioPending = true;

      if (pendingScreenContext) {
        sendGemini({
          realtimeInput: {
            text:
              '[screen context — silent context only, do not read aloud or reply to this note] ' +
              pendingScreenContext,
          },
        });
        pendingScreenContext = null;
      }
      return;
    }

    if (msg.type === 'context' && typeof msg.text === 'string' && msg.text.length <= 300) {
      currentPageNote = '\n\nDon\'s current screen: ' + msg.text;
      pendingScreenContext = msg.text;
      return;
    }

    if (msg.type === 'end') {
      intentionallyClosed = true;
      sendGemini({ realtimeInput: { audioStreamEnd: true } });
      client.close();
    }
  });

  client.on('close', () => {
    intentionallyClosed = true;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    try {
      if (upstream?.readyState === WebSocket.OPEN || upstream?.readyState === WebSocket.CONNECTING) {
        upstream.close(1000, 'browser call ended');
      }
    } catch {
      // ignore shutdown race
    }

    if (voiceSessionId) {
      db.update(voiceChatSessions)
        .set({ endedAt: new Date() })
        .where(eq(voiceChatSessions.id, voiceSessionId))
        .catch((err) =>
          console.error(
            '[gemini-live] failed to persist session end:',
            err instanceof Error ? err.message : String(err),
          ),
        );
    }
  });

  client.on('error', (err) => {
    console.error('[gemini-live] browser websocket error:', err.message);
  });

  return true;
}
