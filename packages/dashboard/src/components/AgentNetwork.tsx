import { motion } from 'framer-motion';
import type { Agent } from '../lib/api.js';
import { useWebSocket } from '../hooks/useWebSocket.js';

/* Hierarchy ink: brass for authority, signal for eng live, green for ops */
const ROLE_COLORS: Record<string, string> = {
  CEO: '#b8956c',
  CTO: '#5a9eae',
  COO: '#6a9f78',
  LEAD_DEV: '#8b7ec8',
  FRONTEND: '#5a9eae',
  BACKEND: '#5a9eae',
  DEVOPS: '#5a9eae',
  QA: '#c9a84a',
  RESEARCH: '#6a9f78',
  DOCS: '#6a9f78',
  OPS: '#6a9f78',
  SALES: '#b8956c',
  MARKETING: '#b8956c',
  CUSTOMER_SUCCESS: '#6a9f78',
  QA_DIRECTOR: '#c9a84a',
};

const STATUS_COLORS: Record<string, string> = {
  idle: '#8a909c',
  thinking: '#5a9eae',
  acting: '#8b7ec8',
  blocked: '#c4894a',
  error: '#c45c66',
  done: '#6a9f78',
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
        const tierLabel = ['Tier 0 · Executive', 'Tier 1 · C-Suite', 'Tier 2 · Leads', 'Tier 3 · Specialists'][tier];
        return (
          <div key={tier}>
            <div
              className="apex-eyebrow"
              style={{
                marginBottom: 10,
                paddingLeft: `${tier * 16}px`,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span
                style={{
                  flex: 1,
                  height: 1,
                  background: 'var(--color-apex-line)',
                  maxWidth: tier === 0 ? 0 : 24,
                }}
              />
              {tierLabel}
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
