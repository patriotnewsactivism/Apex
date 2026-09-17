import { WebSocket } from 'ws';
import { registerWebSocketRoute } from './websocket-upgrade.js';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import type { ApexCEO } from '@workspace/agents';
import { CHAT_SYSTEM_PROMPT, CHAT_TOOLS, buildLiveSnapshot, executeTool } from './routes/chat.js';

// ─── Live voice: real-time conversation with Apex via Deepgram Voice Agent ───
//
// Switched from Gemini Live after Google denied the configured project
// access to the Live/bidiGenerateContent websocket specifically — a
// documented free-tier restriction on that real-time endpoint, confirmed
// live via production logs ("Gemini WS closed: 1008 Your project has been
// denied access. Please contact support."). Deepgram's Voice Agent API
// (agent.deepgram.com/v1/agent/converse) bundles STT + LLM + TTS over one
// websocket, matching the shape this file already needs — and this exact
// provider/protocol is already proven elsewhere in this codebase
// (telnyx-deepgram-agent.ts, for phone calls), so the wire format here
// follows that same confirmed pattern rather than guessing at Deepgram's
// schema from scratch.
//
// The "think" (LLM) step runs on Groq rather than Deepgram's own OpenAI
// integration: Groq is one of Deepgram's explicitly documented "bring your
// own" 3rd-party think providers (custom endpoint + Bearer key, OpenAI-
// compatible request shape) — unlike OpenRouter, which isn't a documented
// option at all. Apex holds no OpenAI/Anthropic key of its own, Matthew
// already runs a working GROQ_API_KEY on other services, and Groq's low
// latency is a genuine fit for a live spoken conversation specifically,
// not just the safe fallback.
//
// Architecture unchanged from the Gemini version: server-to-server relay.
// The browser never sees DEEPGRAM_API_KEY or GROQ_API_KEY — it opens a
// WebSocket to US (this route), we open our OWN WebSocket to Deepgram and
// relay audio + tool calls both ways. Reuses the exact same tool executor
// (executeTool) as text chat, so a spoken "approve that" does the same real
// action as typing it.
//
// Client <-> server wire protocol is UNCHANGED from the Gemini version —
// this is a backend-only swap; useLiveVoiceCall.ts needs no changes at all:
//   client -> server: { type: 'audio', data: base64 }           16kHz PCM16
//   client -> server: { type: 'context', text }                  screen nav
//   client -> server: { type: 'end' }                            hang up
//   server -> client: { type: 'ready' }                          agent session live
//   server -> client: { type: 'audio', data: base64 }            24kHz PCM16
//   server -> client: { type: 'transcript', role, text }         live captions
//   server -> client: { type: 'goalCreated', id, title }         action taken
//   server -> client: { type: 'approvalResolved', id, action }   action taken
//   server -> client: { type: 'toolActivity', name }             brief "doing X" ping
//   server -> client: { type: 'interrupted' }                    barge-in
//   server -> client: { type: 'turnComplete' }                   close caption bubble
//   server -> client: { type: 'error', message }

const DEEPGRAM_AGENT_URL = 'wss://agent.deepgram.com/v1/agent/converse';
const GROQ_ENDPOINT_URL = 'https://api.groq.com/openai/v1/chat/completions';
// llama-3.3-70b-versatile (the original choice) turned out to be deprecated on
// Groq — confirmed live: Deepgram reached this exact endpoint with valid auth
// and got back a clean 404 model_not_found, closing the session with
// FAILED_TO_THINK. openai/gpt-oss-120b is Groq's current production model
// with confirmed native tool-calling via the standard OpenAI `tools` format,
// which is what this file's function-call relay depends on.
const GROQ_THINK_MODEL = 'openai/gpt-oss-120b';
/** Deepgram closes an idle agent session without a periodic nudge. */
const KEEPALIVE_INTERVAL_MS = 5_000;

interface DeepgramFunctionCall {
  id: string;
  name: string;
  arguments?: string;
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as Uint8Array);
}

