import { motion } from 'framer-motion';
import type { Agent } from '../lib/api.js';
import { useWebSocket } from '../hooks/useWebSocket.js';

const ROLE_COLORS: Record<string, string> = {
  CEO: '#00e5ff',
  CTO: '#b84cff',
  COO: '#00ff88',
  LEAD_DEV: '#ffd60a',
  FRONTEND: '#ff8c00',
  BACKEND: '#ff8c00',
  DEVOPS: '#ff8c00',
  QA: '#ff8c00',
  RESEARCH: '#00ff88',
  DOCS: '#00ff88',
  OPS: '#00ff88',
};

const STATUS_COLORS: Record<string, string> = {
  idle: '#64748b',
  thinking: '#00e5ff',
  acting: '#b84cff',
  blocked: '#ff8c00',
  error: '#ff3b5c',
  done: '#00ff88',
};

function StatusDot({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? '#64748b';
  const isPulsing = status === 'thinking' || status === 'acting';
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: color,
        boxShadow: `0 0 8px ${color}`,
        animation: isPulsing ? 'pulse-cyan 1.5s ease-in-out infinite' : 'none',
        flexShrink: 0,
      }}
    />
  );
}

function AgentCard({ agent }: { agent: Agent }) {
  const { agentStatuses } = useWebSocket();
  const liveStatus = agentStatuses[agent.id] ?? agent.liveStatus ?? agent.status;
  const roleColor = ROLE_COLORS[agent.role] ?? '#64748b';

  return (
    <motion.div
      className="glass-card"
      style={{ padding: '14px 16px' }}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
      whileHover={{ scale: 1.02 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <StatusDot status={liveStatus} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.08em',
            color: roleColor,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {agent.role}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 10,
            color: STATUS_COLORS[liveStatus] ?? 'var(--color-apex-muted)',
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
          }}
        >
          {liveStatus}
        </span>
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-apex-text)' }}>
        {agent.name}
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
        {agent.model} · {agent.provider}
      </div>
    </motion.div>
  );
}

interface AgentNetworkProps {
  agents: Agent[];
}

export function AgentNetwork({ agents }: AgentNetworkProps) {
  const tiers: Record<number, Agent[]> = {};
  for (const a of agents) {
    if (!tiers[a.tier]) tiers[a.tier] = [];
    tiers[a.tier].push(a);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {[0, 1, 2, 3].map((tier) => {
        const tierAgents = tiers[tier] ?? [];
        if (tierAgents.length === 0) return null;
        const tierLabel = ['Executive', 'C-Suite', 'Management', 'Specialists'][tier];
        return (
          <div key={tier}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--color-apex-muted)',
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                marginBottom: 10,
                paddingLeft: `${tier * 20}px`,
              }}
            >
              Tier {tier} — {tierLabel}
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(auto-fill, minmax(200px, 1fr))`,
                gap: 10,
                paddingLeft: `${tier * 20}px`,
              }}
            >
              {tierAgents.map((a) => (
                <AgentCard key={a.id} agent={a} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
