import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type SalesOpsOverview,
  type SalesOpsCallResult,
  type SalesOpsAutomateResult,
  type Lead,
} from '../lib/api.js';
import { PhoneCall, Zap, DollarSign, Mail, Users, AlertTriangle, Rocket } from 'lucide-react';

// ─── Small presentational helpers ──────────────────────────────────────────

function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Metric({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        padding: '14px 16px',
        borderRadius: 8,
        background: 'rgba(0,0,0,0.2)',
        border: '1px solid var(--color-apex-line)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 0,
      }}
    >
      <div className="apex-eyebrow">{label}</div>
      <div
        className="apex-display"
        style={{ fontSize: 22, color: accent ?? 'var(--color-apex-text)', lineHeight: 1.1 }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-apex-muted)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
      <span style={{ color: 'var(--color-apex-brass)', display: 'flex' }}>{icon}</span>
      <div>
        <div className="apex-display" style={{ fontSize: 15, color: 'var(--color-apex-text)' }}>
          {title}
        </div>
        {hint && (
          <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginTop: 1 }}>{hint}</div>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  borderRadius: 6,
  background: 'rgba(0,0,0,0.28)',
  border: '1px solid var(--color-apex-line)',
  color: 'var(--color-apex-text)',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-apex-muted)',
  marginBottom: 5,
  display: 'block',
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '10px 16px',
    borderRadius: 6,
    border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    background: disabled ? 'rgba(184,150,94,0.35)' : 'var(--color-apex-brass)',
    color: '#14120f',
    fontFamily: 'var(--font-sans)',
    fontWeight: 700,
    fontSize: 13,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    transition: 'opacity 0.15s',
    opacity: disabled ? 0.7 : 1,
  };
}

// ─── Running cost + monitoring ──────────────────────────────────────────────

