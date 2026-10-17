/**
 * CRM phase 3: the reporting dashboard.
 *
 * The contact book, the pipeline and the email automation were all readable one
 * record at a time, but there was no screen that answered "how is the quarter
 * going?". This panel is that screen. It is entirely read-only: every number is
 * derived from tables that already exist, so there is nothing here an agent
 * could not also call.
 *
 * The page is a tab strip over the six reports the API exposes, plus a combined
 * Overview. A single date range drives whichever tab is open, so switching tabs
 * keeps the window. Each tab owns its own query, so one slow or failing report
 * never blanks the others.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, CircleDollarSign, Filter, Gauge, LineChart, Target, Users } from 'lucide-react';
import {
  api,
  type CrmActivityReport,
  type CrmContactGrowthReport,
  type CrmPipelineFunnelReport,
  type CrmReportingOverview,
  type CrmReportingRange,
  type CrmRevenueForecastReport,
  type CrmSourceRow,
  type CrmWinLossReport,
} from '../lib/api.js';

const wrap: CSSProperties = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0, maxWidth: '100%' };
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0 };
const label: CSSProperties = { fontSize: 12, color: 'var(--color-apex-muted)' };
const input: CSSProperties = { flex: '1 1 150px', minWidth: 0, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-apex-line)', background: 'rgba(0,0,0,0.28)', color: 'var(--color-apex-text)' };
const card: CSSProperties = { minWidth: 0, padding: 12, borderRadius: 10, background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.10)' };
const statValue: CSSProperties = { fontSize: 22, fontWeight: 700, lineHeight: 1.15 };

function usd(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function Stat({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return (
    <div style={{ ...card, flex: '1 1 150px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={label}>{title}</span>
      <span style={statValue}>{value}</span>
      {hint && <span style={{ ...label, ...wrap }}>{hint}</span>}
    </div>
  );
}

/** A horizontal bar used by every breakdown so the tables read as charts. */
function Bar({ value, max, tone = 'var(--color-apex-brass)' }: { value: number; max: number; tone?: string }) {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ flex: '1 1 80px', height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.08)', minWidth: 40 }}>
      <div style={{ width: `${width}%`, height: '100%', borderRadius: 4, background: tone }} />
    </div>
  );
}

function Breakdown({ rows }: { rows: Array<{ key: string; value: number; extra?: string }> }) {
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.length === 0 && <span style={label}>No data in this window.</span>}
      {rows.map((r) => (
        <div key={r.key} style={{ ...row, gap: 10 }}>
          <span style={{ ...wrap, flex: '0 0 150px', fontWeight: 600 }}>{r.key}</span>
          <Bar value={r.value} max={max} />
          <span style={{ ...label, flex: '0 0 90px', textAlign: 'right' }}>{r.extra ?? r.value.toLocaleString('en-US')}</span>
        </div>
      ))}
    </div>
  );
}

function FunnelTab({ range }: { range: CrmReportingRange }) {
  const query = useQuery({ queryKey: ['crm-report-funnel', range], queryFn: () => api.crm.reporting.funnel(range) });
  const data: CrmPipelineFunnelReport | undefined = query.data;
  if (query.isLoading) return <span style={label}>Loading funnel…</span>;
  if (query.isError || !data) return <span style={wrap}>Could not load the pipeline funnel.</span>;
  const max = data.stages.reduce((m, s) => Math.max(m, s.reachedCount), 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={row}>
        <Stat title="Open deals" value={data.totals.openCount.toLocaleString('en-US')} />
        <Stat title="Open pipeline" value={usd(data.totals.openUsd)} />
        <Stat title="Weighted pipeline" value={usd(data.totals.weightedUsd)} hint="value × probability" />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.stages.map((stage) => (
          <div key={stage.stageId ?? stage.name} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={row}>
              <span style={{ fontWeight: 700 }}>{stage.name}</span>
              <span style={label}>{stage.dealCount} open · {usd(stage.totalUsd)}</span>
              <span style={{ ...label, marginLeft: 'auto' }}>reached {stage.reachedCount} · conv {pct(stage.conversionFromPrevious)}</span>
            </div>
            <Bar value={stage.reachedCount} max={max} />
          </div>
        ))}
        {data.stages.length === 0 && <span style={label}>No pipeline stages configured.</span>}
      </div>
    </div>
  );
}

