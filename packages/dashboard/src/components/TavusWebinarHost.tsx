import { createElement, useEffect, useRef, useState } from 'react';
import { Bot, Video } from 'lucide-react';

const TAVUS_EMBED_SCRIPT = 'https://unpkg.com/@tavus/embed@latest';
const DEFAULT_TAVUS_WEBINAR_DEPLOYMENT_ID = '881da968-6ab0-4eb2-b027-192c35866309';

type HostState = 'loading' | 'ready' | 'error';

type TavusWebinarHostProps = {
  onStateChange?: (state: HostState) => void;
  compact?: boolean;
};

function configuredDeploymentId(): string {
  const configured = String(import.meta.env.VITE_TAVUS_WEBINAR_DEPLOYMENT_ID ?? '').trim();
  return configured || DEFAULT_TAVUS_WEBINAR_DEPLOYMENT_ID;
}

function ensureTavusEmbedLoaded(): Promise<void> {
  if (customElements.get('tavus-embed')) return Promise.resolve();

  const existing = document.querySelector<HTMLScriptElement>('script[data-apex-tavus-embed="true"]');
  if (existing) {
    return new Promise((resolve, reject) => {
      if (customElements.get('tavus-embed')) {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Tavus embed script failed to load')), { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TAVUS_EMBED_SCRIPT;
    script.async = true;
    script.dataset.apexTavusEmbed = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Tavus embed script failed to load'));
    document.head.appendChild(script);
  });
}

export function TavusWebinarHost({ onStateChange, compact = false }: TavusWebinarHostProps) {
  const [state, setState] = useState<HostState>('loading');
  const mounted = useRef(true);
  const deploymentId = configuredDeploymentId();

  useEffect(() => {
    mounted.current = true;
    setState('loading');
    onStateChange?.('loading');

    void ensureTavusEmbedLoaded()
      .then(async () => {
        try {
          await customElements.whenDefined('tavus-embed');
          if (!mounted.current) return;
          setState('ready');
          onStateChange?.('ready');
        } catch {
          if (!mounted.current) return;
          setState('error');
          onStateChange?.('error');
        }
      })
      .catch(() => {
        if (!mounted.current) return;
        setState('error');
        onStateChange?.('error');
      });

    return () => {
      mounted.current = false;
    };
  }, [onStateChange]);

  return (
    <section
      className="tavus-webinar-host"
      aria-label="Interactive webinar host"
      style={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: compact ? 10 : 14,
        border: '1px solid rgba(201,166,107,0.22)',
        background: '#090b0f',
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: compact ? '9px 11px' : '11px 13px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          background: 'rgba(13,15,19,0.94)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Video size={15} color="#c9a66b" />
          <div style={{ minWidth: 0 }}>
            <div style={{ color: '#f4eee4', fontSize: compact ? 11 : 12, fontWeight: 750 }}>
              Interactive AI webinar host
            </div>
            <div style={{ color: '#7f838d', fontSize: 10, marginTop: 1 }}>
              Separate live conversation for each attendee
            </div>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            color: state === 'error' ? '#e58b92' : state === 'ready' ? '#78b58c' : '#c9a66b',
            fontSize: 10,
            whiteSpace: 'nowrap',
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'currentColor',
              boxShadow: state === 'ready' ? '0 0 0 4px rgba(120,181,140,0.10)' : 'none',
            }}
          />
          {state === 'error' ? 'Fallback audio' : state === 'ready' ? 'Ready' : 'Loading'}
        </div>
      </div>

      {state === 'error' ? (
        <div
          style={{
            minHeight: compact ? 220 : 320,
            display: 'grid',
            placeItems: 'center',
            padding: 24,
            textAlign: 'center',
            color: '#9b9da4',
          }}
        >
          <div>
            <Bot size={30} color="#c9a66b" style={{ marginBottom: 10 }} />
            <div style={{ color: '#f4eee4', fontWeight: 700 }}>Video host unavailable</div>
            <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5 }}>
              APEX has switched this room to its audio-host fallback.
            </div>
          </div>
        </div>
      ) : (
        <div
          className="tavus-webinar-host-frame"
          style={{
            width: '100%',
            minHeight: compact ? 280 : 420,
            aspectRatio: compact ? '16 / 10' : '16 / 9',
            background: '#050609',
          }}
        >
          {createElement('tavus-embed', {
            'deployment-id': deploymentId,
            style: {
              display: 'block',
              width: '100%',
              height: '100%',
              minHeight: 'inherit',
            },
          })}
        </div>
      )}
    </section>
  );
}
