import { useEffect, useRef, useState } from 'react';
import { Bot, Video } from 'lucide-react';
import { TavusWebinarHost } from './TavusWebinarHost.js';

// Pinned to the version WTPN Studio already ships; loaded on demand so the dashboard bundle is unchanged.
const ANAM_SDK_URL = 'https://esm.sh/@anam-ai/js-sdk@4.29.1';

type HostState = 'loading' | 'ready' | 'error';
type HostProps = { slug: string; onStateChange?: (state: HostState) => void; compact?: boolean };
type AnamClient = { streamToVideoElement: (id: string) => Promise<void>; stopStreaming: () => Promise<void> };

export function AnamWebinarHost({ slug, onStateChange, compact = false }: HostProps) {
  const [state, setState] = useState<HostState>('loading');
  const videoId = useRef(`anam-webinar-host-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let active = true;
    let client: AnamClient | null = null;
    const update = (next: HostState) => {
      if (!active) return;
      setState(next);
      onStateChange?.(next);
    };
    update('loading');
    (async () => {
      const res = await fetch(`/api/webinar/public/${encodeURIComponent(slug)}/avatar-session`, { method: 'POST' });
      if (!res.ok) throw new Error(`avatar session ${res.status}`);
      const { sessionToken } = (await res.json()) as { sessionToken: string };
      const sdk = (await import(/* @vite-ignore */ ANAM_SDK_URL)) as { createClient: (token: string) => AnamClient };
      if (!active) return;
      client = sdk.createClient(sessionToken);
      await client.streamToVideoElement(videoId.current);
      update('ready');
    })().catch(() => update('error'));
    return () => {
      active = false;
      void client?.stopStreaming().catch(() => {});
    };
  }, [slug, onStateChange]);

  return (
    <section
      aria-label="Interactive webinar host"
      style={{ position: 'relative', overflow: 'hidden', borderRadius: compact ? 10 : 14, border: '1px solid rgba(201,166,107,0.22)', background: '#090b0f', minWidth: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: compact ? '9px 11px' : '11px 13px', borderBottom: '1px solid rgba(255,255,255,0.07)', background: 'rgba(13,15,19,0.94)', color: '#f4eee4', fontSize: compact ? 11 : 12, fontWeight: 750 }}>
        <Video size={15} color="#c9a66b" /> Interactive AI webinar host
        <span style={{ marginLeft: 'auto', fontSize: 10, color: state === 'error' ? '#e58b92' : state === 'ready' ? '#78b58c' : '#c9a66b' }}>
          {state === 'error' ? 'Fallback audio' : state === 'ready' ? 'Ready' : 'Loading'}
        </span>
      </div>
      {state === 'error' ? (
        <div style={{ minHeight: compact ? 220 : 320, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center', color: '#9b9da4' }}>
          <div>
            <Bot size={30} color="#c9a66b" style={{ marginBottom: 10 }} />
            <div style={{ color: '#f4eee4', fontWeight: 700 }}>Video host unavailable</div>
            <div style={{ marginTop: 6, fontSize: 12 }}>APEX has switched this room to its audio-host fallback.</div>
          </div>
        </div>
      ) : (
        <video id={videoId.current} autoPlay playsInline style={{ display: 'block', width: '100%', minHeight: compact ? 280 : 420, aspectRatio: compact ? '16 / 10' : '16 / 9', background: '#050609' }} />
      )}
    </section>
  );
}

// Picks the host from the server's AVATAR_PROVIDER (anam unless explicitly set to tavus).
export function WebinarVideoHost(props: HostProps) {
  const [provider, setProvider] = useState<'anam' | 'tavus' | null>(null);
  useEffect(() => {
    let active = true;
    fetch(`/api/webinar/public/${encodeURIComponent(props.slug)}/avatar-provider`)
      .then((res) => (res.ok ? res.json() : { provider: 'anam' }))
      .then((data: { provider?: string }) => { if (active) setProvider(data.provider === 'tavus' ? 'tavus' : 'anam'); })
      .catch(() => { if (active) setProvider('anam'); });
    return () => { active = false; };
  }, [props.slug]);
  if (!provider) return null;
  return provider === 'tavus'
    ? <TavusWebinarHost onStateChange={props.onStateChange} compact={props.compact} />
    : <AnamWebinarHost {...props} />;
}
