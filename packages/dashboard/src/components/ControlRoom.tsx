import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { api } from '../lib/api.js';
import type { ScheduledJobRow, Agent } from '../lib/api.js';
import {
  Clock,
  Calendar,
  Power,
  Zap,
  Users,
  Gauge,
  Save,
  CheckCircle2,
  AlertCircle,
  RotateCw,
} from 'lucide-react';

// ─── Frequency presets ──────────────────────────────────────────────────────

const FREQ_PRESETS: { label: string; cron: string }[] = [
  { label: '5m', cron: '*/5 * * * *' },
  { label: '10m', cron: '*/10 * * * *' },
  { label: '15m', cron: '*/15 * * * *' },
  { label: '30m', cron: '*/30 * * * *' },
  { label: '1h', cron: '0 * * * *' },
  { label: '2h', cron: '0 */2 * * *' },
  { label: '6h', cron: '0 */6 * * *' },
  { label: '12h', cron: '0 */12 * * *' },
  { label: 'Daily 9am', cron: '0 9 * * *' },
  { label: 'Daily 3am', cron: '0 3 * * *' },
];

const CRON_TO_LABEL: Record<string, string> = Object.fromEntries(
  FREQ_PRESETS.map((f) => [f.cron, f.label]),
);

function formatNextRun(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  if (diffMs < 0) return 'overdue';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return date.toLocaleDateString();
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ─── Schedule Card ───────────────────────────────────────────────────────────

function ScheduleCard({ job }: { job: ScheduledJobRow }) {
  const queryClient = useQueryClient();
  const [customCron, setCustomCron] = useState('');

  const updateMutation = useMutation({
    mutationFn: (data: { cronExpression?: string; enabled?: boolean }) =>
      api.jobs.update(job.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const currentLabel = job.cronExpression ? CRON_TO_LABEL[job.cronExpression] ?? 'custom' : 'one-time';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: 'var(--color-apex-card)',
        border: `1px solid ${job.enabled ? 'rgba(0,229,255,0.15)' : 'rgba(100,116,139,0.15)'}`,
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-apex-text)' }}>
            {job.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginTop: 2 }}>
            {job.jobType} · {job.targetAgentId ?? 'system'} · priority {job.priority}
          </div>
        </div>
        <button
          onClick={() => updateMutation.mutate({ enabled: !job.enabled })}
          style={{
            background: job.enabled ? 'rgba(0,255,136,0.1)' : 'rgba(100,116,139,0.1)',
            border: `1px solid ${job.enabled ? 'rgba(0,255,136,0.3)' : 'rgba(100,116,139,0.3)'}`,
            borderRadius: 8,
            padding: '4px 10px',
            fontSize: 11,
            fontWeight: 600,
            color: job.enabled ? 'var(--color-apex-green)' : 'var(--color-apex-muted)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Power size={12} />
          {job.enabled ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* Status row */}
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--color-apex-muted)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Clock size={12} />
          Next: {formatNextRun(job.nextRunAt)}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <RotateCw size={12} />
          Last: {timeAgo(job.lastRunAt)}
        </span>
        {job.status === 'failed' && (
          <span style={{ color: 'var(--color-apex-red)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <AlertCircle size={12} />
            failed
          </span>
        )}
      </div>

      {/* Frequency presets */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {FREQ_PRESETS.map((preset) => {
          const isActive = job.cronExpression === preset.cron;
          return (
            <button
              key={preset.cron}
              onClick={() => updateMutation.mutate({ cronExpression: preset.cron })}
              style={{
                background: isActive ? 'rgba(0,229,255,0.15)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${isActive ? 'rgba(0,229,255,0.4)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: 6,
                padding: '4px 10px',
                fontSize: 11,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? 'var(--color-apex-cyan)' : 'var(--color-apex-muted)',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      {/* Custom cron */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          placeholder={job.cronExpression ?? 'custom cron (e.g. */20 * * * *)'}
          onChange={(e) => setCustomCron(e.target.value)}
          style={{
            flex: 1,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-apex-text)',
            outline: 'none',
          }}
        />
        <button
          onClick={() => {
            if (customCron.trim()) updateMutation.mutate({ cronExpression: customCron.trim() });
          }}
          style={{
            background: 'rgba(0,229,255,0.1)',
            border: '1px solid rgba(0,229,255,0.3)',
            borderRadius: 6,
            padding: '6px 12px',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-apex-cyan)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Save size={12} />
          Set
        </button>
      </div>
      {updateMutation.isError && (
        <div style={{ fontSize: 11, color: 'var(--color-apex-red)' }}>
          {(updateMutation.error as Error)?.message}
        </div>
      )}
    </motion.div>
  );
}

// ─── Agent Card ──────────────────────────────────────────────────────────────

function AgentBehaviorCard({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const concurrency = agent.concurrency ?? 1;
  const maxIter = agent.maxIterations ?? 20;

  const reconfigureMutation = useMutation({
    mutationFn: (data: { concurrency?: number; maxIterations?: number }) =>
      api.agents.reconfigure(agent.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const statusColor =
    agent.liveStatus === 'busy' ? 'var(--color-apex-cyan)' :
    agent.liveStatus === 'idle' ? 'var(--color-apex-green)' :
    agent.liveStatus === 'error' ? 'var(--color-apex-red)' :
    'var(--color-apex-muted)';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: 'var(--color-apex-card)',
        border: '1px solid rgba(0,229,255,0.12)',
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-apex-text)' }}>
            {agent.name}
          </div>
          <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', marginTop: 1 }}>
            {agent.role} · Tier {agent.tier}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor }} />
          <span style={{ fontSize: 11, color: 'var(--color-apex-muted)' }}>{agent.liveStatus ?? agent.status}</span>
        </div>
      </div>

      {/* Model info */}
      <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
        {agent.provider}/{agent.model}
      </div>

      {/* Concurrency control */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--color-apex-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Zap size={12} />
            Concurrency
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-apex-cyan)' }}>{concurrency}</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              onClick={() => reconfigureMutation.mutate({ concurrency: n })}
              style={{
                flex: 1,
                height: 24,
                background: n <= concurrency ? 'rgba(0,229,255,0.2)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${n === concurrency ? 'rgba(0,229,255,0.5)' : 'rgba(255,255,255,0.06)'}`,
                borderRadius: 4,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            />
          ))}
        </div>
      </div>

      {/* Max iterations */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--color-apex-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Gauge size={12} />
          Max Iterations
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-apex-text)' }}>{maxIter}</span>
      </div>

      {reconfigureMutation.isSuccess && (
        <div style={{ fontSize: 10, color: 'var(--color-apex-green)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <CheckCircle2 size={12} />
          Applied — takes effect on next task
        </div>
      )}
    </motion.div>
  );
}

// ─── Control Room Panel ──────────────────────────────────────────────────────

export function ControlRoom() {
  const { data: jobs = [], refetch: refetchJobs } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.jobs.list(),
    refetchInterval: 15_000,
  });

  const { data: agents = [], refetch: refetchAgents } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents.list(),
    refetchInterval: 15_000,
  });

  const activeJobs = jobs.filter((j) => j.enabled && j.status === 'active');
  const pausedJobs = jobs.filter((j) => !j.enabled || j.status !== 'active');
  const sortedAgents = [...agents].sort((a, b) => a.tier - b.tier);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Schedule Section */}
      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-apex-text)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Calendar size={18} color="var(--color-apex-cyan)" />
            Work Schedule
          </h2>
          <button
            onClick={() => { refetchJobs(); refetchAgents(); }}
            style={{
              background: 'rgba(0,229,255,0.06)',
              border: '1px solid rgba(0,229,255,0.15)',
              borderRadius: 8,
              padding: '6px 12px',
              fontSize: 11,
              color: 'var(--color-apex-cyan)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <RotateCw size={12} />
            Refresh
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginBottom: 12 }}>
          {activeJobs.length} active · {pausedJobs.length} paused — tap a frequency preset to adjust cadence instantly
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))',
          gap: 12,
        }}>
          {activeJobs.map((job) => (
            <ScheduleCard key={job.id} job={job} />
          ))}
          {pausedJobs.map((job) => (
            <ScheduleCard key={job.id} job={job} />
          ))}
        </div>
      </section>

      {/* Agents Section */}
      <section>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-apex-text)', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Users size={18} color="var(--color-apex-purple)" />
          Agent Behavior
        </h2>
        <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginBottom: 12 }}>
          Adjust concurrency (parallel tasks) per agent — changes take effect on the next task pickup
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))',
          gap: 12,
        }}>
          {sortedAgents.map((agent) => (
            <AgentBehaviorCard key={agent.id} agent={agent} />
          ))}
        </div>
      </section>
    </div>
  );
}
