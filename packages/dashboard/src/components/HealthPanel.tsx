import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { api } from '../lib/api.js';
import type { ComponentCheck, HealthAlert } from '../lib/api.js';
import {
  Activity,
  Database,
  Brain,
  Wrench,
  Wifi,
  ListChecks,
  Cpu,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Bell,
  BellOff,
  RefreshCw,
} from 'lucide-react';

// ─── Health Panel ─────────────────────────────────────────────────────────────

const STATUS_COLORS = {
  healthy: { bg: 'rgba(34, 197, 94, 0.15)', border: 'rgba(34, 197, 94, 0.4)', text: '#22c55e', dot: '#22c55e' },
  degraded: { bg: 'rgba(234, 179, 8, 0.15)', border: 'rgba(234, 179, 8, 0.4)', text: '#eab308', dot: '#eab308' },
  critical: { bg: 'rgba(239, 68, 68, 0.15)', border: 'rgba(239, 68, 68, 0.4)', text: '#ef4444', dot: '#ef4444' },
} as const;

const COMPONENT_ICONS: Record<string, React.ReactNode> = {
  database: <Database size={18} />,
  llmProviders: <Cpu size={18} />,
  memorySystem: <Brain size={18} />,
  toolRegistry: <Wrench size={18} />,
  webSocket: <Wifi size={18} />,
  taskBacklog: <ListChecks size={18} />,
};

const COMPONENT_LABELS: Record<string, string> = {
  database: 'Database',
  llmProviders: 'LLM Providers',
  memorySystem: 'Memory System',
  toolRegistry: 'Tool Registry',
  webSocket: 'WebSocket',
  taskBacklog: 'Task Backlog',
};

function StatusDot({ status }: { status: 'healthy' | 'degraded' | 'critical' }) {
  const colors = STATUS_COLORS[status];
  return (
    <span style={{ position: 'relative', display: 'inline-flex', width: 10, height: 10 }}>
      {status !== 'healthy' && (
        <motion.span
          animate={{ scale: [1, 1.8, 1], opacity: [1, 0, 1] }}
          transition={{ duration: 2, repeat: Infinity }}
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            backgroundColor: colors.dot,
            opacity: 0.4,
          }}
        />
      )}
      <span style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        backgroundColor: colors.dot,
        position: 'relative',
      }} />
    </span>
  );
}

function ComponentCard({ name, check }: { name: string; check: ComponentCheck }) {
  const colors = STATUS_COLORS[check.status];
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      style={{
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: colors.text, opacity: 0.8 }}>
          {COMPONENT_ICONS[name] ?? <Activity size={18} />}
        </span>
        <span style={{ fontWeight: 600, color: '#e2e8f0', fontSize: 14 }}>
          {COMPONENT_LABELS[name] ?? name}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <StatusDot status={check.status} />
        </span>
      </div>
      <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.4 }}>
        {check.detail}
      </div>
      {check.ms !== undefined && (
        <div style={{ fontSize: 11, color: '#64748b' }}>
          {check.ms}ms
        </div>
      )}
    </motion.div>
  );
}

function AlertCard({ alert, onAcknowledge }: { alert: HealthAlert; onAcknowledge: (id: string) => void }) {
  const isCritical = alert.severity === 'critical';
  const colors = isCritical ? STATUS_COLORS.critical : STATUS_COLORS.degraded;
  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      style={{
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <AlertTriangle size={16} color={colors.text} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0' }}>{alert.message}</div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
          {alert.component} · {new Date(alert.firedAt).toLocaleTimeString()}
        </div>
      </div>
      {!alert.acknowledgedAt ? (
        <button
          onClick={() => onAcknowledge(alert.id)}
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.15)',
            color: '#e2e8f0',
            fontSize: 11,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <BellOff size={12} /> ACK
        </button>
      ) : (
        <span style={{ fontSize: 11, color: '#64748b' }}>
          <CheckCircle2 size={12} style={{ verticalAlign: 'middle' }} /> Ack'd
        </span>
      )}
    </motion.div>
  );
}

