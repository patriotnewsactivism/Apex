import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Clock, Play, Pause, CalendarClock, Shield } from 'lucide-react';

const STATUS_COLORS: Record<string, string> = {
  active: 'var(--color-apex-green)',
  running: 'var(--color-apex-signal)',
  paused: 'var(--color-apex-orange)',
  failed: 'var(--color-apex-red)',
  completed: 'var(--color-apex-muted)',
};

export function ScheduledJobsPanel() {
  const queryClient = useQueryClient();
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.jobs.list(),
    refetchInterval: 15_000,
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => api.jobs.toggle(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  });

  const dynamicCount = jobs.filter((job) => (job.payload as Record<string, unknown> | null)?.dynamic === true).length;

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
      <div className="apex-toolbar" style={{ marginBottom: 18 }}>
        <div>
          <div className="apex-display" style={{ fontSize: 18, color: 'var(--color-apex-text)' }}>
            Scheduled work registry
          </div>
          <div className="apex-eyebrow" style={{ marginTop: 4 }}>
            Cron table + governor-governed dynamic jobs
          </div>
        </div>
        <div
          className="glass-card"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-apex-muted)',
          }}
        >
          <Shield size={13} color="var(--color-apex-brass)" />
          {dynamicCount} dynamic · floor 15m
        </div>
      </div>

      <div className="glass-card" style={{ overflow: 'hidden' }}>
        {isLoading ? (
          <div className="apex-eyebrow" style={{ padding: 24 }}>Loading jobs…</div>
        ) : jobs.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-apex-muted)' }}>
            <CalendarClock size={28} style={{ margin: '0 auto 10px', opacity: 0.5 }} />
            <div className="apex-eyebrow">No scheduled jobs</div>
          </div>
        ) : (
          <div style={{ maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' }}>
            {jobs.map((job) => (
              <div
                key={job.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--color-apex-line)',
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: STATUS_COLORS[job.status] ?? 'var(--color-apex-muted)',
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--color-apex-text)',
                        fontWeight: 600,
                      }}
                    >
                      {job.name}
                    </span>
                    {(job.payload as Record<string, unknown> | null)?.dynamic === true && (
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: 'var(--font-mono)',
                          padding: '1px 6px',
                          borderRadius: 3,
                          background: 'rgba(106,159,120,0.14)',
                          color: 'var(--color-apex-green)',
                          letterSpacing: '0.06em',
                        }}
                      >
                        DYNAMIC
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 3, fontSize: 10, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
                    <span>{job.jobType}</span>
                    <span>{job.cronExpression ?? 'one-time'}</span>
                    <span>status {job.status}</span>
                    {job.error && <span style={{ color: 'var(--color-apex-red)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>{job.error}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 2, fontSize: 10, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
                    {job.nextRunAt && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Clock size={10} /> next {new Date(job.nextRunAt).toLocaleString()}
                      </span>
                    )}
                    {job.missedRuns > 0 && <span>{job.missedRuns} missed → {job.catchUpMode} catch-up</span>}
                  </div>
                </div>
                <button
                  onClick={() => toggleMutation.mutate(job.id)}
                  disabled={toggleMutation.isPending}
                  title={job.enabled ? 'Pause' : 'Enable'}
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid var(--color-apex-line)',
                    borderRadius: 5,
                    padding: '6px 8px',
                    cursor: 'pointer',
                    color: job.enabled ? 'var(--color-apex-orange)' : 'var(--color-apex-green)',
                    display: 'flex',
                    alignItems: 'center',
                    flexShrink: 0,
                  }}
                >
                  {job.enabled ? <Pause size={13} /> : <Play size={13} />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}