import { WebSocket } from 'ws';
import { registerWebSocketRoute } from './websocket-upgrade.js';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import type { ApexCEO } from '@workspace/agents';
import { CHAT_SYSTEM_PROMPT, CHAT_TOOLS, buildLiveSnapshot, executeTool } from './routes/chat.js';
import { randomUUID } from 'crypto';
import { db, voiceChatSessions, voiceChatTurns } from '@workspace/db';
import { eq } from 'drizzle-orm';
import {
  tryStartGeminiLiveSession,
  type GeminiLiveFailoverState,
} from './gemini-live-session.js';
import { isExplicitLiveVoiceHangup } from './live-voice-control.js';
import {
  CARTESIA_API_VERSION,
  CARTESIA_SALES_VOICE_NAME,
  resolveCartesiaSalesVoiceId,
} from '@workspace/core';

// ─── Live voice: Deepgram/Groq + the owned Cartesia Don Matthews voice ─────
//
// Browser/admin Live Talk uses Deepgram for realtime listening/turn handling,
// Groq for thinking/tools, and Cartesia for speech. The TTS voice is resolved
// from the same owned Cartesia clone named "Don Matthews" used by APEX sales.
// This keeps Quick Chat from ever falling back to a generic female voice.
//
// Gemini Live remains an explicit opt-in compatibility path only. It is not
// the default because Gemini's native audio voice cannot use the owned
// Cartesia clone. Telephone voice is separate and continues through Telnyx.
//
// The "think" (LLM) step is an ordered fallback chain; see
// buildLiveVoiceThink() below for the order and the reasons. Groq comes first
// because it is free and its latency suits a live spoken conversation.
//
// The "speak" (TTS) step is Cartesia Sonic using the owned Don Matthews voice
// clone. Deepgram's Voice Agent API supports Cartesia as a third-party speak
// provider, so we keep the existing realtime STT/LLM/tool pipeline while
// forcing the same voice identity used by the canonical Cartesia sales agent.
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

/**
 * The think step as an ordered fallback chain. Deepgram sends each turn to the
 * first entry and moves to the next on an error or timeout. Only when every
 * entry fails does it raise FAILED_TO_THINK, and it closes the session when it
 * does.
 *
 * Groq limits each model separately for the whole organization: 8,000 tokens
 * a minute on the on-demand tier. APEX's workforce sends requests of up to
 * 7,600 tokens to openai/gpt-oss-120b on the same organization (llm-client.ts,
 * through both GROQ_API_KEY and GROQ_API_KEY_2). With 120b as the only think
 * model, a live call lost to background work. On 2026-10-04 every turn came
 * back "Rate limit reached ... Used 7169", and the call dropped every 10 to 20
 * seconds. A second key in the same organization does not help, because the
 * limit belongs to the organization.
 *
 *   1. openai/gpt-oss-20b on Groq. Its budget is separate from 120b's, and
 *      nothing else in APEX uses it. It is the Groq model Deepgram documents.
 *   2. openai/gpt-oss-120b on Groq. Shared with the workforce, still free.
 *   3. gpt-4o-mini managed by Deepgram. Billed through the Deepgram account,
 *      like the phone receptionist's think step (telnyx-deepgram-agent.ts),
 *      and independent of Groq.
 *
 * Every entry carries the full prompt and tools. Deepgram treats each entry as
 * a complete think configuration, so an entry without them would answer with
 * no instructions.
 *
 * (llama-3.3-70b-versatile, the first choice, was retired by Groq: Deepgram
 * got a 404 model_not_found. Both gpt-oss models call tools through the
 * standard OpenAI `tools` format that the function relay below depends on.)
 */
export const LIVE_VOICE_GROQ_THINK_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'] as const;
export const LIVE_VOICE_MANAGED_THINK_MODEL = 'gpt-4o-mini';

export function buildLiveVoiceThink(groqKey: string, prompt: string, functions: unknown[]): Array<Record<string, unknown>> {
  const groq = LIVE_VOICE_GROQ_THINK_MODELS.map((model) => ({
    provider: { type: 'groq', model },
    endpoint: { url: GROQ_ENDPOINT_URL, headers: { Authorization: `Bearer ${groqKey}` } },
    prompt,
    functions,
  }));
  return [...groq, { provider: { type: 'open_ai', model: LIVE_VOICE_MANAGED_THINK_MODEL }, prompt, functions }];
}