export function HealthPanel() {
  const queryClient = useQueryClient();

  const { data: report, isLoading, refetch: refetchReport } = useQuery({
    queryKey: ['health-report'],
    queryFn: () => api.health.report(),
    refetchInterval: 10_000,
  });

  const { data: alertData } = useQuery({
    queryKey: ['health-alerts'],
    queryFn: () => api.health.alerts(),
    refetchInterval: 10_000,
  });

  const ackMutation = useMutation({
    mutationFn: (alertId: string) => api.health.acknowledge(alertId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health-alerts'] });
    },
  });

  const overall = report?.overall ?? 'healthy';
  const overallColors = STATUS_COLORS[overall];
  const checks = report?.checks ?? {};
  const alerts = alertData?.alerts ?? [];
  const summary = alertData?.summary ?? { total: 0, critical: 0, warning: 0, acknowledged: 0 };

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
      {/* Overall Status Banner */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        style={{
          background: `linear-gradient(135deg, ${overallColors.bg}, rgba(15, 23, 42, 0.5))`,
          border: `1px solid ${overallColors.border}`,
          borderRadius: 16,
          padding: '24px 32px',
          marginBottom: 24,
          display: 'flex',
          alignItems: 'center',
          gap: 20,
        }}
      >
        <div style={{ position: 'relative' }}>
          {overall === 'healthy' ? (
            <CheckCircle2 size={40} color={overallColors.text} />
          ) : overall === 'critical' ? (
            <XCircle size={40} color={overallColors.text} />
          ) : (
            <AlertTriangle size={40} color={overallColors.text} />
          )}
        </div>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#f1f5f9' }}>
            System {overall.charAt(0).toUpperCase() + overall.slice(1)}
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#94a3b8' }}>
            {Object.keys(checks).length} components monitored ·{' '}
            {report?.timestamp ? new Date(report.timestamp).toLocaleTimeString() : '...'} ·{' '}
            {summary.total > 0 ? (
              <span style={{ color: overallColors.text }}>
                {summary.critical} critical, {summary.warning} warning alert{summary.total !== 1 ? 's' : ''}
              </span>
            ) : 'No active alerts'}
          </p>
        </div>
        <button
          onClick={() => refetchReport()}
          disabled={isLoading}
          style={{
            marginLeft: 'auto',
            padding: '8px 16px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: '#e2e8f0',
            fontSize: 13,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </motion.div>

      {/* Component Grid */}
      <h3 style={{ fontSize: 15, fontWeight: 600, color: '#cbd5e1', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Activity size={16} /> Component Status
      </h3>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: 12,
        marginBottom: 28,
      }}>
        {Object.entries(checks).map(([name, check]) => (
          <ComponentCard key={name} name={name} check={check} />
        ))}
      </div>

      {/* Active Alerts */}
      <h3 style={{ fontSize: 15, fontWeight: 600, color: '#cbd5e1', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Bell size={16} /> Active Alerts
        {summary.total > 0 && (
          <span style={{
            padding: '2px 8px',
            borderRadius: 10,
            fontSize: 11,
            fontWeight: 700,
            background: summary.critical > 0 ? STATUS_COLORS.critical.bg : STATUS_COLORS.degraded.bg,
            color: summary.critical > 0 ? STATUS_COLORS.critical.text : STATUS_COLORS.degraded.text,
            border: `1px solid ${summary.critical > 0 ? STATUS_COLORS.critical.border : STATUS_COLORS.degraded.border}`,
          }}>
            {summary.total}
          </span>
        )}
      </h3>
      {alerts.length === 0 ? (
        <div style={{
          padding: 20,
          textAlign: 'center',
          color: '#64748b',
          fontSize: 13,
          background: 'rgba(255,255,255,0.02)',
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.06)',
        }}>
          <CheckCircle2 size={20} style={{ marginBottom: 8, display: 'block', margin: '0 auto 8px' }} />
          No active alerts — all systems nominal
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {alerts.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              onAcknowledge={(id) => ackMutation.mutate(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