function WinLossTab({ range }: { range: CrmReportingRange }) {
  const query = useQuery({ queryKey: ['crm-report-winloss', range], queryFn: () => api.crm.reporting.winLoss(range) });
  const data: CrmWinLossReport | undefined = query.data;
  if (query.isLoading) return <span style={label}>Loading win/loss…</span>;
  if (query.isError || !data) return <span style={wrap}>Could not load win/loss.</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={row}>
        <Stat title="Win rate" value={pct(data.winRate)} hint={`${data.won} won · ${data.lost} lost`} />
        <Stat title="Won value" value={usd(data.wonUsd)} hint={`avg ${usd(data.avgWonUsd)}`} />
        <Stat title="Lost value" value={usd(data.lostUsd)} hint={`avg ${usd(data.avgLostUsd)}`} />
        <Stat title="Avg sales cycle" value={data.avgSalesCycleDays === null ? '—' : `${data.avgSalesCycleDays}d`} />
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ ...card, flex: '1 1 260px' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Why we won</div>
          <Breakdown rows={data.wonReasons.map((r) => ({ key: r.reason, value: r.count }))} />
        </div>
        <div style={{ ...card, flex: '1 1 260px' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Why we lost</div>
          <Breakdown rows={data.lostReasons.map((r) => ({ key: r.reason, value: r.count }))} />
        </div>
      </div>
    </div>
  );
}

function ForecastTab({ range }: { range: CrmReportingRange }) {
  const query = useQuery({ queryKey: ['crm-report-forecast', range], queryFn: () => api.crm.reporting.forecast(range) });
  const data: CrmRevenueForecastReport | undefined = query.data;
  if (query.isLoading) return <span style={label}>Loading forecast…</span>;
  if (query.isError || !data) return <span style={wrap}>Could not load the forecast.</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={row}>
        <Stat title="Committed (≥70%)" value={usd(data.committedUsd)} />
        <Stat title="Likely (≥40%)" value={usd(data.likelyUsd)} />
        <Stat title="Weighted" value={usd(data.weightedUsd)} />
        <Stat title="Best case (open)" value={usd(data.openUsd)} />
        <Stat title="Won to date" value={usd(data.wonToDateUsd)} />
      </div>
      <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontWeight: 700 }}>By expected close month</div>
        <Breakdown rows={data.byMonth.map((m) => ({ key: m.month, value: m.totalUsd, extra: `${m.dealCount} · ${usd(m.totalUsd)}` }))} />
      </div>
    </div>
  );
}

function SourcesTab({ range }: { range: CrmReportingRange }) {
  const query = useQuery({ queryKey: ['crm-report-sources', range], queryFn: () => api.crm.reporting.sources(range) });
  const rows: CrmSourceRow[] = query.data?.sources ?? [];
  if (query.isLoading) return <span style={label}>Loading sources…</span>;
  if (query.isError) return <span style={wrap}>Could not load source attribution.</span>;
  const max = rows.reduce((m, r) => Math.max(m, r.totalUsd), 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.length === 0 && <span style={label}>No deals in this window.</span>}
      {rows.map((r) => (
        <div key={r.source} style={{ ...row, gap: 10 }}>
          <span style={{ ...wrap, flex: '0 0 160px', fontWeight: 600 }}>{r.source}</span>
          <Bar value={r.totalUsd} max={max} />
          <span style={{ ...label, flex: '0 0 220px', textAlign: 'right' }}>
            {r.dealCount} deals · {usd(r.totalUsd)} · won {r.wonCount} ({pct(r.winRate)})
          </span>
        </div>
      ))}
    </div>
  );
}