export function setupLiveVoice(server: Server, ceo: ApexCEO) {
  const wss = registerWebSocketRoute(server, '/ws/voice-live', async (client: WebSocket, _req: IncomingMessage) => {
    // The Apex page Don was viewing when he started the call — the client
    // sends ?page=<Title (pageId)>. Mid-call navigation updates arrive as
    // { type: 'context' } messages.
    const startPage = (() => {
      try {
        return new URL(_req.url ?? '', 'http://apex.local').searchParams.get('page') ?? undefined;
      } catch {
        return undefined;
      }
    })();

    const deepgramKey = process.env.DEEPGRAM_API_KEY;
    // GROQ_API_KEY is an account-level credential reused by other services on
    // this Groq account, so its shared per-minute token budget could starve a
    // live call regardless of what Apex itself sends. GROQ_API_KEY_2 is a
    // dedicated key provisioned for live-voice specifically — prefer it, and
    // only fall back to the shared key where the dedicated one isn't set.
    const groqKey = process.env.GROQ_API_KEY_2 || process.env.GROQ_API_KEY;
    if (!deepgramKey || !groqKey) {
      const missing = [!deepgramKey && 'DEEPGRAM_API_KEY', !groqKey && 'GROQ_API_KEY_2 or GROQ_API_KEY'].filter(Boolean).join(' and ');
      client.send(JSON.stringify({ type: 'error', message: `${missing} not configured on this deployment.` }));
      client.close(1011, 'Not configured');
      return;
    }

    console.log('🎙️  Live voice client connected');

    let agentReady = false;
    let goalCreatedThisSession: { id: string; title: string } | undefined;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    // Deepgram's ConversationText event is a single unified "here's what was
    // said" channel — unlike Gemini's inputTranscription/outputTranscription
    // fields, it does not distinguish real speech from an echo of a text-only
    // InjectUserMessage we sent ourselves. Track exactly what we injected so
    // its echo can be dropped instead of relayed to the client as a caption.
    const pendingContextEchoes = new Set<string>();

    const deepgram = new WebSocket(DEEPGRAM_AGENT_URL, {
      headers: { Authorization: `Token ${deepgramKey}` },
    });

    const safeSendClient = (payload: Record<string, unknown>) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
    };
    const safeSendDeepgram = (payload: Record<string, unknown>) => {
      if (deepgram.readyState === WebSocket.OPEN) deepgram.send(JSON.stringify(payload));
    };
    const stopKeepAlive = () => {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
    };

    deepgram.on('open', () => {
      console.log('[live-voice] Deepgram agent connected');
    });

    deepgram.on('message', async (raw: WebSocket.RawData, isBinary: boolean) => {
      // Audio and JSON control messages share the same stream — isBinary is
      // the only reliable way to tell them apart (Node's ws can deliver text
      // frames as Buffer objects too, so Buffer.isBuffer() alone would
      // misclassify a JSON event as audio and corrupt the stream — same
      // lesson already applied in telnyx-deepgram-agent.ts).
      if (isBinary) {
        safeSendClient({ type: 'audio', data: rawDataToBuffer(raw).toString('base64') });
        return;
      }

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(rawDataToBuffer(raw).toString('utf8'));
      } catch {
        return;
      }

      switch (event.type) {
        case 'Welcome': {
          let snapshot = '';
          try {
            snapshot = await buildLiveSnapshot();
          } catch (err) {
            console.error('[live-voice] buildLiveSnapshot failed:', err);
          }
          const screenNote = startPage
            ? `\n\nDon's current screen: he is looking at the "${startPage}" page.`
            : '';
          safeSendDeepgram({
            type: 'Settings',
            audio: {
              input: { encoding: 'linear16', sample_rate: 16000 },
              output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
            },
            agent: {
              language: 'en',
              listen: { provider: { type: 'deepgram', model: 'nova-3-general' } },
              think: {
                provider: { type: 'groq', model: GROQ_THINK_MODEL },
                endpoint: { url: GROQ_ENDPOINT_URL, headers: { Authorization: `Bearer ${groqKey}` } },
                prompt:
                  `${CHAT_SYSTEM_PROMPT}\n\nThis is a LIVE VOICE call, not text chat — Don is talking to you out ` +
                  `loud in real time. Speak naturally and conversationally, like a real phone call: shorter turns, ` +
                  `no bullet lists, no markdown. If he approves/rejects/acknowledges something, actually call the ` +
                  `tool — don't just say you will.${screenNote}` +
                  `You will receive "[screen context]" updates whenever Don moves to a different Apex page. ` +
                  `Use them to understand what "this" or "that" refers to — NEVER read a screen update aloud, ` +
                  `comment on it, or reply to it.\n\nCurrent live snapshot:\n${snapshot}`,
                functions: CHAT_TOOLS,
              },
              speak: { provider: { type: 'deepgram', model: 'aura-2-asteria-en' } },
            },
          });
          break;
        }

        case 'SettingsApplied':
          agentReady = true;
          safeSendClient({ type: 'ready' });
          stopKeepAlive();
          keepAliveTimer = setInterval(() => safeSendDeepgram({ type: 'KeepAlive' }), KEEPALIVE_INTERVAL_MS);
          console.log('[live-voice] Settings applied');
          break;

        // Barge-in: the caller started talking over the agent's own speech.
        case 'UserStartedSpeaking':
          safeSendClient({ type: 'interrupted' });
          break;

        // All audio for the agent's current turn has been sent — the client
        // uses this to close the current caption bubble (streaming transcript
        // fragments otherwise have no reliable turn boundary).
        case 'AgentAudioDone':
          safeSendClient({ type: 'turnComplete' });
          break;

        case 'ConversationText': {
          const role = event.role === 'assistant' ? 'assistant' : 'user';
          const text = typeof event.content === 'string' ? event.content : '';
          if (text && pendingContextEchoes.has(text)) {
            pendingContextEchoes.delete(text);
            break;
          }
          if (text) safeSendClient({ type: 'transcript', role, text });
          break;
        }

        case 'FunctionCallRequest': {
          const functions = Array.isArray(event.functions) ? (event.functions as DeepgramFunctionCall[]) : [];
          for (const fc of functions) {
            safeSendClient({ type: 'toolActivity', name: fc.name });
            let args: Record<string, unknown> = {};
            let result: Record<string, unknown>;
            try {
              args = fc.arguments ? JSON.parse(fc.arguments) : {};
              result = await executeTool({ name: fc.name, args }, ceo);
            } catch (err) {
              result = { error: err instanceof Error ? err.message : String(err) };
            }
            if (fc.name === 'create_goal' && result.goalId) {
              goalCreatedThisSession = { id: String(result.goalId), title: String(result.title ?? args.title ?? '') };
              safeSendClient({ type: 'goalCreated', ...goalCreatedThisSession });
            }
            if (
              (fc.name === 'approve_pending_approval' || fc.name === 'reject_pending_approval' || fc.name === 'acknowledge_escalation') &&
              !result.error
            ) {
              safeSendClient({ type: 'approvalResolved', id: args.id, action: fc.name });
            }
            safeSendDeepgram({ type: 'FunctionCallResponse', id: fc.id, name: fc.name, content: JSON.stringify(result) });
          }
          break;
        }

        case 'Warning':
          console.warn('[live-voice] Deepgram warning:', event);
          break;

        case 'Error': {
          console.error('[live-voice] Deepgram error:', event);
          // FAILED_TO_THINK means Deepgram's request to Groq (the think
          // provider) failed — most often a 429 on Groq's per-minute token
          // budget for whichever account groqKey belongs to, not something a
          // code fix here can raise. Deepgram closes the whole agent session
          // on this error regardless, so the honest answer is "try again
          // shortly," not a generic error.
          const message =
            event.code === 'FAILED_TO_THINK'
              ? "The assistant's AI provider is temporarily rate-limited — please try again in a few seconds."
              : 'Voice provider error.';
          safeSendClient({ type: 'error', message });
          break;
        }

        default:
          break;
      }
    });

    deepgram.on('error', (err) => {
      console.error('[live-voice] Deepgram WS error:', err.message);
      safeSendClient({ type: 'error', message: 'Voice provider connection error.' });
    });

    deepgram.on('close', (code, reason) => {
      stopKeepAlive();
      if (code !== 1000) {
        console.warn(`[live-voice] Deepgram WS closed: ${code} ${reason.toString().slice(0, 200)}`);
      }
      if (client.readyState === WebSocket.OPEN) client.close();
    });

    client.on('message', (raw, isBinary) => {
      if (!agentReady || isBinary) return;
      let msg: any;
      try {
        msg = JSON.parse(rawDataToBuffer(raw).toString('utf8'));
      } catch {
        return;
      }
      if (msg.type === 'audio' && msg.data) {
        if (deepgram.readyState === WebSocket.OPEN) {
          deepgram.send(Buffer.from(msg.data, 'base64'));
        }
      } else if (msg.type === 'context' && typeof msg.text === 'string' && msg.text.length <= 300) {
        // Don navigated to a different Apex page mid-call. Injected as a
        // silent context note — the system prompt above tells the model
        // never to read it aloud, but Deepgram still echoes the injected
        // text back over the same ConversationText event used for real
        // speech, so pendingContextEchoes (above) is what actually keeps
        // it off the client's visible transcript.
        const contextContent = `[screen context — do not read aloud or comment] ${msg.text}`;
        pendingContextEchoes.add(contextContent);
        safeSendDeepgram({
          type: 'InjectUserMessage',
          content: contextContent,
        });
      } else if (msg.type === 'end') {
        client.close();
      }
    });

    client.on('close', () => {
      console.log('🎙️  Live voice client disconnected');
      stopKeepAlive();
      if (deepgram.readyState === WebSocket.OPEN || deepgram.readyState === WebSocket.CONNECTING) {
        deepgram.close();
      }
    });

    client.on('error', (err) => {
      console.error('[live-voice] Client WS error:', err.message);
    });
  });

  return wss;
}
