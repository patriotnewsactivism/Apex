import { WebSocketServer, WebSocket } from 'ws';
import { consumeWebSocketTicket } from './websocket-auth.js';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import type { ApexCEO } from '@workspace/agents';
import { CHAT_SYSTEM_PROMPT, CHAT_TOOLS, buildLiveSnapshot, executeTool } from './routes/chat.js';
import type { LLMTool } from '@workspace/core';

// ─── Live voice: real-time conversation with Apex via Gemini Live ────────────
//
// Don asked for the same kind of live voice agent BuildMyBot2 uses, but built
// on Gemini Live (gemini-3.1-flash-live-preview) — confirmed live and
// protocol-verified against the real Gemini Live API this session (real
// WebSocket round-trip: setup → tool call → tool response → transcript, all
// observed working end-to-end before writing this relay).
//
// Architecture: server-to-server. The browser never sees GEMINI_API_KEY —
// it opens a WebSocket to US (this route), we open our OWN WebSocket to
// Gemini and relay audio + tool calls both ways. This reuses the exact same
// tool executor (executeTool) as the text Quick Chat, so "approve that" or
// "deploy a goal to fix X" spoken out loud does the SAME real action as
// typing it — including approve_pending_approval / reject_pending_approval,
// which is the "implement the decisions I make" part of the ask.
//
// Client <-> server wire protocol (JSON messages over the /ws/voice-live
// socket, separate from Gemini's own wire format):
//   client -> server: { type: 'audio', data: base64 }           16kHz PCM16
//   client -> server: { type: 'end' }                            hang up
//   server -> client: { type: 'ready' }                          Gemini session live
//   server -> client: { type: 'audio', data: base64 }            24kHz PCM16
//   server -> client: { type: 'transcript', role, text }         live captions
//   server -> client: { type: 'goalCreated', id, title }         action taken
//   server -> client: { type: 'toolActivity', name }             brief "doing X" ping
//   server -> client: { type: 'error', message }

const GEMINI_LIVE_MODEL = 'models/gemini-3.1-flash-live-preview';

function toGeminiType(t: unknown): string {
  return String(t).toUpperCase();
}

function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  if (typeof out.type === 'string') out.type = toGeminiType(out.type);
  if (out.properties && typeof out.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.properties as Record<string, unknown>)) {
      props[k] = toGeminiSchema(v as Record<string, unknown>);
    }
    out.properties = props;
  }
  return out;
}

function toGeminiTools(tools: LLMTool[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: toGeminiSchema(t.parameters),
      })),
    },
  ];
}

const GEMINI_TOOLS = toGeminiTools(CHAT_TOOLS);

export function setupLiveVoice(server: Server, ceo: ApexCEO) {
  const wss = new WebSocketServer({ server, path: '/ws/voice-live' });

  wss.on('connection', async (client: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (!consumeWebSocketTicket(url.searchParams.get('ticket'))) {
      client.close(1008, 'Invalid or expired ticket');
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      client.send(JSON.stringify({ type: 'error', message: 'GEMINI_API_KEY is not configured on this deployment.' }));
      client.close(1011, 'Not configured');
      return;
    }

    console.log('🎙️  Live voice client connected');

    let geminiOpen = false;
    let goalCreatedThisSession: { id: string; title: string } | undefined;
    const geminiUrl =
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    const gemini = new WebSocket(geminiUrl);

    const safeSendClient = (payload: Record<string, unknown>) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
    };
    const safeSendGemini = (payload: Record<string, unknown>) => {
      if (gemini.readyState === WebSocket.OPEN) gemini.send(JSON.stringify(payload));
    };

    gemini.on('open', async () => {
      let snapshot = '';
      try {
        snapshot = await buildLiveSnapshot();
      } catch (err) {
        console.error('[live-voice] buildLiveSnapshot failed:', err);
      }
      safeSendGemini({
        setup: {
          model: GEMINI_LIVE_MODEL,
          generationConfig: { responseModalities: ['AUDIO'] },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          systemInstruction: {
            parts: [
              {
                text:
                  `${CHAT_SYSTEM_PROMPT}\n\nThis is a LIVE VOICE call, not text chat — Don is talking to you out ` +
                  `loud in real time. Speak naturally and conversationally, like a real phone call: shorter turns, ` +
                  `no bullet lists, no markdown. If he approves/rejects/acknowledges something, actually call the ` +
                  `tool — don't just say you will.\n\nCurrent live snapshot:\n${snapshot}`,
              },
            ],
          },
          tools: GEMINI_TOOLS,
        },
      });
    });

    gemini.on('message', async (raw) => {
      let data: any;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (data.setupComplete) {
        geminiOpen = true;
        safeSendClient({ type: 'ready' });
        return;
      }

      if (data.toolCall?.functionCalls) {
        const responses: Array<{ id: string; name: string; response: Record<string, unknown> }> = [];
        for (const fc of data.toolCall.functionCalls) {
          safeSendClient({ type: 'toolActivity', name: fc.name });
          let result: Record<string, unknown>;
          try {
            result = await executeTool({ name: fc.name, args: fc.args ?? {} }, ceo);
          } catch (err) {
            result = { error: err instanceof Error ? err.message : String(err) };
          }
          if (fc.name === 'create_goal' && result.goalId) {
            goalCreatedThisSession = { id: String(result.goalId), title: String(result.title ?? fc.args?.title ?? '') };
            safeSendClient({ type: 'goalCreated', ...goalCreatedThisSession });
          }
          if (
            (fc.name === 'approve_pending_approval' || fc.name === 'reject_pending_approval' || fc.name === 'acknowledge_escalation') &&
            !result.error
          ) {
            safeSendClient({ type: 'approvalResolved', id: fc.args?.id, action: fc.name });
          }
          responses.push({ id: fc.id, name: fc.name, response: result });
        }
        safeSendGemini({ toolResponse: { functionResponses: responses } });
        return;
      }

      const sc = data.serverContent;
      if (sc) {
        if (sc.inputTranscription?.text) {
          safeSendClient({ type: 'transcript', role: 'user', text: sc.inputTranscription.text });
        }
        if (sc.outputTranscription?.text) {
          safeSendClient({ type: 'transcript', role: 'assistant', text: sc.outputTranscription.text });
        }
        if (sc.modelTurn?.parts) {
          for (const part of sc.modelTurn.parts) {
            if (part.inlineData?.data) {
              safeSendClient({ type: 'audio', data: part.inlineData.data });
            }
          }
        }
        if (sc.interrupted) {
          safeSendClient({ type: 'interrupted' });
        }
      }
    });

    gemini.on('error', (err) => {
      console.error('[live-voice] Gemini WS error:', err.message);
      safeSendClient({ type: 'error', message: 'Voice provider connection error.' });
    });

    gemini.on('close', (code, reason) => {
      if (code !== 1000) {
        console.warn(`[live-voice] Gemini WS closed: ${code} ${reason.toString().slice(0, 200)}`);
      }
      if (client.readyState === WebSocket.OPEN) client.close();
    });

    client.on('message', (raw) => {
      if (!geminiOpen) return;
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'audio' && msg.data) {
        safeSendGemini({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: msg.data } } });
      } else if (msg.type === 'end') {
        safeSendGemini({ realtimeInput: { audioStreamEnd: true } });
      }
    });

    client.on('close', () => {
      console.log('🎙️  Live voice client disconnected');
      if (gemini.readyState === WebSocket.OPEN || gemini.readyState === WebSocket.CONNECTING) {
        gemini.close();
      }
    });

    client.on('error', (err) => {
      console.error('[live-voice] Client WS error:', err.message);
    });
  });

  return wss;
}