function ActivityTab({ range }: { range: CrmReportingRange }) {
  const query = useQuery({ queryKey: ['crm-report-activity', range], queryFn: () => api.crm.reporting.activity(range) });
  const data: CrmActivityReport | undefined = query.data;
  if (query.isLoading) return <span style={label}>Loading activity…</span>;
  if (query.isError || !data) return <span style={wrap}>Could not load activity.</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={row}>
        <Stat title="Emails sent" value={data.emails.sent.toLocaleString('en-US')} hint={`${data.emails.delivered} delivered`} />
        <Stat title="Open rate" value={pct(data.emails.openRate)} />
        <Stat title="Click rate" value={pct(data.emails.clickRate)} />
        <Stat title="Bounce rate" value={pct(data.emails.bounceRate)} />
      </div>
      <div style={row}>
        <Stat title="Calls" value={data.calls.total.toLocaleString('en-US')} hint={`${data.calls.connected} connected`} />
        <Stat title="Appointments" value={data.calls.appointmentsBooked.toLocaleString('en-US')} />
        <Stat title="Open tasks" value={data.tasks.open.toLocaleString('en-US')} hint={`${data.tasks.overdue} overdue`} />
        <Stat title="Task completion" value={pct(data.tasks.completionRate)} />
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ ...card, flex: '1 1 260px' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Calls by disposition</div>
          <Breakdown rows={data.calls.byDisposition.map((d) => ({ key: d.disposition, value: d.count }))} />
        </div>
        <div style={{ ...card, flex: '1 1 260px' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Timeline volume</div>
          <Breakdown
            rows={[
              { key: 'outbound', value: data.timeline.outbound },
              { key: 'inbound', value: data.timeline.inbound },
              { key: 'internal', value: data.timeline.internal },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

function ContactsTab({ range }: { range: CrmReportingRange }) {
  const query = useQuery({ queryKey: ['crm-report-contacts', range], queryFn: () => api.crm.reporting.contacts(range) });
  const data: CrmContactGrowthReport | undefined = query.data;
  if (query.isLoading) return <span style={label}>Loading contacts…</span>;
  if (query.isError || !data) return <span style={wrap}>Could not load contact growth.</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={row}>
        <Stat title="Total contacts" value={data.total.toLocaleString('en-US')} />
        <Stat title="New in window" value={data.newInRange.toLocaleString('en-US')} />
        <Stat title="Do-not-contact" value={data.doNotContact.toLocaleString('en-US')} />
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ ...card, flex: '1 1 240px' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>By lifecycle stage</div>
          <Breakdown rows={data.byLifecycle.map((b) => ({ key: b.stage, value: b.count }))} />
        </div>
        <div style={{ ...card, flex: '1 1 240px' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>By status</div>
          <Breakdown rows={data.byStatus.map((b) => ({ key: b.status, value: b.count }))} />
        </div>
        <div style={{ ...card, flex: '1 1 240px' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>New contacts by month</div>
          <Breakdown rows={data.byMonth.map((b) => ({ key: b.month, value: b.count }))} />
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ range }: { range: CrmReportingRange }) {
  const query = useQuery({ queryKey: ['crm-report-overview', range], queryFn: () => api.crm.reporting.overview(range) });
  const data: CrmReportingOverview | undefined = query.data;
  if (query.isLoading) return <span style={label}>Loading overview…</span>;
  if (query.isError || !data) return <span style={wrap}>Could not load the reporting overview.</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={row}>
        <Stat title="Open pipeline" value={usd(data.funnel.totals.openUsd)} hint={`${data.funnel.totals.openCount} deals`} />
        <Stat title="Weighted" value={usd(data.funnel.totals.weightedUsd)} />
        <Stat title="Win rate" value={pct(data.winLoss.winRate)} hint={`${data.winLoss.won} won · ${data.winLoss.lost} lost`} />
        <Stat title="Committed (≥70%)" value={usd(data.forecast.committedUsd)} />
        <Stat title="Contacts" value={data.contacts.total.toLocaleString('en-US')} hint={`${data.contacts.newInRange} new`} />
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ ...card, flex: '1 1 300px' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Pipeline funnel</div>
          <Breakdown rows={data.funnel.stages.map((s) => ({ key: s.name, value: s.reachedCount, extra: `${s.dealCount} open · ${usd(s.totalUsd)}` }))} />
        </div>
        <div style={{ ...card, flex: '1 1 300px' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Source attribution</div>
          <Breakdown rows={data.sources.map((s) => ({ key: s.source, value: s.totalUsd, extra: `${s.dealCount} · ${usd(s.totalUsd)}` }))} />
        </div>
        <div style={{ ...card, flex: '1 1 300px' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Forecast by month</div>
          <Breakdown rows={data.forecast.byMonth.map((m) => ({ key: m.month, value: m.totalUsd, extra: `${m.dealCount} · ${usd(m.totalUsd)}` }))} />
        </div>
      </div>
    </div>
  );
}

type ReportTab = 'overview' | 'funnel' | 'win-loss' | 'forecast' | 'sources' | 'activity' | 'contacts';

const TABS: Array<{ id: ReportTab; label: string; icon: ReactNode }> = [
  { id: 'overview', label: 'Overview', icon: <Gauge size={14} /> },
  { id: 'funnel', label: 'Funnel', icon: <Filter size={14} /> },
  { id: 'win-loss', label: 'Win / Loss', icon: <Target size={14} /> },
  { id: 'forecast', label: 'Forecast', icon: <LineChart size={14} /> },
  { id: 'sources', label: 'Sources', icon: <CircleDollarSign size={14} /> },
  { id: 'activity', label: 'Activity', icon: <Activity size={14} /> },
  { id: 'contacts', label: 'Contacts', icon: <Users size={14} /> },
];

export function CrmReportingPanel() {
  const [tab, setTab] = useState<ReportTab>('overview');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const range: CrmReportingRange = { from: from || null, to: to || null };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, maxWidth: '100%' }}>
      <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        <div style={row}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Reporting</div>
          <span style={label}>Read-only. Every number is derived from the CRM's own records.</span>
        </div>
        <div style={row}>
          <input aria-label="From date" type="date" value={from} onChange={(event) => setFrom(event.target.value)} style={input} />
          <input aria-label="To date" type="date" value={to} onChange={(event) => setTo(event.target.value)} style={input} />
          {(from || to) && (
            <button type="button" className="btn-secondary" style={{ padding: '6px 10px' }} onClick={() => { setFrom(''); setTo(''); }}>
              Clear window
            </button>
          )}
          <span style={label}>{from || to ? `Window: ${from || 'start'} → ${to || 'now'}` : 'All time'}</span>
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', padding: 4, borderRadius: 8, background: 'rgba(0,0,0,0.2)', border: '1px solid var(--color-apex-line)' }}>
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '7px 12px',
                  borderRadius: 6,
                  border: 'none',
                  cursor: 'pointer',
                  background: active ? 'var(--color-apex-brass)' : 'transparent',
                  color: active ? '#14120f' : 'var(--color-apex-muted)',
                }}
              >
                {t.icon}
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="glass-card" style={{ padding: 16, minWidth: 0, maxWidth: '100%' }}>
        {tab === 'overview' && <OverviewTab range={range} />}
        {tab === 'funnel' && <FunnelTab range={range} />}
        {tab === 'win-loss' && <WinLossTab range={range} />}
        {tab === 'forecast' && <ForecastTab range={range} />}
        {tab === 'sources' && <SourcesTab range={range} />}
        {tab === 'activity' && <ActivityTab range={range} />}
        {tab === 'contacts' && <ContactsTab range={range} />}
      </div>
    </div>
  );
}
