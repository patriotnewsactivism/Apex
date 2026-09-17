import { useState } from 'react';
import { CalendarClock, ListTree } from 'lucide-react';
import { CalendarSchedulerAgenda } from './CalendarSchedulerAgenda.js';
import { CronRegistryPanel } from './CronRegistryPanel.js';

type SchedulerView = 'agenda' | 'registry';

export function ScheduledJobsPanel() {
  const [view, setView] = useState<SchedulerView>('agenda');

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div className="apex-toolbar" style={{ marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="apex-display" style={{ fontSize: 18, color: 'var(--color-apex-text)' }}>
            Calendar / Scheduler
          </div>
          <div className="apex-eyebrow" style={{ marginTop: 4 }}>
            Future calls, appointments and autonomous scheduled work
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            onClick={() => setView('agenda')}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderRadius: 5,
              border: `1px solid ${view === 'agenda' ? 'var(--color-apex-brass)' : 'var(--color-apex-line)'}`,
              background: view === 'agenda' ? 'var(--color-apex-brass-soft)' : 'rgba(255,255,255,0.025)',
              color: view === 'agenda' ? 'var(--color-apex-brass)' : 'var(--color-apex-muted)',
              cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 9,
            }}
          >
            <CalendarClock size={13} /> Agenda
          </button>
          <button
            type="button"
            onClick={() => setView('registry')}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderRadius: 5,
              border: `1px solid ${view === 'registry' ? 'var(--color-apex-brass)' : 'var(--color-apex-line)'}`,
              background: view === 'registry' ? 'var(--color-apex-brass-soft)' : 'rgba(255,255,255,0.025)',
              color: view === 'registry' ? 'var(--color-apex-brass)' : 'var(--color-apex-muted)',
              cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 9,
            }}
          >
            <ListTree size={13} /> Job Registry
          </button>
        </div>
      </div>

      {view === 'agenda' ? <CalendarSchedulerAgenda /> : <CronRegistryPanel />}
    </div>
  );
}
