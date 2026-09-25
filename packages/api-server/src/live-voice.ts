import { WebSocket } from 'ws';
import { registerWebSocketRoute } from './websocket-upgrade.js';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import type { ApexCEO } from '@workspace/agents';
import { CHAT_SYSTEM_PROMPT, CHAT_TOOLS, buildLiveSnapshot, executeTool } from './routes/chat.js';
import { randomUUID } from 'crypto';
import { db, voiceChatSessions, voiceChatTurns } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { tryStartGeminiLiveSession } from './gemini-live-session.js';

// ─── Live voice: direct Gemini 3.8 Live, with Deepgram fallback ──────────────
//
// Browser/admin Live Talk now attempts a direct persistent Gemini 3.8 Live
// BidiGenerateContent session first. This is the fast voice/orchestration
// brain: full-duplex audio, native barge-in, non-blocking function calls, and
// session resumption. Long-running work is dispatched to the APEX swarm.
//
// Deepgram Voice Agent + Groq + ElevenLabs remains a compatibility fallback
// for a deployment whose Gemini project/key still cannot access the Live API.
// This preserves availability while the old 1008 access-denial condition is
// retired. Telephone voice is separate and continues through Telnyx.
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
// The "speak" (TTS) step is ElevenLabs when ELEVENLABS_API_KEY is configured
// (2026-09-25) — Deepgram's own bundled Aura voice remained the fallback
// only, not the target: it is functional but reads as noticeably less
// realistic than ElevenLabs, and Matthew holds an upgraded ElevenLabs plan
// specifically to fix that gap. Deepgram's Voice Agent API accepts ElevenLabs
// as a third-party speak provider the same way Groq is a third-party think
// provider — see ELEVENLABS_TTS_MODEL below for why the model is pinned to
// Turbo 2.5 specifically, not ElevenLabs' higher-realism tiers.
//
// Architecture unchanged from the Gemini version: server-to-server relay.
// The browser never sees DEEPGRAM_API_KEY or GROQ_API_KEY — it opens a
// WebSocket to US (this route), we open our OWN WebSocket to Deepgram and
// relay audio + tool calls both ways. Reuses the exact same tool executor
// (executeTool) as text chat, so a spoken "approve that" does the same real
// action as typing it.
//
// Reconnects: a dropped Deepgram session (network blip, or a transient 429
// from Groq — FAILED_TO_THINK below) is retried with exponential backoff +
// jitter (reconnectDelayMs) instead of ending the call. This is silent to
// the client by design — the existing 'ready' message already means "you
// can talk now" whether this is the first connection or a reconnect, so no
// new wire-protocol message was needed. The client only ever hears about it
// if every retry in the budget fails, via the existing 'error' message.
//
// Client <-> server wire protocol is UNCHANGED from the Gemini version —
// this is a backend-only swap; useLiveVoiceCall.ts needs no changes at all:
//   client -> server: { type: 'audio', data: base64 }           16kHz PCM16
//   client -> server: { type: 'context', text }                  screen nav
//   client -> server: { type: 'end' }                            hang up
//   server -> client: { type: 'ready' }                          agent session live (first connect OR reconnect)
//   server -> client: { type: 'audio', data: base64 }            24kHz PCM16
//   server -> client: { type: 'transcript', role, text }         live captions
//   server -> client: { type: 'goalCreated', id, title }         action taken
//   server -> client: { type: 'approvalResolved', id, action }   action taken
//   server -> client: { type: 'toolActivity', name }             brief "doing X" ping
//   server -> client: { type: 'latency', stage, ms }              live timing sample
//   server -> client: { type: 'interrupted' }                    barge-in
//   server -> client: { type: 'turnComplete' }                   close caption bubble
//   server -> client: { type: 'error', message }                 unrecoverable — retries exhausted

