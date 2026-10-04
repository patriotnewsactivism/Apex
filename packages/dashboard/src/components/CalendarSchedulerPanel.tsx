import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type CalendarAgendaItem } from '../lib/api.js';
import { useIsMobile } from '../hooks/useIsMobile.js';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, RefreshCw } from 'lucide-react';

type ViewMode = 'day' | 'week' | 'agenda';

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function rangeFor(view: ViewMode, anchor: Date): { start: Date; end: Date } {
  const start = startOfLocalDay(anchor);
  if (view === 'day') return { start, end: addDays(start, 1) };
  if (view === 'agenda') return { start, end: addDays(start, 14) };
  const weekStart = addDays(start, -start.getDay());
  return { start: weekStart, end: addDays(weekStart, 7) };
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayHeading(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function CalendarSchedulerPanel() {
  const isMobile = useIsMobile();
  const [view, setView] = useState<ViewMode>('agenda');
  const [anchor, setAnchor] = useState(() => new Date());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const range = useMemo(() => rangeFor(view, anchor), [view, anchor]);

  const agendaQuery = useQuery({
    queryKey: ['calendar', 'agenda', range.start.toISOString(), range.end.toISOString()],
    queryFn: () => api.calendar.agenda(range.start.toISOString(), range.end.toISOString()),
    refetchInterval: 30_000,
  });

  const items = agendaQuery.data?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const timelineQuery = useQuery({
    queryKey: ['calendar', 'timeline', selected?.contactId],
    queryFn: () => api.calendar.timeline(selected!.contactId!),
    enabled: Boolean(selected?.contactId),
  });

  const step = view === 'week' ? 7 : view === 'agenda' ? 14 : 1;

  return (
    <div style={{ minWidth: 0, maxWidth: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['day', 'week', 'agenda'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              style={chipStyle(view === mode)}
            >
              {mode === 'day' ? 'Day' : mode === 'week' ? 'Week' : 'Agenda'}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setAnchor((current) => addDays(current, -step))} style={chipStyle(false)} aria-label="Previous">
            <ChevronLeft size={14} />
          </button>
          <button type="button" onClick={() => setAnchor(new Date())} style={chipStyle(false)}>Today</button>
          <button type="button" onClick={() => setAnchor((current) => addDays(current, step))} style={chipStyle(false)} aria-label="Next">
            <ChevronRight size={14} />
          </button>
          <span style={{ fontSize: 12, color: 'var(--color-apex-text)' }}>{dayHeading(range.start)}</span>
        </div>
        <button type="button" onClick={() => void agendaQuery.refetch()} style={chipStyle(false)} aria-label="Refresh calendar">
          <RefreshCw size={13} />
        </button>
      </div>

      {agendaQuery.isLoading && <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>Loading calendar…</div>}
      {agendaQuery.isError && (
        <div style={{ fontSize: 12, color: 'var(--color-apex-red)', marginBottom: 8 }}>
          {agendaQuery.error instanceof Error ? agendaQuery.error.message : 'Calendar unavailable'}
        </div>
      )}

      {view === 'agenda' && <AgendaList items={items} selectedId={selectedId} onSelect={setSelectedId} />}
      {view === 'day' && <DayList day={startOfLocalDay(anchor)} items={items} selectedId={selectedId} onSelect={setSelectedId} />}
      {view === 'week' && (
        <WeekGrid
          start={range.start}
          items={items}
          stacked={isMobile}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      {selected && (
        <div style={{ marginTop: 14, padding: 14, borderRadius: 10, border: '1px solid var(--color-apex-line)', minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
            <span style={{ width: 10, height: 10, borderRadius: 99, background: selected.color ?? 'var(--color-apex-brass)', flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--color-apex-text)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{selected.title}</div>
              <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>{selected.startLabel} – {selected.endLabel}</div>
            </div>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-apex-muted)', lineHeight: 1.45 }}>
            {selected.kind === 'hold' ? 'APEX hold' : selected.agentName ? `Booked by ${selected.agentName}` : 'Google event'}
            {selected.contactName ? ` · ${selected.contactName}` : ''}
            {selected.status ? ` · ${selected.status}` : ''}
          </div>
          {selected.contactId ? (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--color-apex-text)', marginBottom: 6 }}>Contact timeline</div>
              {timelineQuery.isLoading && <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>Loading contact…</div>}
              {(timelineQuery.data?.rows ?? []).map((row) => (
                <div key={row.id} style={{ fontSize: 12, color: 'var(--color-apex-text)', padding: '6px 0', borderTop: '1px solid var(--color-apex-line)' }}>
                  <div>{row.summary}</div>
                  <div style={{ color: 'var(--color-apex-muted)' }}>
                    {row.actorName} · {new Date(row.occurredAt).toLocaleString(undefined, { timeZone: row.timezone || 'America/Chicago' })}
                  </div>
                </div>
              ))}
              {timelineQuery.data && timelineQuery.data.rows.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>No timeline rows for this contact yet.</div>
              )}
            </div>
          ) : (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-apex-muted)' }}>No CRM contact is linked to this item.</div>
          )}
        </div>
      )}

      {!agendaQuery.isLoading && items.length === 0 && !agendaQuery.isError && (
        <div style={{ marginTop: 16, fontSize: 13, color: 'var(--color-apex-muted)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <CalendarDays size={16} /> Nothing on the calendar in this range.
        </div>
      )}
    </div>
  );
}

function AgendaList({ items, selectedId, onSelect }: { items: CalendarAgendaItem[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      {items.map((item) => (
        <EventButton key={item.id} item={item} selected={item.id === selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
}

function DayList({ day, items, selectedId, onSelect }: { day: Date; items: CalendarAgendaItem[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const todays = items.filter((item) => sameDay(new Date(item.start), day));
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 13, marginBottom: 8, color: 'var(--color-apex-text)' }}>{dayHeading(day)}</div>
      {todays.length === 0 && <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>Open day.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {todays.map((item) => (
          <EventButton key={item.id} item={item} selected={item.id === selectedId} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

function WeekGrid({
  start,
  items,
  stacked,
  selectedId,
  onSelect,
}: {
  start: Date;
  items: CalendarAgendaItem[];
  stacked: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: stacked ? 'minmax(0, 1fr)' : 'repeat(7, minmax(0, 1fr))',
      gap: 8,
      minWidth: 0,
    }}>
      {days.map((day) => {
        const todays = items.filter((item) => sameDay(new Date(item.start), day));
        return (
          <div key={day.toISOString()} style={{ minWidth: 0, border: '1px solid var(--color-apex-line)', borderRadius: 8, padding: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginBottom: 6 }}>{dayHeading(day)}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {todays.map((item) => (
                <EventButton key={item.id} item={item} selected={item.id === selectedId} onSelect={onSelect} compact />
              ))}
              {todays.length === 0 && <div style={{ fontSize: 11, color: 'var(--color-apex-muted)' }}>—</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EventButton({
  item,
  selected,
  onSelect,
  compact = false,
}: {
  item: CalendarAgendaItem;
  selected: boolean;
  onSelect: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      style={{
        textAlign: 'left',
        minWidth: 0,
        width: '100%',
        borderRadius: 8,
        border: `1px solid ${selected ? 'var(--color-apex-brass)' : 'var(--color-apex-line)'}`,
        background: 'rgba(255,255,255,0.03)',
        padding: compact ? '6px 8px' : '10px 12px',
        cursor: 'pointer',
        color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: 99, background: item.color ?? (item.kind === 'hold' ? 'var(--color-apex-signal)' : 'var(--color-apex-brass)'), flexShrink: 0 }} />
        <span style={{ fontSize: compact ? 11 : 13, color: 'var(--color-apex-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-apex-muted)', display: 'flex', gap: 4, alignItems: 'center' }}>
        <Clock3 size={11} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.startLabel}</span>
      </div>
    </button>
  );
}

function chipStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    minHeight: 32,
    padding: '6px 10px',
    borderRadius: 6,
    border: `1px solid ${active ? 'var(--color-apex-brass)' : 'var(--color-apex-line)'}`,
    background: active ? 'var(--color-apex-brass-soft)' : 'transparent',
    color: active ? 'var(--color-apex-brass)' : 'var(--color-apex-muted)',
    cursor: 'pointer',
    fontSize: 12,
  };
}
