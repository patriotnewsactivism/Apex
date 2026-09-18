import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  CircleDollarSign,
  Database,
  Flame,
  Gauge,
  RefreshCw,
  TrendingUp,
} from 'lucide-react';
import { api } from '../lib/api.js';

function money(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: Math.max(digits, 4),
  });
}

function pct(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.max(0, value).toFixed(value >= 10 ? 0 : 1)}%`;
}

function stateLabel(state: string): string {
  if (state === 'daily_cap') return 'DAILY CAP';
  if (state === 'paced') return 'PACING';
  if (state === 'disabled') return 'PAID OFF';
  return 'AVAILABLE';
}

function MetricCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
}) {
  return (
    <div className="glass-card" style={{ padding: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div className="apex-eyebrow">{label}</div>
        <div style={{ color: 'var(--color-apex-brass)', opacity: 0.9 }}>{icon}</div>
      </div>
      <div
        className="apex-display"
        style={{
          fontSize: 24,
          lineHeight: 1.1,
          marginTop: 9,
          color: 'var(--color-apex-text)',
          overflowWrap: 'anywhere',
        }}
      >
        {value}
      </div>
      <div
        style={{
          marginTop: 7,
          fontFamily: 'var(--font-mono)',
          fontSize: 8,
          lineHeight: 1.45,
          color: 'var(--color-apex-muted)',
        }}
      >
        {detail}
      </div>
    </div>
  );
}

export function SpendBurnPanel() {
  const {
    data,
    isLoading,
    isFetching,
    error,
    refetch,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ['spend', 'live'],
    queryFn: () => api.spend.live(),
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: 'always',
    staleTime: 0,
  });

  if (isLoading && !data) {
    return <div className="glass-card apex-eyebrow" style={{ padding: 28 }}>Loading spend telemetry…</div>;
  }

  if (error || !data) {
    return (
      <div className="glass-card" style={{ padding: 18 }}>
        <div className="apex-display" style={{ fontSize: 14, color: 'var(--color-apex-red)' }}>
          Spend telemetry unavailable
        </div>
        <div style={{ marginTop: 7, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
          {error instanceof Error ? error.message : 'No spend snapshot returned.'}
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          style={{
            marginTop: 12,
            padding: '7px 10px',
            borderRadius: 5,
            border: '1px solid var(--color-apex-line)',
            background: 'rgba(255,255,255,0.03)',
            color: 'var(--color-apex-text)',
            cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  const capPct = Math.min(100, Math.max(0, data.utilizationPct));
  const providerMax = Math.max(0.0001, ...data.providers.map((p) => p.spentUsd));

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div
        className="apex-toolbar"
        style={{ marginBottom: 14, gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="apex-display" style={{ fontSize: 18, color: 'var(--color-apex-text)' }}>
            Spend / Burn Rate
          </div>
          <div className="apex-eyebrow" style={{ marginTop: 4 }}>
            Live tracked APEX inference spend · UTC ledger day
          </div>
        </div>
        <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
          <div
            style={{
              padding: '6px 8px',
              borderRadius: 5,
              border: '1px solid var(--color-apex-line)',
              color: data.state === 'available' ? 'var(--color-apex-green)' : 'var(--color-apex-orange)',
              fontFamily: 'var(--font-mono)',
              fontSize: 8,
            }}
          >
            {stateLabel(data.state)}
          </div>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            title="Refresh spend now"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 10px',
              borderRadius: 5,
              border: '1px solid var(--color-apex-line)',
              background: 'rgba(255,255,255,0.03)',
              color: 'var(--color-apex-muted)',
              cursor: isFetching ? 'default' : 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
            }}
          >
            <RefreshCw size={12} /> {isFetching ? 'SYNCING' : 'LIVE · 5S'}
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))',
          gap: 10,
          marginBottom: 10,
        }}
      >
        <MetricCard
          label="Spent today"
          value={money(data.spentUsd)}
          detail={`${pct(data.utilizationPct)} of ${money(data.capUsd)} daily cap`}
          icon={<CircleDollarSign size={16} />}
        />
        <MetricCard
          label="Burn rate"
          value={data.hourlyBurnUsd == null ? 'Warming up' : `${money(data.hourlyBurnUsd)}/hr`}
          detail="Extrapolated from today's settled spend"
          icon={<Flame size={16} />}
        />
        <MetricCard
          label="Projected today"
          value={money(data.projectedUsd)}
          detail={data.projectedUsd == null ? 'Available after 15 minutes of UTC-day data' : 'At the current spend pace'}
          icon={<TrendingUp size={16} />}
        />
        <MetricCard
          label="30-day run-rate"
          value={money(data.projected30DayUsd)}
          detail="Today's projected daily pace × 30"
          icon={<Activity size={16} />}
        />
        <MetricCard
          label="Remaining"
          value={money(data.remainingUsd)}
          detail={`${money(data.releasedUsd)} released by spend pacing`}
          icon={<Gauge size={16} />}
        />
      </div>

      <div className="glass-card" style={{ padding: 14, marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
          <div>
            <div className="apex-eyebrow">Daily budget utilization</div>
            <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--color-apex-muted)' }}>
              {money(data.spentUsd)} / {money(data.capUsd)}
            </div>
          </div>
          <div className="apex-display" style={{ fontSize: 15, color: capPct >= 90 ? 'var(--color-apex-red)' : 'var(--color-apex-text)' }}>
            {pct(data.utilizationPct)}
          </div>
        </div>
        <div
          style={{
            height: 8,
            borderRadius: 999,
            background: 'rgba(255,255,255,0.06)',
            overflow: 'hidden',
            marginTop: 11,
          }}
        >
          <div
            style={{
              width: `${capPct}%`,
              height: '100%',
              borderRadius: 999,
              background: capPct >= 90 ? 'var(--color-apex-red)' : 'var(--color-apex-brass)',
              transition: 'width 0.3s ease',
            }}
          />
        </div>
      </div>

      <div className="glass-card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '10px 13px', borderBottom: '1px solid var(--color-apex-line)' }}>
          <div className="apex-eyebrow">Spend by provider</div>
        </div>

        {data.providers.length === 0 ? (
          <div style={{ padding: 28, textAlign: 'center', color: 'var(--color-apex-muted)' }}>
            <CircleDollarSign size={28} style={{ margin: '0 auto 8px', opacity: 0.45 }} />
            <div className="apex-display" style={{ fontSize: 13 }}>No paid inference spend recorded today</div>
          </div>
        ) : (
          data.providers.map((provider) => {
            const share = data.spentUsd > 0 ? (provider.spentUsd / data.spentUsd) * 100 : 0;
            const relative = Math.max(2, (provider.spentUsd / providerMax) * 100);
            return (
              <div
                key={provider.provider}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(110px, 0.8fr) minmax(120px, 2fr) auto',
                  gap: 10,
                  alignItems: 'center',
                  padding: '11px 13px',
                  borderBottom: '1px solid var(--color-apex-line)',
                }}
              >
                <div
                  style={{
                    minWidth: 0,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: 'var(--color-apex-text)',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {provider.provider}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.055)', overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${relative}%`,
                        height: '100%',
                        borderRadius: 999,
                        background: 'var(--color-apex-brass)',
                      }}
                    />
                  </div>
                  <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--color-apex-muted)' }}>
                    {share.toFixed(share >= 10 ? 0 : 1)}% of tracked spend
                  </div>
                </div>
                <div className="apex-display" style={{ fontSize: 12, color: 'var(--color-apex-text)' }}>
                  {money(provider.spentUsd, provider.spentUsd < 0.01 ? 4 : 2)}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          flexWrap: 'wrap',
          marginTop: 9,
          color: 'var(--color-apex-muted)',
          fontFamily: 'var(--font-mono)',
          fontSize: 8,
        }}
      >
        <Database size={10} />
        {data.persistence === 'postgres+memory' ? 'Postgres-backed ledger' : 'Memory-only fallback'}
        <span>·</span>
        <span>Ledger day {data.day}</span>
        <span>·</span>
        <span>Last synced {dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : 'not yet'}</span>
      </div>
    </div>
  );
}