function CostAndMonitoring({ data }: { data: SalesOpsOverview }) {
  const { spend, runningCost, calls, emails, leads, campaigns } = data;
  const capPct = spend.capUsd > 0 ? Math.min(100, (spend.spentUsd / spend.capUsd) * 100) : 0;
  const capColor =
    capPct >= 90 ? 'var(--color-apex-red)' : capPct >= 70 ? 'var(--color-apex-orange)' : 'var(--color-apex-green)';

  const funnelOrder = ['new', 'researched', 'contacted', 'qualified', 'converted', 'rejected'];
  const leadEntries = useMemo(() => {
    const known = funnelOrder
      .filter((k) => data.leads.byStatus[k] !== undefined)
      .map((k) => [k, data.leads.byStatus[k]] as const);
    const extras = Object.entries(data.leads.byStatus).filter(([k]) => !funnelOrder.includes(k));
    return [...known, ...extras];
  }, [data.leads.byStatus]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Headline running cost */}
      <div
        className="glass-card"
        style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <SectionTitle
          icon={<DollarSign size={18} />}
          title="Running cost — today"
          hint={`Live LLM spend plus outbound-call cost. Ledger: ${spend.persistence}. Updated ${new Date(data.generatedAt).toLocaleTimeString()}.`}
        />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 12,
          }}
        >
          <Metric
            label="Combined today"
            value={usd(runningCost.todayUsd)}
            sub="LLM + calls"
            accent="var(--color-apex-brass)"
          />
          <Metric label="LLM spend" value={usd(runningCost.llmSpendTodayUsd)} sub={`projected ${usd(runningCost.projectedLlmUsd)}`} />
          <Metric label="Call spend" value={usd(runningCost.callSpendTodayUsd)} sub={`${calls.completedToday} calls today`} />
          <Metric
            label="Capacity state"
            value={spend.state === 'ok' ? 'Healthy' : spend.state}
            sub={spend.pacingEnabled ? 'pacing on' : 'pacing off'}
            accent={spend.state === 'ok' ? 'var(--color-apex-green)' : 'var(--color-apex-orange)'}
          />
        </div>

        {/* Daily LLM budget bar */}
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--color-apex-muted)',
              marginBottom: 6,
            }}
          >
            <span>Daily LLM budget</span>
            <span>
              {usd(spend.spentUsd)} / {usd(spend.capUsd)} · {usd(spend.remainingUsd)} left
            </span>
          </div>
          <div
            style={{
              height: 8,
              borderRadius: 4,
              background: 'rgba(0,0,0,0.35)',
              overflow: 'hidden',
              border: '1px solid var(--color-apex-line)',
            }}
          >
            <div
              style={{
                width: `${capPct}%`,
                height: '100%',
                background: capColor,
                transition: 'width 0.4s',
              }}
            />
          </div>
        </div>

        {spend.providers.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {spend.providers.map((p) => (
              <span
                key={p.provider}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--color-apex-muted)',
                  padding: '3px 8px',
                  borderRadius: 4,
                  background: 'rgba(0,0,0,0.25)',
                  border: '1px solid var(--color-apex-line)',
                }}
              >
                {p.provider}: {usd(p.spentUsd)}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Outreach + pipeline monitoring */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 16,
        }}
      >
        <div className="glass-card" style={{ padding: 20 }}>
          <SectionTitle icon={<PhoneCall size={18} />} title="Calls" hint="Outbound AI phone calls" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Metric label="Placed today" value={String(calls.placedToday)} sub={`${calls.placedTotal} all-time`} />
            <Metric label="Completed today" value={String(calls.completedToday)} sub={`${calls.completedTotal} all-time`} />
            <Metric label="Checkout links" value={String(calls.checkoutLinksTotal)} sub="all-time" />
            <Metric label="Call spend" value={usd(calls.spendTotalUsd)} sub="all-time" />
          </div>
        </div>

        <div className="glass-card" style={{ padding: 20 }}>
          <SectionTitle icon={<Mail size={18} />} title="Emails" hint="Outbound sales email" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Metric label="Sent today" value={String(emails.sentToday)} sub={`${emails.total} all-time`} />
            <Metric label="Delivered" value={String(emails.byStatus.delivered ?? 0)} />
            <Metric label="Opened" value={String(emails.byStatus.opened ?? 0)} />
            <Metric label="Bounced" value={String(emails.byStatus.bounced ?? 0)} accent="var(--color-apex-orange)" />
          </div>
        </div>

        <div className="glass-card" style={{ padding: 20 }}>
          <SectionTitle icon={<Users size={18} />} title="Pipeline" hint={`${leads.total} researched leads`} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {leadEntries.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>No leads yet.</div>
            )}
            {leadEntries.map(([status, n]) => (
              <div
                key={status}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span style={{ fontSize: 12, color: 'var(--color-apex-muted)', textTransform: 'capitalize' }}>
                  {status}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-apex-text)' }}>
                  {n}
                </span>
              </div>
            ))}
            <div
              style={{
                marginTop: 6,
                paddingTop: 10,
                borderTop: '1px solid var(--color-apex-line)',
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 11,
                color: 'var(--color-apex-muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <span>Running campaigns</span>
              <span>
                {campaigns.leadRunning} lead · {campaigns.emailRunning} email
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Single call launcher ────────────────────────────────────────────────────

function SingleCallLauncher() {
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const place = useMutation({
    mutationFn: () =>
      api.salesOps.placeCall({
        customerNumber: number.trim(),
        customerName: name.trim() || undefined,
        firstMessage: firstMessage.trim() || undefined,
        assistantPrompt: prompt.trim() || undefined,
      }),
    onSuccess: (res: SalesOpsCallResult) => {
      if (res && res.success === false) {
        setResult({ ok: false, text: res.error ?? 'Call was rejected.' });
      } else {
        setResult({ ok: true, text: `Call placed${res?.callId ? ` (id ${res.callId})` : ''}. Dialing now.` });
        setNumber('');
        setName('');
        setFirstMessage('');
        setPrompt('');
      }
    },
    onError: (err: unknown) => {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    },
  });

  const valid = /^\+?[0-9\s()-]{7,20}$/.test(number.trim());

  return (
    <div className="glass-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionTitle
        icon={<PhoneCall size={18} />}
        title="Place a single call"
        hint="Fires immediately through the Sales agent's AI dialer."
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          padding: '9px 11px',
          borderRadius: 6,
          background: 'rgba(214,158,46,0.08)',
          border: '1px solid rgba(214,158,46,0.28)',
        }}
      >
        <AlertTriangle size={15} color="var(--color-apex-orange)" style={{ marginTop: 1, flexShrink: 0 }} />
        <span style={{ fontSize: 11.5, color: 'var(--color-apex-muted)', lineHeight: 1.5 }}>
          This dials right away with no approval step. You are responsible for consent and Do-Not-Call
          compliance for any number you enter here.
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <div>
          <label style={labelStyle}>Destination number (E.164)</label>
          <input
            style={inputStyle}
            placeholder="+18328804970"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
        </div>
        <div>
          <label style={labelStyle}>Contact name (optional)</label>
          <input
            style={inputStyle}
            placeholder="Jane Doe"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>

      <div>
        <label style={labelStyle}>Opening line (optional — a sensible default is used)</label>
        <input
          style={inputStyle}
          placeholder="Hi, is this Jane? I'm Alex from BuildMyBot..."
          value={firstMessage}
          onChange={(e) => setFirstMessage(e.target.value)}
        />
      </div>

      <div>
        <label style={labelStyle}>Assistant instructions (optional)</label>
        <textarea
          style={{ ...inputStyle, minHeight: 72, resize: 'vertical', fontFamily: 'var(--font-sans)' }}
          placeholder="Override the default sales script for this call..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <button
          style={primaryButtonStyle(!valid || place.isPending)}
          disabled={!valid || place.isPending}
          onClick={() => {
            setResult(null);
            place.mutate();
          }}
        >
          <PhoneCall size={15} />
          {place.isPending ? 'Dialing…' : 'Place call now'}
        </button>
        {result && (
          <span
            style={{
              fontSize: 12,
              color: result.ok ? 'var(--color-apex-green)' : 'var(--color-apex-red)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {result.text}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Full automation launcher ────────────────────────────────────────────────

function AutomationLauncher({ overview }: { overview: SalesOpsOverview }) {
  const [targetType, setTargetType] = useState<'pipeline' | 'lead' | 'campaign'>('pipeline');
  const [targetId, setTargetId] = useState('');
  const [autonomy, setAutonomy] = useState(overview.autonomyLevel || 'aggressive');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const qc = useQueryClient();

  const { data: leads } = useQuery({
    queryKey: ['salesops-leads'],
    queryFn: () => api.leads.list({ limit: 100 }),
    enabled: targetType === 'lead',
  });
  const { data: campaigns } = useQuery({
    queryKey: ['salesops-campaigns'],
    queryFn: () => api.campaigns.list(),
    enabled: targetType === 'campaign',
  });

  const launch = useMutation({
    mutationFn: () =>
      api.salesOps.automate({
        autonomyLevel: autonomy,
        target: { type: targetType, id: targetType === 'pipeline' ? undefined : targetId || undefined },
      }),
    onSuccess: (res: SalesOpsAutomateResult) => {
      setResult({ ok: true, text: `${res.message} Goal ${res.goalId}.` });
      qc.invalidateQueries({ queryKey: ['sales-ops-overview'] });
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
    onError: (err: unknown) => {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    },
  });

  const needsId = targetType !== 'pipeline';
  const canLaunch = !launch.isPending && (!needsId || Boolean(targetId));

  const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' };

  return (
    <div className="glass-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionTitle
        icon={<Zap size={18} />}
        title="Designate for full automation"
        hint="Sets workforce autonomy and hands the Sales org a goal to work the target end-to-end."
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <div>
          <label style={labelStyle}>Target</label>
          <select
            style={selectStyle}
            value={targetType}
            onChange={(e) => {
              setTargetType(e.target.value as typeof targetType);
              setTargetId('');
            }}
          >
            <option value="pipeline">Entire qualified pipeline</option>
            <option value="lead">A single lead</option>
            <option value="campaign">A lead campaign (list)</option>
          </select>
        </div>

        <div>
          <label style={labelStyle}>Autonomy level</label>
          <select style={selectStyle} value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
            {overview.autonomyPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {targetType === 'lead' && (
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Lead</label>
            <select style={selectStyle} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">Select a lead…</option>
              {(leads ?? []).map((l: Lead) => (
                <option key={l.id} value={l.id}>
                  {l.companyName}
                  {l.city ? ` — ${l.city}` : ''} ({l.status})
                </option>
              ))}
            </select>
          </div>
        )}

        {targetType === 'campaign' && (
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Campaign</label>
            <select style={selectStyle} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">Select a campaign…</option>
              {(campaigns ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.status})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <button
          style={primaryButtonStyle(!canLaunch)}
          disabled={!canLaunch}
          onClick={() => {
            setResult(null);
            launch.mutate();
          }}
        >
          <Rocket size={15} />
          {launch.isPending ? 'Launching…' : 'Launch automation'}
        </button>
        {result && (
          <span
            style={{
              fontSize: 12,
              color: result.ok ? 'var(--color-apex-green)' : 'var(--color-apex-red)',
              fontFamily: 'var(--font-mono)',
              maxWidth: 420,
            }}
          >
            {result.text}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function SalesOpsPanel() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['sales-ops-overview'],
    queryFn: () => api.salesOps.overview(),
    refetchInterval: 8000,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 24 }}>
      {isLoading && (
        <div className="glass-card" style={{ padding: 24, color: 'var(--color-apex-muted)', fontSize: 13 }}>
          Loading sales operations…
        </div>
      )}

      {isError && (
        <div
          className="glass-card"
          style={{ padding: 24, color: 'var(--color-apex-red)', fontSize: 13, fontFamily: 'var(--font-mono)' }}
        >
          Failed to load: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {data && <CostAndMonitoring data={data} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
        <SingleCallLauncher />
        {data && <AutomationLauncher overview={data} />}
      </div>
    </div>
  );
}
