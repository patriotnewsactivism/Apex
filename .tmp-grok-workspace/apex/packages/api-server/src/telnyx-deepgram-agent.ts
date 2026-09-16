// ─── Telnyx ↔ Deepgram Voice Agent Bridge ────────────────────────────────────
//
// Corrected implementation against current Deepgram Agent API (2026-09):
//
//   URL:     wss://agent.deepgram.com/v1/agent/converse
//   Handshake sequence:
//     1. Deepgram sends { type: "Welcome" }
//     2. We send { type: "Settings", audio: {...}, agent: {...} }
//     3. Deepgram sends { type: "SettingsApplied" }
//     4. We begin forwarding PCMU audio
//
// Critical bug fixes vs. the original implementation:
//   - Uses isBinary exclusively to determine frame type (not Buffer.isBuffer)
//   - Respects inbound_track (and its variants) but not outbound
//   - Iterates event.functions[] for FunctionCallRequest
//   - Defers irreversible tools (send_checkout_link, transfer_to_owner) with
//     defer_until_eot and honors FunctionCallCancelled
//   - Validates Telnyx start.media_format before forwarding audio
//
// Structured latency diagnostics:
//   VoiceSessionDiagnostics is populated throughout the session and emitted
//   as a single JSON log line on cleanup() for Cloud Run / Cloud Logging.

import WebSocket from 'ws';
import {
  executeServerTool,
  getToolDeclarationsForDeepgram,
} from './telnyx-voice-guardrails.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEEPGRAM_AGENT_URL = 'wss://agent.deepgram.com/v1/agent/converse';

/** Drop oldest buffered audio once we exceed this to bound memory per session. */
const MAX_PENDING_AUDIO_BYTES = 64_000;

/**
 * Tools that must not execute until the user's speaking turn is confirmed
 * complete (Deepgram defer_until_eot). Both send real external side effects.
 */
const DEFERRED_TOOL_NAMES = new Set([
  'send_checkout_link',
  'transfer_to_owner',
]);

// ─── Deepgram event types ─────────────────────────────────────────────────────

interface DeepgramFunctionCall {
  id: string;
  name: string;
  arguments?: string;
  /** True when the function must be executed client-side. */
  client_side?: boolean;
  thought_signature?: string;
}

interface DeepgramFunctionCallRequest {
  type: 'FunctionCallRequest';
  /** Deepgram sends an array; each element is one call to dispatch. */
  functions?: DeepgramFunctionCall[];
}

interface DeepgramFunctionCallCancelled {
  type: 'FunctionCallCancelled';
  functions?: Array<{ id: string; name: string }>;
}

// ─── Telnyx event types ───────────────────────────────────────────────────────

interface TelnyxMediaMessage {
  event: 'media';
  media: {
    track?: string;
    payload?: string;
  };
}

interface TelnyxStartMessage {
  event: 'start';
  start?: {
    media_format?: {
      encoding?: string;
      sample_rate?: number;
      channels?: number;
    };
  };
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

interface VoiceSessionDiagnostics {
  callControlId: string;
  startedAt: number;
  /** Number of inbound Telnyx media frames received. */
  telnyxFramesReceived: number;
  /** Raw PCMU bytes sent to Deepgram. */
  deepgramAudioBytesSent: number;
  /** Raw PCMU bytes received from Deepgram (binary frames). */
  deepgramAudioBytesReceived: number;
  /** Base64-decoded bytes forwarded from Deepgram back to Telnyx. */
  telnyxAudioBytesSent: number;
  /** ms from first Telnyx audio frame to SettingsApplied (buffer flush latency). */
  bufferFlushMs: number | null;
  /** ms from SettingsApplied to first binary frame from Deepgram (TTFA). */
  firstAudioFromDeepgramMs: number | null;
  /** Number of UserStartedSpeaking (barge-in) events. */
  bargeInCount: number;
  /** Total FunctionCallRequest functions dispatched. */
  functionCallsAttempted: number;
  /** Total calls suppressed by FunctionCallCancelled. */
  functionCallsCancelled: number;
  /** Session wall-clock duration in ms; set on cleanup(). */
  durationMs: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as Uint8Array);
}

