import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ScheduledJobRow } from '../lib/api.js';
import {
  CalendarDays,
  Clock3,
  Phone,
  RefreshCw,
  CalendarCheck,
  ListTodo,
} from 'lucide-react';

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

function scheduleTime(job: ScheduledJobRow): Date | null {
  const raw = job.nextRunAt ?? job.scheduledAt;
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

function payloadText(job: ScheduledJobRow): string {
  try {
    return JSON.stringify(job.payload ?? {}).toLowerCase();
  } catch {
    return '';
  }
}

function classify(job: ScheduledJobRow): ScheduleKind {
  const haystack = `${job.name} ${job.jobType} ${payloadText(job)}`.toLowerCase();
  if (/(call|dial|phone|telnyx|voice|callback|outbound)/.test(haystack)) return 'call';
  if (/(appointment|meeting|calendar|interview|demo|consultation|conference)/.test(haystack)) return 'appointment';
  return 'task';
}

function stringFromPayload(payload: Record<string, unknown> | null, keys: string[]): string | null {
  if (!payload) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function details(job: ScheduledJobRow): Pick<AgendaItem, 'contact' | 'phone'> {
  return {
    contact: stringFromPayload(job.payload, [
      'contactName', 'leadName', 'customerName', 'prospectName', 'attendeeName', 'name',
    ]),
    phone: stringFromPayload(job.payload, [
      'phone', 'phoneNumber', 'contactPhone', 'customerPhone', 'to', 'destination',
    ]),
  };
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(date: Date, now: Date): string {
  const today = startOfDay(now).getTime();
  const target = startOfDay(date).getTime();
  const delta = Math.round((target - today) / DAY_MS);
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function kindMeta(kind: ScheduleKind) {
  if (kind === 'call') return { label: 'Call', icon: <Phone size={14} />, color: 'var(--color-apex-green)' };
  if (kind === 'appointment') return { label: 'Appointment', icon: <CalendarCheck size={14} />, color: 'var(--color-apex-signal)' };
  return { label: 'Task', icon: <ListTodo size={14} />, color: 'var(--color-apex-muted)' };
}

export function CalendarSchedulerPanel() {
  const [filter, setFilter] = useState<FilterKind>('all');
  const [clock, setClock] = useState(() => Date.now());

  const {
    data: jobs = [],
    isLoading,
    isFetching,
    dataUpdatedAt,
    refetch,
  } = useQuery({
    queryKey: ['jobs', 'calendar'],
    queryFn: () => api.jobs.list(),
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  // Recompute "future" as time passes even between network refreshes.
  useMemo(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const items = useMemo<AgendaItem[]>(() => {
    return jobs
      .filter((job) => job.enabled && !['completed', 'failed', 'cancelled'].includes(job.status))
      .map((job) => {
        const at = scheduleTime(job);
        if (!at || at.getTime() < clock) return null;
        const extra = details(job);
        return { job, at, kind: classify(job), ...extra } satisfies AgendaItem;
      })
      .filter((item): item is AgendaItem => Boolean(item))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
  }, [jobs, clock]);

  const filtered = filter === 'all' ? items : items.filter((item) => item.kind === filter);
  const now = new Date(clock);
  const grouped = useMemo(() => {
    const groups = new Map<string, AgendaItem[]>();
    for (const item of filtered) {
      const key = dayKey(item.at);
      const bucket = groups.get(key) ?? [];
      bucket.push(item);
      groups.set(key, bucket);
    }
    return [...groups.entries()].map(([key, group]) => ({ key, items: group, date: group[0].at }));
  }, [filtered]);

  const nextSevenDays = useMemo(() => {
    const start = startOfDay(now);
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start.getTime() + index * DAY_MS);
      const count = items.filter((item) => dayKey(item.at) === dayKey(date)).length;
      return { date, count };
    });
  }, [items, clock]);

  const counts = {
    all: items.length,
    call: items.filter((item) => item.kind === 'call').length,
    appointment: items.filter((item) => item.kind === 'appointment').length,
    task: items.filter((item) => item.kind === 'task').length,
  };

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      <div className="apex-toolbar" style={{ marginBottom: 18, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="apex-display" style={{ fontSize: 18, color: 'var(--color-apex-text)' }}>
            Calendar & Scheduler
          </div>
          <div className="apex-eyebrow" style={{ marginTop: 4 }}>
            Future appointments, calls, reminders and scheduled APEX work
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="glass-card"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 11px',
            color: 'var(--color-apex-muted)',
            border: '1px solid var(--color-apex-line)',
            cursor: isFetching ? 'default' : 'pointer',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
          }}
          title="Refresh schedule now"
        >
          <RefreshCw size={13} style={{ animation: isFetching ? 'spin 1s linear infinite' : 'none' }} />
          {isFetching ? 'SYNCING' : 'LIVE · 10S'}
        </button>
      </div>

      <div
        className="glass-card"
        style={{
          padding: 12,
          marginBottom: 14,
          display: 'grid',
          gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
          gap: 6,
          overflowX: 'auto',
        }}
      >
        {nextSevenDays.map(({ date, count }) => (
          <div key={dayKey(date)} style={{ minWidth: 72, padding: '8px 6px', textAlign: 'center' }}>
            <div className="apex-eyebrow" style={{ fontSize: 9 }}>{date.toLocaleDateString(undefined, { weekday: 'short' })}</div>
            <div className="apex-display" style={{ fontSize: 18, marginTop: 3, color: 'var(--color-apex-text)' }}>{date.getDate()}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, marginTop: 3, color: count ? 'var(--color-apex-brass)' : 'var(--color-apex-muted)' }}>
              {count ? `${count} item${count === 1 ? '' : 's'}` : 'clear'}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 14 }}>
        {([
          ['all', 'All'],
          ['call', 'Calls'],
          ['appointment', 'Appointments'],
          ['task', 'Other'],
        ] as Array<[FilterKind, string]>).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            style={{
              border: `1px solid ${filter === id ? 'var(--color-apex-brass)' : 'var(--color-apex-line)'}`,
              background: filter === id ? 'var(--color-apex-brass-soft)' : 'rgba(255,255,255,0.025)',
              color: filter === id ? 'var(--color-apex-brass)' : 'var(--color-apex-muted)',
              borderRadius: 5,
              padding: '7px 10px',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
            }}
          >
            {label} {counts[id]}
          </button>
        ))}
      </div>

      <div className="glass-card" style={{ overflow: 'hidden' }}>
        {isLoading ? (
          <div className="apex-eyebrow" style={{ padding: 28 }}>Loading schedule…</div>
        ) : grouped.length === 0 ? (
          <div style={{ padding: '44px 20px', textAlign: 'center', color: 'var(--color-apex-muted)' }}>
            <CalendarDays size={34} style={{ margin: '0 auto 12px', opacity: 0.55 }} />
            <div className="apex-display" style={{ fontSize: 15 }}>No future {filter === 'all' ? 'scheduled items' : `${filter}s`}</div>
            <div style={{ marginTop: 6, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              This view updates from APEX's durable scheduler every 10 seconds.
            </div>
          </div>
        ) : (
          grouped.map((group) => (
            <section key={group.key}>
              <div style={{ padding: '9px 14px', background: 'rgba(255,255,255,0.025)', borderBottom: '1px solid var(--color-apex-line)' }}>
                <span className="apex-eyebrow">{dayLabel(group.date, now)}</span>
              </div>
              {group.items.map((item) => {
                const meta = kindMeta(item.kind);
                return (
                  <div
                    key={item.job.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '72px minmax(0, 1fr)',
                      gap: 12,
                      padding: '13px 14px',
                      borderBottom: '1px solid var(--color-apex-line)',
                    }}
                  >
                    <div style={{ color: 'var(--color-apex-text)' }}>
                      <div className="apex-display" style={{ fontSize: 13 }}>
                        {item.at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: meta.color, fontSize: 9, fontFamily: 'var(--font-mono)', marginTop: 5 }}>
                        {meta.icon}{meta.label.toUpperCase()}
                      </div>
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: 'var(--color-apex-text)', fontWeight: 600, fontSize: 13, overflowWrap: 'anywhere' }}>{item.job.name}</div>
                      {(item.contact || item.phone) && (
                        <div style={{ marginTop: 4, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)', fontSize: 10, overflowWrap: 'anywhere' }}>
                          {[item.contact, item.phone].filter(Boolean).join(' · ')}
                        </div>
                      )}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
                        <span>{item.job.jobType}</span>
                        {item.job.cronExpression && <span>recurring · {item.job.cronExpression}</span>}
                        <span>status {item.job.status}</span>
                        {item.job.targetAgentId && <span>agent {item.job.targetAgentId}</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>
          ))
        )}
      </div>

      <div style={{ marginTop: 9, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)', fontSize: 9, display: 'flex', alignItems: 'center', gap: 5 }}>
        <Clock3 size={10} />
        Last synced {dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : 'not yet'} · source: durable APEX scheduler
      </div>
    </div>
  );
}