const DEEPGRAM_AGENT_URL = 'wss://agent.deepgram.com/v1/agent/converse';
const GROQ_ENDPOINT_URL = 'https://api.groq.com/openai/v1/chat/completions';
// llama-3.3-70b-versatile (the original choice) turned out to be deprecated on
// Groq — confirmed live: Deepgram reached this exact endpoint with valid auth
// and got back a clean 404 model_not_found, closing the session with
// FAILED_TO_THINK. openai/gpt-oss-120b is Groq's current production model
// with confirmed native tool-calling via the standard OpenAI `tools` format,
// which is what this file's function-call relay depends on.
const GROQ_THINK_MODEL = 'openai/gpt-oss-120b';
// Deepgram's own docs specifically confirm Turbo 2.5 as the supported
// ElevenLabs tier for their real-time agent speak relay ("we support any of
// ElevenLabs' Turbo 2.5 voices to ensure low latency interactions"), and a
// live production report (github.com/orgs/deepgram/discussions/1243) shows
// ElevenLabs v3 does not support the streaming shape this integration needs
// at all. Higher-realism tiers are used for Vapi phone calls instead (see
// tool-registry.ts), where Vapi's own infrastructure handles that streaming
// problem on its side.
const ELEVENLABS_TTS_MODEL = 'eleven_turbo_v2_5';
// The same voice id already confirmed live in production for Vapi calls
// (tool-registry.ts) — reused here by default so Apex sounds like the same
// person everywhere, and overridable via ELEVENLABS_VOICE_ID once a specific
// account voice is connected.
export const DEFAULT_ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
/** Deepgram closes an idle agent session without a periodic nudge. */
const KEEPALIVE_INTERVAL_MS = 5_000;

// ─── Reconnect tuning ───────────────────────────────────────────────────────
//
// Deepgram does not distinguish "recoverable" from "fatal" at the WebSocket
// close level — a network blip and a Groq 429 (FAILED_TO_THINK) both just
// close the whole agent session with a non-1000 code. So every abnormal
// close gets retried up to this budget rather than assuming it is fatal;
// see the 'close' handler in connectToDeepgram() below.
export const RECONNECT_BASE_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 15_000;
export const RECONNECT_MAX_ATTEMPTS = 5;

