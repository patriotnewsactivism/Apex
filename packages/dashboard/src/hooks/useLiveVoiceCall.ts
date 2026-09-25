import { useCallback, useRef, useState } from 'react';
import { api } from '../lib/api.js';

// ─── Live voice call: mic capture -> our backend relay -> Deepgram Voice Agent ──
//
// Backend: packages/api-server/src/live-voice.ts (WS at /ws/voice-live).
// This hook owns ONLY the browser-side audio plumbing (capture, resample,
// encode, playback, barge-in) and the small client<->server JSON protocol —
// all the Deepgram/Groq/ElevenLabs protocol details and tool execution stay
// server-side.
//
// Wire format (see live-voice.ts for the authoritative doc):
//   send:    { type: 'audio', data: base64 }  16kHz PCM16
//   send:    { type: 'end' }
//   receive: { type: 'ready' | 'interrupted' }
//   receive: { type: 'audio', data: base64 }  24kHz PCM16
//   receive: { type: 'transcript', role, text }  (streaming FRAGMENTS — merge, don't split)
//   receive: { type: 'turnComplete' }  (end of one spoken turn — close the bubble)
//   receive: { type: 'goalCreated', id, title }
//   receive: { type: 'approvalResolved', id, action }
//   receive: { type: 'toolActivity', name }
//   receive: { type: 'error', message }

export type LiveVoiceStatus = 'idle' | 'connecting' | 'live' | 'error' | 'ended';

interface LiveVoiceCallbacks {
  onTranscript?: (role: 'user' | 'assistant', text: string) => void;
  onTurnComplete?: () => void;
  onGoalCreated?: (goal: { id: string; title: string }) => void;
  onApprovalResolved?: (id: string, action: string) => void;
  onToolActivity?: (name: string) => void;
  onProvider?: (provider: string, model?: string) => void;
  onLatency?: (sample: { stage: string; ms: number }) => void;
  onError?: (message: string) => void;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function resample(buffer: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (toRate === fromRate) return buffer;
  const ratio = fromRate / toRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const idx = i * ratio;
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, buffer.length - 1);
    const frac = idx - lo;
    result[i] = buffer[lo] * (1 - frac) + buffer[hi] * frac;
  }
  return result;
}

function bufToBase64(buf: Int16Array): string {
  const bytes = new Uint8Array(buf.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

// iOS Safari only exposes webkitAudioContext, and it starts every context in
// the 'suspended' state unless the context is BOTH created and resumed inside
// the synchronous part of a user gesture. Creating it in ws.onopen (an async
// callback) is not a gesture, which is why mobile voice produced no audio.
type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function resumeContext(ctx: AudioContext | null): void {
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});
}

