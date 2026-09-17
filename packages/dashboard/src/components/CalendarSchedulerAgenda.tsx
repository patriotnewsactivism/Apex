import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ScheduledJobRow } from '../lib/api.js';
import { CalendarDays, CalendarCheck, Clock3, ListTodo, Phone, RefreshCw } from 'lucide-react';

type ScheduleKind = 'call' | 'appointment' | 'task';
type FilterKind = 'all' | ScheduleKind;

type AgendaItem = {
  job: ScheduledJobRow;
  at: Date;
  kind: ScheduleKind;
  contact: string | null;
  phone: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

async function loadFutureSchedule(): Promise<ScheduledJobRow[]> {
  const token = localStorage.getItem('apex_token');
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  // Calendar needs more than the registry's default 50-row window so an older
  // recurring job with a future nextRunAt cannot disappear merely because many
  // newer jobs were created after it.
  const res = await fetch('/api/jobs?limit=250', { headers });
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem('apex_token');
      window.dispatchEvent(new Event('apex:unauthorized'));
    }
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<ScheduledJobRow[]>;
}

function scheduleTime(job: ScheduledJobRow): Date | null {
  const raw = job.nextRunAt ?? job.scheduledAt;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function payloadString(job: ScheduledJobRow): string {
  try {
    return JSON.stringify(job.payload ?? {}).toLowerCase();
  } catch {
    return '';
  }
}

function classify(job: ScheduledJobRow): ScheduleKind {
  const text = `${job.name} ${job.jobType} ${payloadString(job)}`.toLowerCase();
  if (/(call|dial|phone|telnyx|voice|callback|outbound)/.test(text)) return 'call';
  if (/(appointment|meeting|calendar|interview|demo|consultation|conference)/.test(text)) return 'appointment';
  return 'task';
}

function firstString(payload: Record<string, unknown> | null, keys: string[]): string | null {
  if (!payload) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function itemDetails(job: ScheduledJobRow) {
  return {
    contact: firstString(job.payload, ['contactName', 'leadName', 'customerName', 'prospectName', 'attendeeName', 'name']),
    phone: firstString(job.payload, ['phone', 'phoneNumber', 'contactPhone', 'customerPhone', 'to', 'destination']),
  };
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(date: Date, now: Date): string {
  const delta = Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / DAY_MS);
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function kindMeta(kind: ScheduleKind) {
  if (kind === 'call') return { label: 'CALL', icon: <Phone size={13} />, color: 'var(--color-apex-green)' };
  if (kind === 'appointment') return { label: 'APPT', icon: <CalendarCheck size={13} />, color: 'var(--color-apex-signal)' };
  return { label: 'TASK', icon: <ListTodo size={13} />, color: 'var(--color-apex-muted)' };
}

export function CalendarSchedulerAgenda() {
  const [filter, setFilter] = useState<FilterKind>('all');
  const [clock, setClock] = useState(() => Date.now());
  const { data: jobs = [], isLoading, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['jobs', 'calendar-agenda'],
    queryFn: loadFutureSchedule,
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: 'always',
    staleTime: 0,
  });

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const items = useMemo<AgendaItem[]>(() => jobs
    .filter((job) => job.enabled && !['completed', 'failed', 'cancelled'].includes(job.status))
    .map((job) => {
      const at = scheduleTime(job);
      if (!at || at.getTime() < clock) return null;
      return { job, at, kind: classify(job), ...itemDetails(job) } satisfies AgendaItem;
    })
    .filter((item): item is AgendaItem => Boolean(item))
    .sort((a, b) => a.at.getTime() - b.at.getTime()), [jobs, clock]);

  const filtered = filter === 'all' ? items : items.filter((item) => item.kind === filter);
  const now = new Date(clock);
  const groups = useMemo(() => {
    const byDay = new Map<string, AgendaItem[]>();
    for (const item of filtered) {
      const key = dayKey(item.at);
      const bucket = byDay.get(key) ?? [];
      bucket.push(item);
      byDay.set(key, bucket);
    }
    return [...byDay.entries()].map(([key, dayItems]) => ({ key, date: dayItems[0].at, items: dayItems }));
  }, [filtered]);

  const sevenDays = useMemo(() => {
    const start = startOfDay(now);
    return Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(start.getTime() + offset * DAY_MS);
      return { date, count: items.filter((item) => dayKey(item.at) === dayKey(date)).length };
    });
  }, [items, clock]);

  const counts: Record<FilterKind, number> = {
    all: items.length,
    call: items.filter((item) => item.kind === 'call').length,
    appointment: items.filter((item) => item.kind === 'appointment').length,
    task: items.filter((item) => item.kind === 'task').length,
  };

  return (
    <div>
      <div className="apex-toolbar" style={{ marginBottom: 14, gap: 10, flexWrap: 'wrap' }}>
        <div className="apex-eyebrow">Live future agenda</div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          title="Refresh schedule now"
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderRadius: 5,
            border: '1px solid var(--color-apex-line)', background: 'rgba(255,255,255,0.03)',
            color: 'var(--color-apex-muted)', cursor: isFetching ? 'default' : 'pointer',
            fontFamily: 'var(--font-mono)', fontSize: 9,
          }}
        >
          <RefreshCw size={12} /> {isFetching ? 'SYNCING' : 'LIVE · 10S'}
        </button>
      </div>

      <div className="glass-card" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(72px, 1fr))', gap: 5, padding: 10, overflowX: 'auto', marginBottom: 12 }}>
        {sevenDays.map(({ date, count }) => (
          <div key={dayKey(date)} style={{ textAlign: 'center', padding: '7px 5px' }}>
            <div className="apex-eyebrow" style={{ fontSize: 8 }}>{date.toLocaleDateString(undefined, { weekday: 'short' })}</div>
            <div className="apex-display" style={{ fontSize: 18, color: 'var(--color-apex-text)', marginTop: 2 }}>{date.getDate()}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, marginTop: 3, color: count ? 'var(--color-apex-brass)' : 'var(--color-apex-muted)' }}>
              {count ? `${count} scheduled` : 'clear'}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {([['all', 'All'], ['call', 'Calls'], ['appointment', 'Appointments'], ['task', 'Other']] as Array<[FilterKind, string]>).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            style={{
              padding: '7px 9px', borderRadius: 5, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 9,
              border: `1px solid ${filter === id ? 'var(--color-apex-brass)' : 'var(--color-apex-line)'}`,
              background: filter === id ? 'var(--color-apex-brass-soft)' : 'transparent',
              color: filter === id ? 'var(--color-apex-brass)' : 'var(--color-apex-muted)',
            }}
          >
            {label} {counts[id]}
          </button>
        ))}
      </div>

      <div className="glass-card" style={{ overflow: 'hidden' }}>
        {isLoading ? (
          <div className="apex-eyebrow" style={{ padding: 28 }}>Loading schedule…</div>
        ) : groups.length === 0 ? (
          <div style={{ padding: '42px 18px', textAlign: 'center', color: 'var(--color-apex-muted)' }}>
            <CalendarDays size={32} style={{ margin: '0 auto 10px', opacity: 0.5 }} />
            <div className="apex-display" style={{ fontSize: 14 }}>No future {filter === 'all' ? 'scheduled items' : `${filter}s`}</div>
            <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 9 }}>APEX checks the durable scheduler every 10 seconds.</div>
          </div>
        ) : groups.map((group) => (
          <section key={group.key}>
            <div style={{ padding: '8px 13px', background: 'rgba(255,255,255,0.025)', borderBottom: '1px solid var(--color-apex-line)' }}>
              <span className="apex-eyebrow">{dayLabel(group.date, now)}</span>
            </div>
            {group.items.map((item) => {
              const meta = kindMeta(item.kind);
              return (
                <div key={item.job.id} style={{ display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr)', gap: 11, padding: '12px 13px', borderBottom: '1px solid var(--color-apex-line)' }}>
                  <div>
                    <div className="apex-display" style={{ fontSize: 12, color: 'var(--color-apex-text)' }}>
                      {item.at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 5, color: meta.color, fontFamily: 'var(--font-mono)', fontSize: 8 }}>
                      {meta.icon}{meta.label}
                    </div>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--color-apex-text)', overflowWrap: 'anywhere' }}>{item.job.name}</div>
                    {(item.contact || item.phone) && (
                      <div style={{ marginTop: 4, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)', fontSize: 9, overflowWrap: 'anywhere' }}>
                        {[item.contact, item.phone].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 5, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)', fontSize: 8 }}>
                      <span>{item.job.jobType}</span>
                      {item.job.cronExpression && <span>recurring</span>}
                      <span>{item.job.status}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 8, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)', fontSize: 8 }}>
        <Clock3 size={10} /> Last synced {dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : 'not yet'} · durable APEX scheduler
      </div>
    </div>
  );
}