/**
 * Exponential backoff with full jitter (AWS's recommended formula: uniform
 * over [0, cap], not a fixed fraction of it). A fixed delay retried in
 * lockstep with whatever just caused a 429 tends to land on another 429;
 * jitter spreads retries across the window instead of synchronizing them.
 *
 * `attempt` is 0-indexed (0 = first retry). `random` defaults to Math.random
 * but is injectable so a guard script can assert an exact value instead of
 * only a range.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt));
  return Math.round(random() * cap);
}

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
    // { type: 'context' } messages and update currentPageNote below, so a
    // reconnect's fresh Settings prompt reflects where he actually is, not
    // just where he started.
    const startPage = (() => {
      try {
        return new URL(_req.url ?? '', 'http://apex.local').searchParams.get('page') ?? undefined;
      } catch {
        return undefined;
      }
    })();
    let currentPageNote = startPage
      ? `\n\nDon's current screen: he is looking at the "${startPage}" page.`
      : '';

    // Direct Gemini Live is the preferred browser/admin voice path. Keep the
    // browser websocket open while we attempt setup; if Gemini cannot reach
    // setupComplete (for example an account/project access denial), fall back
    // to the proven Deepgram path below without making the operator redial.
    const geminiKey = process.env.GEMINI_API_KEY;
    const requestedProvider = (process.env.APEX_LIVE_VOICE_PROVIDER || 'gemini').toLowerCase();
    if (geminiKey && requestedProvider !== 'deepgram') {
      const geminiStarted = await tryStartGeminiLiveSession({
        client,
        request: _req,
        ceo,
        apiKey: geminiKey,
        startPage,
      });
      if (geminiStarted) {
        console.log('🎙️  Live voice client connected via Gemini 3.8 Live');
        return;
      }
      console.warn('[live-voice] Gemini Live setup unavailable; falling back to Deepgram');
    }

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
    // Optional: when absent, speak falls back to Deepgram's bundled Aura
    // voice (still functional) rather than breaking live voice entirely over
    // a missing quality enhancement.
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
    const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE_ID;

    console.log('🎙️  Live voice client connected');

    // Durable transcript record (see schema.ts voiceChatSessions/voiceChatTurns).
    // Fire-and-forget: never let a DB hiccup add latency to call setup or
    // silently fail the call itself. Created before Deepgram is even
    // contacted so a call that never connects is still visible in history,
    // not just ones that succeeded — the same lesson already applied to
    // call_outcomes in tool-registry.ts's make_outbound_call.
    const voiceSessionId = randomUUID();
    db.insert(voiceChatSessions)
      .values({ id: voiceSessionId, startPage: startPage ?? null })
      .catch((err) => console.error('[live-voice] failed to persist session start:', err instanceof Error ? err.message : String(err)));
    const persistTurn = (role: 'user' | 'assistant', text: string) => {
      if (!text) return;
      db.insert(voiceChatTurns)
        .values({ id: randomUUID(), sessionId: voiceSessionId, role, text })
        .catch((err) => console.error('[live-voice] failed to persist turn:', err instanceof Error ? err.message : String(err)));
    };

    let agentReady = false;
    let goalCreatedThisSession: { id: string; title: string } | undefined;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    // Deepgram's ConversationText event is a single unified "here's what was
    // said" channel — unlike Gemini's inputTranscription/outputTranscription
    // fields, it does not distinguish real speech from an echo of a text-only
    // InjectUserMessage we sent ourselves. Track exactly what we injected so
    // its echo can be dropped instead of relayed to the client as a caption.
    const pendingContextEchoes = new Set<string>();

    // Reconnect state, shared across every connectToDeepgram() attempt for
    // this one client session.
    let deepgram: WebSocket;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // Set on an explicit hang-up (client closed, or sent {type:'end'}) so a
    // Deepgram close firing around the same time is never mistaken for a
    // drop worth reconnecting.
    let intentionallyClosed = false;
    // The most specific reason the last attempt failed, so a final "gave up"
    // message can be more useful than a generic one if every retry in the
    // budget hits the same wall (e.g. still rate-limited after 15s of retries).
    let lastFailureReason: string | undefined;
    // Latency chain for the current spoken turn. The browser emits a
    // speech_started marker from its local VAD fast path while the raw mic
    // stream continues uninterrupted. Provider VAD and first returned audio
    // are measured from that server receipt so clock domains stay consistent.
    let lastSpeechStartedAt: number | null = null;
    let lastUserTranscriptAt: number | null = null;
    let firstAudioPending = false;

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
    const clearReconnectTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const connectToDeepgram = () => {
      agentReady = false;
      const dg = new WebSocket(DEEPGRAM_AGENT_URL, {
        headers: { Authorization: `Token ${deepgramKey}` },
      });
      deepgram = dg;

      dg.on('open', () => {
        console.log('[live-voice] Deepgram agent connected');
      });

      dg.on('message', async (raw: WebSocket.RawData, isBinary: boolean) => {
        // Audio and JSON control messages share the same stream — isBinary is
        // the only reliable way to tell them apart (Node's ws can deliver text
        // frames as Buffer objects too, so Buffer.isBuffer() alone would
        // misclassify a JSON event as audio and corrupt the stream — same
        // lesson already applied in telnyx-deepgram-agent.ts).
        if (isBinary) {
          if (firstAudioPending && lastSpeechStartedAt !== null) {
            safeSendClient({ type: 'latency', stage: 'first_audio', ms: Date.now() - lastSpeechStartedAt });
            firstAudioPending = false;
          }
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
                    `tool — don't just say you will. For multi-step, long-running, debugging, deployment, research, or ` +
                    `architecture work, create_goal immediately and keep the live conversation responsive instead of ` +
                    `trying to complete the heavy work inside this realtime turn. Acknowledge briefly, dispatch it, and ` +
                    `stay available for another instruction while the swarm works.${currentPageNote}` +
                    `You will receive "[screen context]" updates whenever Don moves to a different Apex page. ` +
                    `Use them to understand what "this" or "that" refers to — NEVER read a screen update aloud, ` +
                    `comment on it, or reply to it.\n\nCurrent live snapshot:\n${snapshot}`,
                  functions: CHAT_TOOLS,
                },
                speak: elevenLabsKey
                  ? {
                      provider: { type: 'eleven_labs', model_id: ELEVENLABS_TTS_MODEL, language_code: 'en' },
                      // endpoint MUST be a sibling of provider, not nested inside
                      // it — nesting it there is a documented, real integration
                      // failure (UNPARSABLE_CLIENT_MESSAGE -> FAILED_TO_SPEAK,
                      // github.com/orgs/deepgram/discussions/1243), the exact
                      // same class of "field one level too shallow" bug already
                      // found and fixed in Vapi's tools placement.
                      endpoint: {
                        url: `https://api.elevenlabs.io/v1/text-to-speech/${elevenLabsVoiceId}/stream`,
                        headers: { 'xi-api-key': elevenLabsKey, 'Content-Type': 'application/json' },
                      },
                    }
                  : { provider: { type: 'deepgram', model: 'aura-2-asteria-en' } },
              },
            });
            break;
          }

          case 'SettingsApplied':
            agentReady = true;
            // A fresh session (first connect or a successful reconnect) means
            // whatever caused the previous drop, if any, is over — a LATER
            // drop should get the full retry budget again, not be penalized
            // by one that already recovered.
            reconnectAttempt = 0;
            lastFailureReason = undefined;
            safeSendClient({ type: 'ready' });
            stopKeepAlive();
            keepAliveTimer = setInterval(() => safeSendDeepgram({ type: 'KeepAlive' }), KEEPALIVE_INTERVAL_MS);
            console.log('[live-voice] Settings applied');
            break;

          // Barge-in: the caller started talking over the agent's own speech.
          case 'UserStartedSpeaking': {
            const now = Date.now();
            if (lastSpeechStartedAt === null) lastSpeechStartedAt = now;
            safeSendClient({ type: 'latency', stage: 'speech_vad', ms: now - lastSpeechStartedAt });
            firstAudioPending = true;
            safeSendClient({ type: 'interrupted' });
            break;
          }

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
            if (text) {
              if (role === 'user') {
                lastUserTranscriptAt = Date.now();
                if (lastSpeechStartedAt !== null) {
                  safeSendClient({
                    type: 'latency',
                    stage: 'transcript_ready',
                    ms: lastUserTranscriptAt - lastSpeechStartedAt,
                  });
                }
              }
              safeSendClient({ type: 'transcript', role, text });
              persistTurn(role, text);
            }
            break;
          }

          case 'FunctionCallRequest': {
            const functions = Array.isArray(event.functions) ? (event.functions as DeepgramFunctionCall[]) : [];
            for (const fc of functions) {
              // Never hold the realtime websocket event handler open on tool
              // execution. Heavy work should normally be converted to
              // create_goal by the voice prompt above; even quick status or
              // approval tools execute detached so mic/audio events remain
              // responsive while the result is being produced.
              void (async () => {
                const dispatchedAt = Date.now();
                safeSendClient({ type: 'toolActivity', name: fc.name });
                if (lastSpeechStartedAt !== null) {
                  safeSendClient({ type: 'latency', stage: 'tool_dispatch', ms: dispatchedAt - lastSpeechStartedAt });
                }
                if (lastUserTranscriptAt !== null) {
                  safeSendClient({
                    type: 'latency',
                    stage: 'command_classification',
                    ms: dispatchedAt - lastUserTranscriptAt,
                  });
                }
                let args: Record<string, unknown> = {};
                let result: Record<string, unknown>;
                try {
                  args = fc.arguments ? JSON.parse(fc.arguments) : {};
                  result = await executeTool({ name: fc.name, args }, ceo);
                } catch (err) {
                  result = { error: err instanceof Error ? err.message : String(err) };
                }
                safeSendClient({ type: 'latency', stage: 'tool_complete', ms: Date.now() - dispatchedAt });
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
              })();
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
            // budget for whichever account groqKey belongs to. Deepgram closes
            // the whole agent session on this error regardless, so the 'close'
            // handler below is what decides whether to retry — this only
            // records the reason. It deliberately does NOT tell the client
            // yet: doing so here would flip the call to an error state before
            // a same-second reconnect even gets a chance to succeed.
            lastFailureReason =
              event.code === 'FAILED_TO_THINK'
                ? "the assistant's AI provider is temporarily rate-limited"
                : 'a voice provider error';
            break;
          }

          default:
            break;
        }
      });

      dg.on('error', (err) => {
        console.error('[live-voice] Deepgram WS error:', err.message);
        lastFailureReason = lastFailureReason ?? 'a voice provider connection error';
        // No safeSendClient here either, for the same reason as the 'Error'
        // case above — 'error' is always followed by 'close', which is the
        // single place that decides retry vs. give up.
      });

      dg.on('close', (code, reason) => {
        stopKeepAlive();
        if (code !== 1000) {
          console.warn(`[live-voice] Deepgram WS closed: ${code} ${reason.toString().slice(0, 200)}`);
        }
        // A newer attempt already replaced this one (defensive — the design
        // only ever has one attempt in flight at a time, but a stale handler
        // firing late should still no-op rather than double-schedule).
        if (dg !== deepgram) return;

        if (intentionallyClosed || code === 1000) {
          if (client.readyState === WebSocket.OPEN) client.close();
          return;
        }
        if (client.readyState !== WebSocket.OPEN) return;

        if (reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
          safeSendClient({
            type: 'error',
            message: lastFailureReason
              ? `Still unable to reach the voice provider (${lastFailureReason}) after several attempts. Please try starting the call again.`
              : 'Voice provider connection error. Please try starting the call again.',
          });
          client.close();
          return;
        }

        const delay = reconnectDelayMs(reconnectAttempt);
        reconnectAttempt += 1;
        console.warn(
          `[live-voice] Deepgram connection dropped (code ${code}); reconnecting in ${delay}ms ` +
            `(attempt ${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS})`,
        );
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (client.readyState === WebSocket.OPEN && !intentionallyClosed) connectToDeepgram();
        }, delay);
      });
    };

    connectToDeepgram();

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
      } else if (msg.type === 'speech_started') {
        // Local browser VAD fast-path marker. Raw microphone audio is already
        // streaming continuously; this only establishes a same-clock baseline
        // for provider VAD / first-audio timing and never interrupts the
        // provider session itself.
        lastSpeechStartedAt = Date.now();
        firstAudioPending = true;
      } else if (msg.type === 'context' && typeof msg.text === 'string' && msg.text.length <= 300) {
        // Don navigated to a different Apex page mid-call. Injected as a
        // silent context note — the system prompt above tells the model
        // never to read it aloud, but Deepgram still echoes the injected
        // text back over the same ConversationText event used for real
        // speech, so pendingContextEchoes (above) is what actually keeps
        // it off the client's visible transcript. Also remembered in
        // currentPageNote so a reconnect's fresh Settings prompt starts
        // from where Don actually is, not just where the call began.
        currentPageNote = `\n\nDon's current screen: ${msg.text}`;
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
      intentionallyClosed = true;
      clearReconnectTimer();
      stopKeepAlive();
      if (deepgram.readyState === WebSocket.OPEN || deepgram.readyState === WebSocket.CONNECTING) {
        deepgram.close();
      }
      db.update(voiceChatSessions)
        .set({ endedAt: new Date() })
        .where(eq(voiceChatSessions.id, voiceSessionId))
        .catch((err) => console.error('[live-voice] failed to persist session end:', err instanceof Error ? err.message : String(err)));
    });

    client.on('error', (err) => {
      console.error('[live-voice] Client WS error:', err.message);
    });
  });

  return wss;
}
