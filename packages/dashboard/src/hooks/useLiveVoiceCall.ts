import { useCallback, useRef, useState } from 'react';

// ─── Live voice call: mic capture -> our backend relay -> Gemini Live ────────
//
// Backend: packages/api-server/src/live-voice.ts (WS at /ws/voice-live).
// This hook owns ONLY the browser-side audio plumbing (capture, resample,
// encode, playback, barge-in) and the small client<->server JSON protocol —
// all the Gemini protocol details and tool execution stay server-side.
//
// Wire format (see live-voice.ts for the authoritative doc):
//   send:    { type: 'audio', data: base64 }  16kHz PCM16
//   send:    { type: 'end' }
//   receive: { type: 'ready' | 'interrupted' }
//   receive: { type: 'audio', data: base64 }  24kHz PCM16
//   receive: { type: 'transcript', role, text }
//   receive: { type: 'goalCreated', id, title }
//   receive: { type: 'approvalResolved', id, action }
//   receive: { type: 'toolActivity', name }
//   receive: { type: 'error', message }

export type LiveVoiceStatus = 'idle' | 'connecting' | 'live' | 'error' | 'ended';

interface LiveVoiceCallbacks {
  onTranscript?: (role: 'user' | 'assistant', text: string) => void;
  onGoalCreated?: (goal: { id: string; title: string }) => void;
  onApprovalResolved?: (id: string, action: string) => void;
  onToolActivity?: (name: string) => void;
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

function downsample(buffer: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (toRate >= fromRate) return buffer;
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

export function useLiveVoiceCall(callbacks: LiveVoiceCallbacks) {
  const [status, setStatus] = useState<LiveVoiceStatus>('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const stopPlayback = useCallback(() => {
    for (const src of scheduledSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // already stopped/ended — fine
      }
    }
    scheduledSourcesRef.current = [];
    if (playbackCtxRef.current) nextPlayTimeRef.current = playbackCtxRef.current.currentTime;
  }, []);

  const playChunk = useCallback((b64: string) => {
    if (!playbackCtxRef.current) {
      playbackCtxRef.current = new AudioContext({ sampleRate: OUTPUT_RATE });
      nextPlayTimeRef.current = playbackCtxRef.current.currentTime;
    }
    const ctx = playbackCtxRef.current;
    const pcm = base64ToInt16(b64);
    const float = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / 0x8000;
    const audioBuffer = ctx.createBuffer(1, float.length, OUTPUT_RATE);
    audioBuffer.copyToChannel(float, 0);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, nextPlayTimeRef.current);
    source.start(startAt);
    nextPlayTimeRef.current = startAt + audioBuffer.duration;
    scheduledSourcesRef.current.push(source);
    source.onended = () => {
      scheduledSourcesRef.current = scheduledSourcesRef.current.filter((s) => s !== source);
    };
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
    if (playbackCtxRef.current) {
      playbackCtxRef.current.close().catch(() => {});
      playbackCtxRef.current = null;
    }
    setStatus((s) => (s === 'error' ? s : 'ended'));
  }, [stopPlayback]);

  const start = useCallback(async () => {
    setStatus('connecting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const token = localStorage.getItem('apex_token');
      const wsProtocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
      const ws = new WebSocket(`${wsProtocol}${window.location.host}/ws/voice-live?token=${token ?? ''}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        const AudioCtx = window.AudioContext;
        const captureCtx = new AudioCtx();
        captureCtxRef.current = captureCtx;
        const source = captureCtx.createMediaStreamSource(stream);
        const processor = captureCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;
        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const input = e.inputBuffer.getChannelData(0);
          const down = downsample(input, captureCtx.sampleRate, INPUT_RATE);
          const pcm16 = floatTo16BitPCM(down);
          ws.send(JSON.stringify({ type: 'audio', data: bufToBase64(pcm16) }));
        };
        source.connect(processor);
        processor.connect(captureCtx.destination);
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
            break;
          case 'audio':
            playChunk(msg.data);
            break;
          case 'interrupted':
            stopPlayback();
            break;
          case 'transcript':
            cbRef.current.onTranscript?.(msg.role, msg.text);
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
      cbRef.current.onError?.(err instanceof Error ? err.message : 'Microphone access failed.');
      setStatus('error');
    }
  }, [playChunk, stopPlayback]);

  return { status, start, stop };
}