export function useLiveVoiceCall(callbacks: LiveVoiceCallbacks) {
  const [status, setStatus] = useState<LiveVoiceStatus>('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  // Continuous playback ring buffer: incoming 24kHz chunks are resampled to
  // the device rate once and appended; a single long-lived ScriptProcessor
  // node drains it into the speakers. This replaces one AudioBufferSourceNode
  // per chunk — consecutive source nodes click at every chunk boundary
  // (sub-sample scheduling gaps), which sounds like interference/crackle
  // for the whole time the agent is speaking.
  const playQueueRef = useRef<Float32Array[]>([]);
  const playQueueLenRef = useRef(0);
  const playChunkOffsetRef = useRef(0);
  const playProcRef = useRef<ScriptProcessorNode | null>(null);
  const playSilentSrcRef = useRef<AudioBufferSourceNode | null>(null);
  // True while agent audio is queued/playing. This is intentionally NOT used
  // to mute microphone input: Live Talk is full duplex, so the caller must be
  // heard while APEX is speaking. Browser AEC/noise suppression handles echo,
  // and a small local VAD below flushes playback immediately on real barge-in.
  const wasPlayingRef = useRef(false);
  const localSpeechFramesRef = useRef(0);
  const localSpeechActiveRef = useRef(false);
  // When local VAD detects a barge-in, provider interruption confirmation is
  // still one network round-trip away. Drop stale agent packets during that
  // short window so an interrupted sentence cannot refill the playback queue
  // immediately after stopPlayback().
  const suppressAgentAudioRef = useRef(false);
  const suppressAgentAudioTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LOCAL_BARGE_RMS = 0.035;
  const LOCAL_BARGE_FRAMES = 2;
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const stopPlayback = useCallback(() => {
    playQueueRef.current = [];
    playQueueLenRef.current = 0;
    playChunkOffsetRef.current = 0;
    wasPlayingRef.current = false;
  }, []);

  const playChunk = useCallback((b64: string) => {
    if (suppressAgentAudioRef.current) return;
    // The playback context is created inside the user gesture in start(); if it
    // is missing we have nothing to play into (and creating one here would be
    // born suspended on iOS anyway).
    const ctx = playbackCtxRef.current;
    if (!ctx) return;
    resumeContext(ctx);
    const pcm = base64ToInt16(b64);
    const float = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / 0x8000;
    // Resample 24kHz -> device rate once at enqueue time.
    const atDeviceRate = resample(float, OUTPUT_RATE, ctx.sampleRate);
    if (atDeviceRate.length > 0) {
      playQueueRef.current.push(atDeviceRate);
      playQueueLenRef.current += atDeviceRate.length;
      wasPlayingRef.current = true;
    }
  }, []);

  const stop = useCallback(() => {
    try {
      wsRef.current?.send(JSON.stringify({ type: 'end' }));
    } catch {
      // socket may already be closed
    }
    wsRef.current?.close();
    wsRef.current = null;
    processorRef.current?.disconnect();
    processorRef.current = null;
    if (captureCtxRef.current) {
      captureCtxRef.current.close().catch(() => {});
      captureCtxRef.current = null;
    }
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    stopPlayback();
    if (suppressAgentAudioTimerRef.current) {
      clearTimeout(suppressAgentAudioTimerRef.current);
      suppressAgentAudioTimerRef.current = null;
    }
    suppressAgentAudioRef.current = false;
    try {
      playSilentSrcRef.current?.stop();
    } catch {
      // already stopped
    }
    playSilentSrcRef.current = null;
    try {
      playProcRef.current?.disconnect();
    } catch {
      // already disconnected
    }
    playProcRef.current = null;
    playQueueRef.current = [];
    playQueueLenRef.current = 0;
    playChunkOffsetRef.current = 0;
    if (playbackCtxRef.current) {
      playbackCtxRef.current.close().catch(() => {});
      playbackCtxRef.current = null;
    }
    setStatus((s) => (s === 'error' ? s : 'ended'));
  }, [stopPlayback]);

  // Tell the agent what screen Don is looking at mid-call. Relayed server-side
  // into the current persistent realtime voice session as a silent context note.
  const sendContext = useCallback((text: string) => {
    try {
      wsRef.current?.send(JSON.stringify({ type: 'context', text }));
    } catch {
      // socket may be closed — nothing to do
    }
  }, []);

  const start = useCallback(async (startPage?: string) => {
    setStatus('connecting');

    // Everything above the first suspension point still runs inside the click
    // handler, so this is the only place we can legally create + resume audio
    // contexts on mobile Safari.
    const AudioCtx = getAudioContextCtor();
    if (!AudioCtx) {
      cbRef.current.onError?.('This browser does not support Web Audio, so voice calls are unavailable.');
      setStatus('error');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      cbRef.current.onError?.(
        'Microphone access is unavailable. Voice calls need a secure (https) connection.',
      );
      setStatus('error');
      return;
    }

    const captureCtx = new AudioCtx();
    captureCtxRef.current = captureCtx;
    resumeContext(captureCtx);

    // No forced sampleRate: iOS rejects/mismatches a hard 24kHz context. We
    // resample each chunk to the device rate ourselves at enqueue time.
    const playbackCtx = new AudioCtx();
    playbackCtxRef.current = playbackCtx;
    resumeContext(playbackCtx);

    // Continuous playback: ONE ScriptProcessor drains the ring buffer for the
    // whole call. One long-lived node = no per-chunk scheduling boundaries
    // (the periodic clicking that reads as interference during speech).
    const playProc = playbackCtx.createScriptProcessor(1024, 1, 1);
    playProcRef.current = playProc;
    playProc.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0);
      let written = 0;
      while (written < out.length) {
        const queue = playQueueRef.current;
        if (queue.length === 0) break;
        const chunk = queue[0];
        const offset = playChunkOffsetRef.current;
        const need = out.length - written;
        const available = chunk.length - offset;
        if (available <= 0) {
          // fully consumed chunk — drop it
          queue.shift();
          playChunkOffsetRef.current = 0;
          continue;
        }
        const take = Math.min(available, need);
        out.set(chunk.subarray(offset, offset + take), written);
        written += take;
        playQueueLenRef.current -= take;
        playChunkOffsetRef.current = offset + take;
        if (playChunkOffsetRef.current >= chunk.length) {
          queue.shift();
          playChunkOffsetRef.current = 0;
        }
      }
      if (written < out.length) {
        // underrun: silence the rest of this block (network jitter gap)
        out.fill(0, written);
        if (playQueueLenRef.current === 0 && wasPlayingRef.current) {
          wasPlayingRef.current = false;
        }
      }
    };
    playProc.connect(playbackCtx.destination);
    // ScriptProcessor only fires while it has an active input on some
    // browsers (Safari): feed it a looping silent buffer so the graph is
    // alive for the whole call.
    const silentBuf = playbackCtx.createBuffer(1, 1, playbackCtx.sampleRate);
    const silentSrc = playbackCtx.createBufferSource();
    silentSrc.buffer = silentBuf;
    silentSrc.loop = true;
    silentSrc.connect(playProc);
    silentSrc.start();
    playSilentSrcRef.current = silentSrc;

    try {
      // Explicitly request echo cancellation / noise suppression / AGC.
      // `{ audio: true }` is supposed to default these on, but mobile
      // browsers (especially iOS Safari when the track is consumed through
      // WebAudio) are unreliable about it. Full duplex deliberately keeps the
      // mic open, so native AEC/noise suppression is the first echo-defense
      // layer while provider VAD remains authoritative for interruption.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;

      const { ticket } = await api.auth.websocketTicket();
      const wsProtocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
      const pageQs = startPage ? `&page=${encodeURIComponent(startPage)}` : '';
      const ws = new WebSocket(`${wsProtocol}${window.location.host}/ws/voice-live?ticket=${encodeURIComponent(ticket)}${pageQs}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        // Gesture-created contexts can still be auto-suspended between the
        // click and the socket opening; nudge them once more.
        resumeContext(captureCtx);
        resumeContext(playbackCtx);
        const source = captureCtx.createMediaStreamSource(stream);
        // 1024 samples is ~21 ms at 48 kHz (vs ~85 ms at 4096), materially
        // reducing mic-to-provider latency while keeping ScriptProcessor
        // compatibility on Safari. AudioWorklet can replace this later.
        const processor = captureCtx.createScriptProcessor(1024, 1, 1);
        processorRef.current = processor;
        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const input = e.inputBuffer.getChannelData(0);
          const down = resample(input, captureCtx.sampleRate, INPUT_RATE);

          // TRUE FULL DUPLEX: never zero/mute mic frames while APEX is
          // speaking. Continuous input is what lets the upstream realtime
          // voice VAD detect a barge-in and cancel the current response.
          const pcm16 = floatTo16BitPCM(down);
          ws.send(JSON.stringify({ type: 'audio', data: bufToBase64(pcm16) }));

          // Local barge-in fast path. Provider VAD remains authoritative, but
          // waiting for its round trip makes playback feel sticky. While APEX
          // audio is actively queued, detect sustained near-field speech and
          // flush the local playback queue immediately. Browser AEC is enabled
          // above, so the agent's own speaker audio should be heavily removed
          // before this RMS check.
          let energy = 0;
          for (let i = 0; i < down.length; i++) energy += down[i] * down[i];
          const rms = down.length ? Math.sqrt(energy / down.length) : 0;
          if (rms >= LOCAL_BARGE_RMS) {
            localSpeechFramesRef.current += 1;
          } else {
            localSpeechFramesRef.current = 0;
            localSpeechActiveRef.current = false;
          }
          if (!localSpeechActiveRef.current && localSpeechFramesRef.current >= LOCAL_BARGE_FRAMES) {
            localSpeechActiveRef.current = true;
            try {
              // Marks every utterance, not only barge-ins, so the server can
              // measure provider VAD / model / tool / first-audio timing from
              // one stable server-clock baseline.
              ws.send(JSON.stringify({ type: 'speech_started' }));
            } catch {
              // provider-side VAD still receives the continuous audio stream
            }

            if (wasPlayingRef.current) {
              const detectedAt = performance.now();
              suppressAgentAudioRef.current = true;
              if (suppressAgentAudioTimerRef.current) {
                clearTimeout(suppressAgentAudioTimerRef.current);
              }
              // Failsafe: if provider interruption confirmation is lost, do
              // not leave playback muted for the rest of the call.
              suppressAgentAudioTimerRef.current = setTimeout(() => {
                suppressAgentAudioRef.current = false;
                suppressAgentAudioTimerRef.current = null;
              }, 700);
              stopPlayback();
              cbRef.current.onLatency?.({
                stage: 'barge_in_playback_stop',
                ms: Math.max(0, performance.now() - detectedAt),
              });
            }
          }
        };
        source.connect(processor);
        // ScriptProcessorNode needs a downstream connection to keep pumping
        // on all browsers. Never connect that graph to the speaker destination:
        // even a zero-gain speaker sink can wake browser/audio-device feedback
        // processing and produce the long beep that interrupts Gemini audio.
        // A MediaStreamDestination keeps the graph alive without any audible
        // output or acoustic path back into the microphone.
        const silentSink = captureCtx.createGain();
        silentSink.gain.value = 0;
        processor.connect(silentSink);
        silentSink.connect(captureCtx.createMediaStreamDestination());
      };

      ws.onmessage = (event) => {
        let msg: any;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'ready':
            setStatus('live');
            if (typeof msg.provider === 'string') {
              cbRef.current.onProvider?.(
                msg.provider,
                typeof msg.model === 'string' ? msg.model : undefined,
              );
            }
            break;
          case 'audio':
            playChunk(msg.data);
            break;
          case 'interrupted':
            stopPlayback();
            if (suppressAgentAudioTimerRef.current) {
              clearTimeout(suppressAgentAudioTimerRef.current);
            }
            // Keep a tiny grace window for response packets that were already
            // on the wire when Gemini/Deepgram acknowledged the interruption.
            suppressAgentAudioTimerRef.current = setTimeout(() => {
              suppressAgentAudioRef.current = false;
              suppressAgentAudioTimerRef.current = null;
            }, 150);
            break;
          case 'transcript':
            cbRef.current.onTranscript?.(msg.role, msg.text);
            break;
          case 'turnComplete':
            if (suppressAgentAudioTimerRef.current) {
              clearTimeout(suppressAgentAudioTimerRef.current);
              suppressAgentAudioTimerRef.current = null;
            }
            suppressAgentAudioRef.current = false;
            cbRef.current.onTurnComplete?.();
            break;
          case 'goalCreated':
            cbRef.current.onGoalCreated?.({ id: msg.id, title: msg.title });
            break;
          case 'approvalResolved':
            cbRef.current.onApprovalResolved?.(msg.id, msg.action);
            break;
          case 'toolActivity':
            cbRef.current.onToolActivity?.(msg.name);
            break;
          case 'latency':
            if (typeof msg.stage === 'string' && typeof msg.ms === 'number') {
              cbRef.current.onLatency?.({ stage: msg.stage, ms: msg.ms });
            }
            break;
          case 'error':
            cbRef.current.onError?.(msg.message);
            setStatus('error');
            break;
        }
      };

      ws.onerror = () => {
        cbRef.current.onError?.('Voice connection error.');
        setStatus('error');
      };

      ws.onclose = () => {
        setStatus((s) => (s === 'error' ? s : 'ended'));
      };
    } catch (err) {
      captureCtx.close().catch(() => {});
      captureCtxRef.current = null;
      playbackCtx.close().catch(() => {});
      playbackCtxRef.current = null;
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      cbRef.current.onError?.(err instanceof Error ? err.message : 'Microphone access failed.');
      setStatus('error');
    }
  }, [playChunk, stopPlayback]);

  return { status, start, stop, sendContext };
}
