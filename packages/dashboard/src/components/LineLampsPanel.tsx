import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type PhoneLineStatus } from '../lib/api.js';
import { Phone } from 'lucide-react';

// One lamp per owned phone line, plus a main lamp that lights when ANY line is
// on a call. State comes from the API's line_calls records (opened at dial /
// call start, closed at hangup), polled every few seconds. A dark lamp means
// "no call seen", never "unknown": the server sweeps stale records itself.

const LAMP_ON = '#f5a623'; // amber
const LAMP_OFF = 'rgba(255,255,255,0.10)';
const GLOW_KEYFRAMES = `
@keyframes apexLampPulse {
  0%, 100% { box-shadow: 0 0 6px 1px rgba(245,166,35,0.55), 0 0 16px 4px rgba(245,166,35,0.25); }
  50%      { box-shadow: 0 0 12px 3px rgba(245,166,35,0.85), 0 0 30px 10px rgba(245,166,35,0.40); }
}
@media (prefers-reduced-motion: reduce) {
  .apex-lamp-on { animation: none !important; }
}
`;

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatNumber(n: string | null): string {
  if (!n) return 'unknown';
  const d = n.replace(/^\+1/, '').replace(/\D/g, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n;
}

function Lamp({ on, size }: { on: boolean; size: number }) {
  return (
    <span
      className={on ? 'apex-lamp-on' : undefined}
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        background: on
          ? `radial-gradient(circle at 35% 30%, #ffd98a 0%, ${LAMP_ON} 55%, #b9740f 100%)`
          : LAMP_OFF,
        border: on ? '1px solid rgba(255,214,140,0.6)' : '1px solid rgba(255,255,255,0.14)',
        animation: on ? 'apexLampPulse 1.6s ease-in-out infinite' : 'none',
        transition: 'background 0.25s ease',
      }}
    />
  );
}

function LineCard({ line, tick }: { line: PhoneLineStatus; tick: number }) {
  const current = line.current;
  // Count the timer up locally between polls so it reads smoothly.
  const seconds = current ? current.seconds + tick : 0;
  return (
    <div
      className="glass-card"
      style={{
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        borderColor: line.busy ? 'rgba(245,166,35,0.45)' : undefined,
        minWidth: 0,
      }}
    >
      <Lamp on={line.busy} size={18} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-apex-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {line.label}
        </div>
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-apex-muted)' }}>
          {formatNumber(line.number)}
        </div>
        {current ? (
          <div style={{ fontSize: 11, marginTop: 4, color: LAMP_ON }}>
            {current.direction === 'outbound' ? 'Calling ' : 'Call from '}
            {current.remoteName || formatNumber(current.remoteNumber)} &middot;{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>{formatDuration(seconds)}</span>
          </div>
        ) : (
          <div style={{ fontSize: 11, marginTop: 4, color: 'var(--color-apex-muted)' }}>Idle</div>
        )}
      </div>
    </div>
  );
}

export function LineLampsPanel() {
  const { data, isError, error } = useQuery({
    queryKey: ['phone-lines'],
    queryFn: () => api.salesOps.lines(),
    refetchInterval: 4000,
  });

  // Seconds elapsed since the last successful poll, so durations tick live.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick(0);
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [data?.checkedAt]);

  const anyBusy = data?.anyBusy ?? false;
  const busyCount = data?.busyCount ?? 0;

  return (
    <div className="glass-card" style={{ padding: 16 }}>
      <style>{GLOW_KEYFRAMES}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
        <Lamp on={anyBusy} size={34} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600, color: 'var(--color-apex-text)' }}>
            <Phone size={14} />
            Phone lines
          </div>
          <div style={{ fontSize: 12, color: anyBusy ? LAMP_ON : 'var(--color-apex-muted)' }}>
            {!data
              ? isError
                ? `Can't read line status: ${error instanceof Error ? error.message : 'error'}`
                : 'Checking lines...'
              : anyBusy
                ? `${busyCount} line${busyCount === 1 ? '' : 's'} on a call`
                : 'All lines free'}
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gap: 10,
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 230px), 1fr))',
        }}
      >
        {data?.lines.map((line) => <LineCard key={line.number} line={line} tick={tick} />)}
      </div>

      {data && data.unlisted.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 11, color: LAMP_ON }}>
          Call active on an unlisted number: {data.unlisted.map((u) => formatNumber(u.number)).join(', ')}
        </div>
      )}
    </div>
  );
}