/**
 * What a reconnect hands back to Deepgram so the agent does not forget the
 * conversation. Every abnormal close starts a fresh agent session, and before
 * this each one began with no memory of the call. Keeps the most recent turns
 * that fit in maxChars, oldest dropped first, in Deepgram's History format.
 */
export const LIVE_VOICE_HISTORY_MAX_MESSAGES = 12;
export const LIVE_VOICE_HISTORY_MAX_CHARS = 3_000;

export function liveVoiceHistoryContext(
  turns: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): Array<{ type: 'History'; role: 'user' | 'assistant'; content: string }> {
  const kept: Array<{ type: 'History'; role: 'user' | 'assistant'; content: string }> = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && kept.length < LIVE_VOICE_HISTORY_MAX_MESSAGES; i--) {
    const content = turns[i].content.trim();
    if (!content) continue;
    if (chars + content.length > LIVE_VOICE_HISTORY_MAX_CHARS) break;
    chars += content.length;
    kept.unshift({ type: 'History', role: turns[i].role, content });
  }
  return kept;
}

const CARTESIA_LIVE_TTS_MODEL = 'sonic-2';
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
// Keep roughly 8-10 seconds of 16 kHz microphone frames while a provider is
// setting up or reconnecting. Realtime voice should drop stale audio only when
// this bounded safety window is exceeded, never merely because SettingsApplied
// has not arrived yet.
const MAX_DEEPGRAM_BUFFERED_AUDIO_FRAMES = 400;

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
    let geminiStarted = false;
    let pendingGeminiFailover: GeminiLiveFailoverState | null = null;
    let activateDeepgramFallback:
      | ((handoff?: GeminiLiveFailoverState) => void)
      | null = null;

    // Direct Gemini Live is the preferred browser/admin voice path. The
    // browser begins streaming mic frames immediately, so observe and retain
    // those frames while Gemini is still negotiating setup. If Gemini fails,
    // the captured command is handed to Deepgram rather than disappearing in
    // the provider handoff.
    let fallbackSeedAudio: string[] = [];
    let fallbackSeedSpeechStartedAt: number | null = null;
    const captureDuringGeminiSetup = (raw: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      let msg: any;
      try {
        msg = JSON.parse(rawDataToBuffer(raw).toString('utf8'));
      } catch {
        return;
      }
      if (msg.type === 'audio' && typeof msg.data === 'string') {
        fallbackSeedAudio.push(msg.data);
        if (fallbackSeedAudio.length > MAX_DEEPGRAM_BUFFERED_AUDIO_FRAMES) {
          fallbackSeedAudio = fallbackSeedAudio.slice(-MAX_DEEPGRAM_BUFFERED_AUDIO_FRAMES);
        }
      } else if (msg.type === 'speech_started') {
        fallbackSeedSpeechStartedAt = Date.now();
      } else if (msg.type === 'context' && typeof msg.text === 'string' && msg.text.length <= 300) {
        currentPageNote = `\n\nDon's current screen: ${msg.text}`;
      }
    };

    const geminiKey = process.env.GEMINI_API_KEY;
    const requestedProvider = (process.env.APEX_LIVE_VOICE_PROVIDER || 'deepgram').toLowerCase();
    if (geminiKey && requestedProvider === 'gemini') {
      client.on('message', captureDuringGeminiSetup);
      geminiStarted = await tryStartGeminiLiveSession({
        client,
        ceo,
        apiKey: geminiKey,
        startPage,
        onFailover: (state) => {
          pendingGeminiFailover = state;
          activateDeepgramFallback?.(state);
        },
      });
      client.off('message', captureDuringGeminiSetup);

      if (geminiStarted) {
        console.log('🎙️  Live voice client connected via Gemini 3.8 Live');
      } else {
        if (client.readyState !== WebSocket.OPEN) return;
        console.warn('[live-voice] Gemini Live setup unavailable; falling back to Deepgram');
      }
    }

    const deepgramKey = process.env.DEEPGRAM_API_KEY;
    // GROQ_API_KEY_2 is preferred, but it does not buy a separate budget when
    // it belongs to the same Groq organization as GROQ_API_KEY: Groq limits
    // the organization, per model. The workforce uses both keys too. What
    // keeps a live call answering is the per-model fallback chain in
    // buildLiveVoiceThink().
    const groqKey = process.env.GROQ_API_KEY_2 || process.env.GROQ_API_KEY;
    if ((!deepgramKey || !groqKey) && !geminiStarted) {
      const missing = [!deepgramKey && 'DEEPGRAM_API_KEY', !groqKey && 'GROQ_API_KEY_2 or GROQ_API_KEY'].filter(Boolean).join(' and ');
      client.send(JSON.stringify({ type: 'error', message: `${missing} not configured on this deployment.` }));
      client.close(1011, 'Not configured');
      return;
    }
    if ((!deepgramKey || !groqKey) && geminiStarted) {
      console.warn(
        '[live-voice] Gemini is active, but mid-call Deepgram failover is unavailable because fallback credentials are missing',
      );
    }
    const cartesiaKey = process.env.CARTESIA_API_KEY?.trim();
    if (!cartesiaKey && !geminiStarted) {
      client.send(JSON.stringify({
        type: 'error',
        message: 'CARTESIA_API_KEY is not configured; Quick Chat Live refuses to use a generic fallback voice.',
      }));
      client.close(1011, 'Cartesia voice not configured');
      return;
    }

    let cartesiaVoiceId: string | null = null;
    if (cartesiaKey) {
      try {
        cartesiaVoiceId = await resolveCartesiaSalesVoiceId();
      } catch (err) {
        console.error('[live-voice] Don Matthews Cartesia voice resolution failed:', err instanceof Error ? err.message : String(err));
        if (!geminiStarted) {
          client.send(JSON.stringify({
            type: 'error',
            message: `The owned Cartesia voice "${CARTESIA_SALES_VOICE_NAME}" is unavailable; Quick Chat Live will not substitute another voice.`,
          }));
          client.close(1011, 'Cartesia voice unavailable');
          return;
        }
      }
    }

    console.log(`🎙️  Live voice client connected${cartesiaVoiceId ? ` with Cartesia voice ${CARTESIA_SALES_VOICE_NAME}` : ''}`);

    // Deepgram persistence is lazy: when Gemini remains healthy there should
    // not be a second empty voice-history session. A row is created only when
    // the fallback actually activates.
    let voiceSessionId: string | null = null;
    const ensureDeepgramSessionRow = (): string => {
      if (voiceSessionId) return voiceSessionId;
      const id = randomUUID();
      voiceSessionId = id;
      db.insert(voiceChatSessions)
        .values({ id, startPage: startPage ?? null })
        .catch((err) => console.error('[live-voice] failed to persist session start:', err instanceof Error ? err.message : String(err)));
      return id;
    };
    const persistTurn = (role: 'user' | 'assistant', text: string) => {
      if (!text) return;
      db.insert(voiceChatTurns)
        .values({ id: randomUUID(), sessionId: ensureDeepgramSessionRow(), role, text })
        .catch((err) => console.error('[live-voice] failed to persist turn:', err instanceof Error ? err.message : String(err)));
    };

    let deepgramActive = false;
    let agentReady = false;
    let goalCreatedThisSession: { id: string; title: string } | undefined;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    // Deepgram's ConversationText event is a single unified "here's what was
    // said" channel — unlike Gemini's inputTranscription/outputTranscription
    // fields, it does not distinguish real speech from an echo of a text-only
    // InjectUserMessage we sent ourselves. Track exactly what we injected so
    // its echo can be dropped instead of relayed to the client as a caption.
    const pendingContextEchoes = new Set<string>();
    // Spoken turns of this call, restored into a reconnect's Settings so the
    // agent keeps the conversation (liveVoiceHistoryContext).
    const conversationTurns: Array<{ role: 'user' | 'assistant'; content: string }> = [];

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
    let lastSpeechStartedAt: number | null = fallbackSeedSpeechStartedAt;
    let lastUserTranscriptAt: number | null = null;
    let firstAudioPending = fallbackSeedSpeechStartedAt !== null;
    let deepgramBufferedAudio = fallbackSeedAudio.slice(-MAX_DEEPGRAM_BUFFERED_AUDIO_FRAMES);
    let pendingDeepgramContext: string | null = null;

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
      if (!deepgramKey || !groqKey) {
        const missing = [!deepgramKey && 'DEEPGRAM_API_KEY', !groqKey && 'GROQ_API_KEY_2 or GROQ_API_KEY'].filter(Boolean).join(' and ');
        safeSendClient({
          type: 'error',
          message: `Gemini became unavailable and ${missing} is not configured for Deepgram failover.`,
        });
        client.close(1011, 'Fallback not configured');
        return;
      }

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
            const thinkPrompt =
              `${CHAT_SYSTEM_PROMPT}\n\nThis is a LIVE VOICE call, not text chat — Don is talking to you out ` +
              `loud in real time. Speak naturally and conversationally, like a real phone call: shorter turns, ` +
              `no bullet lists, no markdown. If he approves/rejects/acknowledges something, actually call the ` +
              `tool — don't just say you will. For multi-step, long-running, debugging, deployment, research, or ` +
              `architecture work, create_goal immediately and keep the live conversation responsive instead of ` +
              `trying to complete the heavy work inside this realtime turn. Acknowledge briefly, dispatch it, and ` +
              `stay available for another instruction while the swarm works.${currentPageNote}` +
              `You will receive "[screen context]" updates whenever Don moves to a different Apex page. ` +
              `Use them to understand what "this" or "that" refers to — NEVER read a screen update aloud, ` +
              `comment on it, or reply to it.\n\nCurrent live snapshot:\n${snapshot}`;
            // A reconnect is a new agent session. Without this it starts with
            // no memory of what was just said.
            const history = liveVoiceHistoryContext(conversationTurns);
            safeSendDeepgram({
              type: 'Settings',
              audio: {
                input: { encoding: 'linear16', sample_rate: 16000 },
                output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
              },
              agent: {
                language: 'en',
                ...(history.length > 0 ? { context: { messages: history } } : {}),
                listen: { provider: { type: 'deepgram', model: 'nova-3-general' } },
                think: buildLiveVoiceThink(groqKey, thinkPrompt, CHAT_TOOLS),
                speak: {
                  provider: {
                    type: 'cartesia',
                    model_id: CARTESIA_LIVE_TTS_MODEL,
                    voice: { mode: 'id', id: cartesiaVoiceId },
                    language: 'en',
                    speed: 'normal',
                  },
                  endpoint: {
                    url: 'https://api.cartesia.ai/tts/bytes',
                    headers: {
                      'x-api-key': cartesiaKey,
                      'Cartesia-Version': CARTESIA_API_VERSION,
                    },
                  },
                },
              },
            });
            break;
          }

          case 'SettingsApplied':
            agentReady = true;
            // A fresh session (first connect or a successful reconnect) means
            // whatever caused the previous drop is over. Reset this immediately
            // so every later drop gets the full retry budget.
            reconnectAttempt = 0;
            lastFailureReason = undefined;

            // Preserve speech that arrived while Deepgram was negotiating
            // SettingsApplied (or reconnecting). The old implementation simply
            // returned early from the browser handler and lost these frames.
            if (deepgramBufferedAudio.length > 0) {
              const queuedFrames = deepgramBufferedAudio;
              deepgramBufferedAudio = [];
              for (const data of queuedFrames) {
                if (dg.readyState !== WebSocket.OPEN) break;
                dg.send(Buffer.from(data, 'base64'));
              }
            }
            if (pendingDeepgramContext) {
              const contextContent = `[screen context — do not read aloud or comment] ${pendingDeepgramContext}`;
              pendingContextEchoes.add(contextContent);
              safeSendDeepgram({ type: 'InjectUserMessage', content: contextContent });
              pendingDeepgramContext = null;
            }

            safeSendClient({ type: 'ready', provider: 'deepgram-fallback', model: LIVE_VOICE_GROQ_THINK_MODELS[0] });
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
              conversationTurns.push({ role, content: text });
              if (conversationTurns.length > LIVE_VOICE_HISTORY_MAX_MESSAGES * 2) conversationTurns.splice(0, conversationTurns.length - LIVE_VOICE_HISTORY_MAX_MESSAGES);
              if (role === 'user' && isExplicitLiveVoiceHangup(text)) {
                intentionallyClosed = true;
                void (async () => {
                  if (voiceSessionId) {
                    const endingId = voiceSessionId;
                    voiceSessionId = null;
                    try {
                      await db.update(voiceChatSessions)
                        .set({ endedAt: new Date() })
                        .where(eq(voiceChatSessions.id, endingId));
                    } catch (err) {
                      console.error('[live-voice] failed to persist spoken hangup:', err instanceof Error ? err.message : String(err));
                    }
                  }
                  safeSendClient({ type: 'ended', reason: 'spoken_hangup' });
                  client.close(1000, 'spoken hangup');
                })();
                break;
              }
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

          // One line each: Railway splits a multi-line entry, and the 429 that
          // explained the 2026-10-04 drops was on the third line of every one.
          case 'Warning':
            console.warn('[live-voice] Deepgram warning:', JSON.stringify(event));
            break;

          case 'Error': {
            console.error('[live-voice] Deepgram error:', JSON.stringify(event));
            // FAILED_TO_THINK means every think provider in the chain failed
            // for this turn (buildLiveVoiceThink). Deepgram closes the whole
            // agent session on this error regardless, so the 'close'
            // handler below is what decides whether to retry — this only
            // records the reason. It deliberately does NOT tell the client
            // yet: doing so here would flip the call to an error state before
            // a same-second reconnect even gets a chance to succeed.
            lastFailureReason =
              event.code === 'FAILED_TO_THINK'
                ? "every AI provider for the assistant is rate-limited or unavailable"
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

    activateDeepgramFallback = (handoff?: GeminiLiveFailoverState) => {
      if (deepgramActive || client.readyState !== WebSocket.OPEN) return;

      if (!deepgramKey || !groqKey) {
        const missing = [!deepgramKey && 'DEEPGRAM_API_KEY', !groqKey && 'GROQ_API_KEY_2 or GROQ_API_KEY'].filter(Boolean).join(' and ');
        safeSendClient({
          type: 'error',
          message: `Gemini became unavailable and ${missing} is not configured for Deepgram failover.`,
        });
        client.close(1011, 'Fallback not configured');
        return;
      }

      if (handoff) {
        deepgramBufferedAudio = handoff.bufferedAudio.slice(-MAX_DEEPGRAM_BUFFERED_AUDIO_FRAMES);
        lastSpeechStartedAt = handoff.lastSpeechStartedAt;
        firstAudioPending = handoff.lastSpeechStartedAt !== null;
        currentPageNote = handoff.currentPageNote || currentPageNote;
        pendingDeepgramContext = null;
        console.warn('[live-voice] switching active Live Talk call from Gemini to Deepgram:', handoff.reason);
        safeSendClient({ type: 'toolActivity', name: 'switching_voice_provider' });
      }

      deepgramActive = true;
      ensureDeepgramSessionRow();
      connectToDeepgram();
    };

    if (pendingGeminiFailover) {
      activateDeepgramFallback(pendingGeminiFailover);
    } else if (!geminiStarted) {
      activateDeepgramFallback();
    }

    client.on('message', (raw, isBinary) => {
      if (!deepgramActive || isBinary) return;
      let msg: any;
      try {
        msg = JSON.parse(rawDataToBuffer(raw).toString('utf8'));
      } catch {
        return;
      }
      if (msg.type === 'audio' && typeof msg.data === 'string') {
        if (agentReady && deepgram.readyState === WebSocket.OPEN) {
          deepgram.send(Buffer.from(msg.data, 'base64'));
        } else {
          deepgramBufferedAudio.push(msg.data);
          if (deepgramBufferedAudio.length > MAX_DEEPGRAM_BUFFERED_AUDIO_FRAMES) {
            deepgramBufferedAudio = deepgramBufferedAudio.slice(-MAX_DEEPGRAM_BUFFERED_AUDIO_FRAMES);
          }
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
        if (agentReady) {
          const contextContent = `[screen context — do not read aloud or comment] ${msg.text}`;
          pendingContextEchoes.add(contextContent);
          safeSendDeepgram({
            type: 'InjectUserMessage',
            content: contextContent,
          });
        } else {
          pendingDeepgramContext = msg.text;
        }
      } else if (msg.type === 'end') {
        intentionallyClosed = true;
        void (async () => {
          if (voiceSessionId) {
            const endingId = voiceSessionId;
            voiceSessionId = null;
            try {
              await db.update(voiceChatSessions)
                .set({ endedAt: new Date() })
                .where(eq(voiceChatSessions.id, endingId));
            } catch (err) {
              console.error('[live-voice] failed to persist operator hangup:', err instanceof Error ? err.message : String(err));
            }
          }
          safeSendClient({ type: 'ended', reason: 'operator_hangup' });
          client.close(1000, 'operator hangup');
        })();
      }
    });

    client.on('close', () => {
      if (!deepgramActive) return;
      intentionallyClosed = true;
      console.log('🎙️  Live voice client disconnected');
      clearReconnectTimer();
      stopKeepAlive();
      if (deepgram.readyState === WebSocket.OPEN || deepgram.readyState === WebSocket.CONNECTING) {
        deepgram.close();
      }
      if (voiceSessionId) {
        db.update(voiceChatSessions)
          .set({ endedAt: new Date() })
          .where(eq(voiceChatSessions.id, voiceSessionId))
          .catch((err) => console.error('[live-voice] failed to persist session end:', err instanceof Error ? err.message : String(err)));
      }
    });

    client.on('error', (err) => {
      console.error('[live-voice] Client WS error:', err.message);
    });
  });

  return wss;
}