function parseJsonArguments(value?: string): Record<string, unknown> {
  if (!value) return {};

  const parsed: unknown = JSON.parse(value);

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error('Function arguments must be a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

// ─── DeepgramVoiceSession ─────────────────────────────────────────────────────

export class DeepgramVoiceSession {
  private readonly telnyxWs: WebSocket;
  private readonly callControlId: string;
  private readonly callerNumber: string | undefined;

  private dgWs: WebSocket | null = null;
  private deepgramReady = false;
  private settingsSent = false;
  private cleaningUp = false;

  private readonly pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;

  private readonly cancelledFunctionCalls = new Set<string>();

  private readonly diag: VoiceSessionDiagnostics;
  /** Timestamp of the first Telnyx audio frame (for bufferFlushMs). */
  private firstTelnyxFrameAt: number | null = null;
  /** Timestamp of SettingsApplied (for firstAudioFromDeepgramMs). */
  private settingsAppliedAt: number | null = null;

  public constructor(
    telnyxWs: WebSocket,
    callControlId: string,
    callerNumber?: string,
  ) {
    this.telnyxWs = telnyxWs;
    this.callControlId = callControlId;
    this.callerNumber = callerNumber;

    this.diag = {
      callControlId,
      startedAt: Date.now(),
      telnyxFramesReceived: 0,
      deepgramAudioBytesSent: 0,
      deepgramAudioBytesReceived: 0,
      telnyxAudioBytesSent: 0,
      bufferFlushMs: null,
      firstAudioFromDeepgramMs: null,
      bargeInCount: 0,
      functionCallsAttempted: 0,
      functionCallsCancelled: 0,
      durationMs: null,
    };
  }

  public async start(): Promise<void> {
    const apiKey = process.env.DEEPGRAM_API_KEY;

    if (!apiKey) {
      console.error('[Deepgram Agent] DEEPGRAM_API_KEY is missing.');
      this.closeTelnyx(1011, 'Voice service unavailable');
      return;
    }

    this.setupTelnyx();

    this.dgWs = new WebSocket(DEEPGRAM_AGENT_URL, {
      headers: {
        Authorization: `Token ${apiKey}`,
      },
    });

    this.setupDeepgram();
  }

  // ─── Deepgram WebSocket ────────────────────────────────────────────────────

  private setupDeepgram(): void {
    const socket = this.dgWs;
    if (!socket) return;

    socket.on('open', () => {
      console.info(
        `[Deepgram Agent] Connected for ${this.callControlId}`,
      );
    });

    socket.on(
      'message',
      (data: WebSocket.RawData, isBinary: boolean): void => {
        // isBinary is the ONLY reliable way to distinguish audio frames from
        // JSON control messages. Node's ws can deliver text frames as Buffer
        // objects, so Buffer.isBuffer(data) would misclassify JSON events
        // (e.g. UserStartedSpeaking) as audio and corrupt the stream.
        if (isBinary) {
          this.forwardDeepgramAudioToTelnyx(rawDataToBuffer(data));
          return;
        }

        this.handleDeepgramControlMessage(
          rawDataToBuffer(data).toString('utf8'),
        );
      },
    );

    socket.on('error', (error) => {
      console.error('[Deepgram Agent] WebSocket error:', error);
      this.cleanup();
    });

    socket.on('close', (code, reason) => {
      console.info(
        `[Deepgram Agent] Closed: ${code} ${reason.toString()}`,
      );
      this.cleanup();
    });
  }

  private handleDeepgramControlMessage(raw: string): void {
    let event: Record<string, unknown>;

    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      console.error(
        '[Deepgram Agent] Invalid control message:',
        error,
      );
      return;
    }

    switch (event.type) {
      case 'Welcome':
        this.sendDeepgramSettings();
        break;

      case 'SettingsApplied':
        this.settingsAppliedAt = Date.now();
        if (this.firstTelnyxFrameAt !== null) {
          this.diag.bufferFlushMs =
            this.settingsAppliedAt - this.firstTelnyxFrameAt;
        }
        this.deepgramReady = true;
        this.flushPendingAudio();
        console.info(
          `[Deepgram Agent] Settings applied for ${this.callControlId}`,
        );
        break;

      case 'UserStartedSpeaking':
        this.diag.bargeInCount++;
        this.clearTelnyxPlayback();
        break;

      case 'FunctionCallRequest':
        void this.handleFunctionCalls(
          event as unknown as DeepgramFunctionCallRequest,
        );
        break;

      case 'FunctionCallCancelled':
        this.handleFunctionCallCancelled(
          event as unknown as DeepgramFunctionCallCancelled,
        );
        break;

      case 'ConversationText':
        console.info('[Deepgram Agent] Conversation:', event);
        break;

      case 'Warning':
        console.warn('[Deepgram Agent] Warning:', event);
        break;

      case 'Error':
        console.error('[Deepgram Agent] Fatal error:', event);
        this.cleanup();
        break;

      default:
        break;
    }
  }

  private sendDeepgramSettings(): void {
    if (
      this.settingsSent ||
      this.dgWs?.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    this.settingsSent = true;

    const functions = getToolDeclarationsForDeepgram().map((tool) => {
      if (!DEFERRED_TOOL_NAMES.has(tool.name)) {
        return tool;
      }
      // Irreversible side-effect tools must wait until the user's turn
      // is confirmed complete. This also makes FunctionCallCancelled
      // meaningful — Deepgram can retract speculative calls before they
      // execute.
      return { ...tool, defer_until_eot: true };
    });

    this.dgWs.send(
      JSON.stringify({
        type: 'Settings',
        audio: {
          input: {
            encoding: 'mulaw',
            sample_rate: 8000,
          },
          output: {
            encoding: 'mulaw',
            sample_rate: 8000,
            container: 'none',
          },
        },
        agent: {
          listen: {
            provider: {
              type: 'deepgram',
              version: 'v2',
              model: 'nova-3-general',
            },
          },
          think: {
            provider: {
              type: 'open_ai',
              model: 'gpt-4o-mini',
            },
            prompt: [
              'You are the receptionist for BuildMyBot, an AI-powered chatbot platform for small businesses.',
              'Your job is to answer questions about our plans and pricing, help callers sign up, and transfer to the owner when needed.',
              'Be concise, warm, and professional — this is a phone call, so keep responses to one or two sentences.',
              'Never invent prices; always call quote_discounted_plan to get current figures.',
              'When a caller is ready to subscribe, ask for their email, then call send_checkout_link.',
              "If the caller asks to speak with a human or the owner, call transfer_to_owner. Always confirm before transferring — say something like 'Let me connect you with the owner right now, is that okay?'",
            ].join(' '),
            functions,
          },
          speak: {
            provider: {
              type: 'deepgram',
              version: 'v1',
              model: 'aura-2-asteria-en',
            },
          },
        },
      }),
    );
  }

  // ─── Telnyx WebSocket ──────────────────────────────────────────────────────

  private setupTelnyx(): void {
    this.telnyxWs.on(
      'message',
      (raw: WebSocket.RawData, isBinary: boolean): void => {
        // Telnyx media-stream frames are always JSON text — binary frames are
        // unexpected and must not be forwarded to Deepgram.
        if (isBinary) {
          console.warn(
            '[Telnyx Media] Unexpected binary WebSocket frame; ignoring.',
          );
          return;
        }

        let message:
          | TelnyxMediaMessage
          | TelnyxStartMessage
          | Record<string, unknown>;

        try {
          message = JSON.parse(
            rawDataToBuffer(raw).toString('utf8'),
          ) as TelnyxMediaMessage | TelnyxStartMessage | Record<string, unknown>;
        } catch (error) {
          console.error('[Telnyx Media] Invalid JSON frame:', error);
          return;
        }

        switch (message.event) {
          case 'start':
            this.validateTelnyxFormat(message as TelnyxStartMessage);
            break;
          case 'media':
            this.handleTelnyxMedia(message as TelnyxMediaMessage);
            break;
          case 'stop':
            this.cleanup();
            break;
          case 'error':
            console.error('[Telnyx Media] Stream error:', message);
            break;
          default:
            break;
        }
      },
    );

    this.telnyxWs.on('error', (error) => {
      console.error('[Telnyx Media] WebSocket error:', error);
      this.cleanup();
    });

    this.telnyxWs.on('close', () => {
      this.cleanup();
    });
  }

  private validateTelnyxFormat(message: TelnyxStartMessage): void {
    const format = message.start?.media_format;

    if (!format) {
      // Telnyx may omit media_format when stream_codec is set explicitly;
      // treat the absence as acceptable.
      return;
    }

    const encoding = format.encoding?.toUpperCase();
    const sampleRate = format.sample_rate;

    if (encoding !== 'PCMU' || sampleRate !== 8000) {
      console.error(
        '[Telnyx Media] Unexpected audio format — expected PCMU/8000, got:',
        format,
      );
      this.cleanup();
      return;
    }

    console.info(
      `[Telnyx Media] PCMU/8000 confirmed for ${this.callControlId}`,
    );
  }

  private handleTelnyxMedia(message: TelnyxMediaMessage): void {
    const { track, payload } = message.media;

    if (!payload) return;

    // Accept inbound caller audio only. Telnyx uses 'inbound' or 'inbound_track'.
    // The 'outbound' track is audio we sent back; forwarding it to Deepgram
    // would create an echo loop.
    if (track && track !== 'inbound' && track !== 'inbound_track') {
      return;
    }

    let audio: Buffer;

    try {
      audio = Buffer.from(payload, 'base64');
    } catch (error) {
      console.error('[Telnyx Media] Invalid base64 payload:', error);
      return;
    }

    this.diag.telnyxFramesReceived++;

    if (this.firstTelnyxFrameAt === null) {
      this.firstTelnyxFrameAt = Date.now();
    }

    if (!this.deepgramReady) {
      this.queuePendingAudio(audio);
      return;
    }

    this.sendAudioToDeepgram(audio);
  }

  private queuePendingAudio(audio: Buffer): void {
    this.pendingAudio.push(audio);
    this.pendingAudioBytes += audio.length;

    // Evict oldest frames when the buffer ceiling is exceeded.
    while (
      this.pendingAudioBytes > MAX_PENDING_AUDIO_BYTES &&
      this.pendingAudio.length > 1
    ) {
      const removed = this.pendingAudio.shift();
      if (removed) {
        this.pendingAudioBytes -= removed.length;
      }
    }
  }

  private flushPendingAudio(): void {
    while (this.pendingAudio.length > 0) {
      const audio = this.pendingAudio.shift();
      if (!audio) continue;
      this.pendingAudioBytes -= audio.length;
      this.sendAudioToDeepgram(audio);
    }
    this.pendingAudioBytes = 0;
  }

  private sendAudioToDeepgram(audio: Buffer): void {
    if (
      !this.deepgramReady ||
      this.dgWs?.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    this.diag.deepgramAudioBytesSent += audio.length;
    this.dgWs.send(audio);
  }

  private forwardDeepgramAudioToTelnyx(audio: Buffer): void {
    if (this.telnyxWs.readyState !== WebSocket.OPEN) return;

    // Record TTFA on the first binary frame after SettingsApplied.
    if (
      this.diag.firstAudioFromDeepgramMs === null &&
      this.settingsAppliedAt !== null
    ) {
      this.diag.firstAudioFromDeepgramMs =
        Date.now() - this.settingsAppliedAt;
    }

    this.diag.deepgramAudioBytesReceived += audio.length;
    this.diag.telnyxAudioBytesSent += audio.length;

    this.telnyxWs.send(
      JSON.stringify({
        event: 'media',
        media: {
          payload: audio.toString('base64'),
        },
      }),
    );
  }

  private clearTelnyxPlayback(): void {
    if (this.telnyxWs.readyState !== WebSocket.OPEN) return;

    this.telnyxWs.send(JSON.stringify({ event: 'clear' }));
  }

  // ─── Function call handling ────────────────────────────────────────────────

  private async handleFunctionCalls(
    event: DeepgramFunctionCallRequest,
  ): Promise<void> {
    const functions = event.functions ?? [];

    for (const functionCall of functions) {
      // client_side === true means Deepgram wants the browser/client to handle
      // it — skip server execution. The absence of the field (or false) means
      // server-side execution is expected.
      if (functionCall.client_side === true) {
        continue;
      }

      this.diag.functionCallsAttempted++;

      try {
        const args = parseJsonArguments(functionCall.arguments);

        const result = await executeServerTool(
          functionCall.name,
          args,
          this.callControlId,
          this.callerNumber,
        );

        // Check cancellation after the await — Deepgram may have sent
        // FunctionCallCancelled while the tool was executing.
        if (this.cancelledFunctionCalls.has(functionCall.id)) {
          this.diag.functionCallsCancelled++;
          console.info(
            `[Deepgram Agent] Function ${functionCall.id} was cancelled; response suppressed.`,
          );
          continue;
        }

        if (this.dgWs?.readyState !== WebSocket.OPEN) continue;

        const response: Record<string, unknown> = {
          type: 'FunctionCallResponse',
          id: functionCall.id,
          name: functionCall.name,
          content: JSON.stringify(result),
        };

        // Echo back the thought_signature when Deepgram included one.
        if (functionCall.thought_signature) {
          response.thought_signature = functionCall.thought_signature;
        }

        this.dgWs.send(JSON.stringify(response));
      } catch (error) {
        console.error(
          `[Deepgram Agent] Function ${functionCall.name} failed:`,
          error,
        );

        if (
          this.cancelledFunctionCalls.has(functionCall.id) ||
          this.dgWs?.readyState !== WebSocket.OPEN
        ) {
          continue;
        }

        this.dgWs.send(
          JSON.stringify({
            type: 'FunctionCallResponse',
            id: functionCall.id,
            name: functionCall.name,
            content: JSON.stringify({
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Tool execution failed.',
            }),
          }),
        );
      }
    }
  }

  private handleFunctionCallCancelled(
    event: DeepgramFunctionCallCancelled,
  ): void {
    for (const functionCall of event.functions ?? []) {
      this.cancelledFunctionCalls.add(functionCall.id);
      console.info(
        `[Deepgram Agent] Function cancelled: ${functionCall.name} (${functionCall.id})`,
      );
    }
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  private closeTelnyx(code: number, reason: string): void {
    if (this.telnyxWs.readyState === WebSocket.OPEN) {
      this.telnyxWs.close(code, reason);
    }
  }

  private emitDiagnostics(): void {
    this.diag.durationMs = Date.now() - this.diag.startedAt;

    console.info(
      '[Voice Diagnostics]',
      JSON.stringify(this.diag),
    );
  }

  private cleanup(): void {
    if (this.cleaningUp) return;
    this.cleaningUp = true;

    this.deepgramReady = false;
    this.pendingAudio.length = 0;
    this.pendingAudioBytes = 0;

    this.emitDiagnostics();

    const deepgramSocket = this.dgWs;
    this.dgWs = null;

    if (
      deepgramSocket &&
      (deepgramSocket.readyState === WebSocket.OPEN ||
        deepgramSocket.readyState === WebSocket.CONNECTING)
    ) {
      try {
        deepgramSocket.close();
      } catch {
        // Ignore shutdown errors.
      }
    }

    if (
      this.telnyxWs.readyState === WebSocket.OPEN ||
      this.telnyxWs.readyState === WebSocket.CONNECTING
    ) {
      try {
        this.telnyxWs.close();
      } catch {
        // Ignore shutdown errors.
      }
    }
  }
}

// ─── Telnyx streaming control ─────────────────────────────────────────────────

/**
 * Answer an inbound Telnyx call and start the bidirectional RTP media stream
 * pointed at our WebSocket endpoint.
 *
 * We use `gcloud run services update`-style semantics: `stream_codec: 'PCMU'`
 * forces the Telnyx → application direction to PCMU regardless of the
 * negotiated call codec, so DeepgramVoiceSession never has to transcode.
 */
export async function answerAndStartStreaming(
  callControlId: string,
  streamUrl: string,
  clientState?: string,
): Promise<void> {
  const apiKey = process.env.TELNYX_API_KEY;

  if (!apiKey) {
    throw new Error('TELNYX_API_KEY is not configured');
  }

  // Answer the call first.
  await callControlAction(callControlId, 'answer', apiKey, {
    client_state: clientState,
  });

  // Start the bidirectional PCMU/8 kHz media stream.
  await callControlAction(callControlId, 'streaming_start', apiKey, {
    stream_url: streamUrl,
    stream_track: 'inbound_track',
    stream_codec: 'PCMU',
    stream_bidirectional_mode: 'rtp',
    stream_bidirectional_codec: 'PCMU',
    stream_bidirectional_sampling_rate: 8000,
    enable_dialogflow: false,
    client_state: clientState,
  });
}

async function callControlAction(
  callControlId: string,
  action: string,
  apiKey: string,
  params?: Record<string, unknown>,
): Promise<void> {
  const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/${action}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(params ?? {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Telnyx ${action} failed (${res.status}): ${body.slice(0, 300)}`,
    );
  }
}
