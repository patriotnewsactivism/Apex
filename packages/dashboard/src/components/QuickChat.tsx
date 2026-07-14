import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import type { Goal, Agent, LogEntry } from '../lib/api.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import {
  Send,
  ChevronUp,
  Zap,
  Target,
  Activity,
  Users,
  ArrowUpRight,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Loader,
  Sparkles,
  Terminal,
  Brain,
  Bot,
} from 'lucide-react';

function useIsMobile() {
  const [m, setM] = useState(window.innerWidth < 768);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 768);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return m;
}

/* ── Stat card ─────────────────────────────────────────────────────────────── */

function StatCard({
  label,
  value,
  icon,
  color,
  glow,
  sub,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  color: string;
  glow?: string;
  sub?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      style={{
        padding: '16px 18px',
        borderRadius: 14,
        background: `linear-gradient(135deg, ${color}08, ${color}03)`,
        border: `1px solid ${color}20`,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* subtle glow */}
      {glow && (
        <div
          style={{
            position: 'absolute',
            top: -40,
            right: -40,
            width: 100,
            height: 100,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${glow}15, transparent)`,
            pointerEvents: 'none',
          }}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: `${color}15`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color,
          }}
        >
          {icon}
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-apex-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {label}
        </span>
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 800,
          color,
          fontFamily: 'var(--font-mono)',
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', marginTop: 4 }}>{sub}</div>
      )}
    </motion.div>
  );
}

/* ── Agent pill ─────────────────────────────────────────────────────────── */

function AgentPill({ agent }: { agent: Agent }) {
  const statusColors: Record<string, string> = {
    idle: '#64748b',
    active: '#00e5ff',
    working: '#00e5ff',
    thinking: '#b84cff',
    error: '#ff3b5c',
  };
  const c = statusColors[agent.liveStatus || agent.status] || '#64748b';
  const isActive = agent.liveStatus === 'working' || agent.liveStatus === 'active' || agent.liveStatus === 'thinking';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderRadius: 10,
        background: isActive ? `${c}0a` : 'rgba(255,255,255,0.02)',
        border: `1px solid ${isActive ? `${c}25` : 'rgba(255,255,255,0.05)'}`,
        transition: 'all 0.2s',
      }}
    >
      <div style={{ position: 'relative' }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: c,
            boxShadow: isActive ? `0 0 8px ${c}80` : 'none',
          }}
        />
        {isActive && (
          <div
            style={{
              position: 'absolute',
              inset: -3,
              borderRadius: '50%',
              border: `1px solid ${c}40`,
              animation: 'pulse 2s ease-in-out infinite',
            }}
          />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: isActive ? 'var(--color-apex-text)' : 'var(--color-apex-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {agent.name}
        </div>
        <div style={{ fontSize: 9, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
          {agent.role}
        </div>
      </div>
    </motion.div>
  );
}

/* ── Log line ─────────────────────────────────────────────────────────── */

function LogLine({ entry }: { entry: LogEntry }) {
  const levelColors: Record<string, string> = {
    info: '#00e5ff',
    warn: '#ffd60a',
    error: '#ff3b5c',
    debug: '#64748b',
  };
  const c = levelColors[entry.level] || '#64748b';
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      style={{
        display: 'flex',
        gap: 8,
        padding: '6px 0',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        borderBottom: '1px solid rgba(255,255,255,0.03)',
      }}
    >
      <span style={{ color: 'var(--color-apex-muted)', flexShrink: 0, fontSize: 10 }}>{time}</span>
      <span
        style={{
          color: c,
          fontWeight: 600,
          textTransform: 'uppercase',
          fontSize: 9,
          flexShrink: 0,
          minWidth: 32,
        }}
      >
        {entry.level}
      </span>
      <span
        style={{
          color: 'var(--color-apex-text)',
          opacity: 0.8,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.message}
      </span>
    </motion.div>
  );
}

/* ── Goal card ─────────────────────────────────────────────────────────── */

function GoalCard({ goal }: { goal: Goal }) {
  const statusConfig: Record<string, { color: string; icon: React.ReactNode; bg: string }> = {
    active: {
      color: '#00e5ff',
      icon: <Loader size={12} />,
      bg: 'rgba(0,229,255,0.06)',
    },
    completed: {
      color: '#00ff88',
      icon: <CheckCircle2 size={12} />,
      bg: 'rgba(0,255,136,0.06)',
    },
    paused: {
      color: '#ffd60a',
      icon: <AlertTriangle size={12} />,
      bg: 'rgba(255,214,10,0.06)',
    },
    cancelled: {
      color: '#ff3b5c',
      icon: <AlertTriangle size={12} />,
      bg: 'rgba(255,59,92,0.06)',
    },
  };
  const cfg = statusConfig[goal.status] || statusConfig.active;
  const age = Date.now() - goal.createdAt;
  const ageStr =
    age < 3600000
      ? `${Math.floor(age / 60000)}m ago`
      : age < 86400000
        ? `${Math.floor(age / 3600000)}h ago`
        : `${Math.floor(age / 86400000)}d ago`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ x: 3, transition: { duration: 0.15 } }}
      style={{
        padding: '12px 14px',
        borderRadius: 10,
        background: cfg.bg,
        border: `1px solid ${cfg.color}18`,
        borderLeft: `3px solid ${cfg.color}`,
        cursor: 'default',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 9,
            padding: '2px 7px',
            borderRadius: 4,
            background: `${cfg.color}18`,
            color: cfg.color,
            fontWeight: 600,
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
          }}
        >
          {cfg.icon}
          {goal.status}
        </span>
        <span style={{ fontSize: 9, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
          P{goal.priority}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--color-apex-muted)' }}>
          {ageStr}
        </span>
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--color-apex-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {goal.title}
      </div>
      {goal.result && (
        <div
          style={{
            fontSize: 10,
            color: '#00ff88',
            fontFamily: 'var(--font-mono)',
            marginTop: 6,
            padding: '4px 8px',
            background: 'rgba(0,255,136,0.05)',
            borderRadius: 4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          ✓ {goal.result.slice(0, 120)}
        </div>
      )}
    </motion.div>
  );
}

/* ── Chat bubble ──────────────────────────────────────────────────────── */

interface ChatMessage {
  id: string;
  role: 'user' | 'system';
  text: string;
  goalId?: string;
  timestamp: number;
}

/* ════════════════════════════════════════════════════════════════════════════ */
/* ██  MAIN COMPONENT                                                       ██ */
/* ════════════════════════════════════════════════════════════════════════════ */

export function QuickChat() {
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'system',
      text: "What do you need? Type anything — I'll route it to the right agents.",
      timestamp: Date.now(),
    },
  ]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const { connected, agentStatuses } = useWebSocket();

  const { data: goals = [] } = useQuery({
    queryKey: ['goals'],
    queryFn: () => api.goals.list(),
    refetchInterval: 10000,
  });

  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents.list(),
    refetchInterval: 15000,
  });

  const { data: logs = [] } = useQuery({
    queryKey: ['logs-recent'],
    queryFn: () => api.logs.list(8),
    refetchInterval: 8000,
  });

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const submitMut = useMutation({
    mutationFn: (data: { title: string; description: string; priority: number }) =>
      api.goals.submit(data),
    onSuccess: (_result, variables) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `sys-${Date.now()}`,
          role: 'system',
          text: `✅ Got it. Deployed as goal "${variables.title}" — agents are on it.`,
          timestamp: Date.now(),
        },
      ]);
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
    onError: (err: Error) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'system',
          text: `❌ Failed: ${err.message}`,
          timestamp: Date.now(),
        },
      ]);
    },
  });

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    setMessages((prev) => [
      ...prev,
      { id: `usr-${Date.now()}`, role: 'user', text, timestamp: Date.now() },
    ]);
    setInput('');

    const lines = text.split('\n').filter((l) => l.trim());
    let title: string;
    let description: string;
    let priority = 5;

    if (lines.length === 1 && text.length < 200) {
      title = text.length > 80 ? text.slice(0, 77) + '...' : text;
      description = text;
    } else {
      title = lines[0].length > 80 ? lines[0].slice(0, 77) + '...' : lines[0];
      description = text;
    }

    const lower = text.toLowerCase();
    if (/urgent|asap|critical|immediately/.test(lower)) priority = 1;
    else if (/high priority|important/.test(lower)) priority = 2;
    else if (/low priority|when you can|no rush/.test(lower)) priority = 8;

    if (description.length < 10) description += ' — submitted via quick chat';

    submitMut.mutate({ title, description, priority });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Derived stats
  const activeGoals = goals.filter((g) => g.status === 'active').length;
  const completedGoals = goals.filter((g) => g.status === 'completed').length;
  const activeAgentCount = Object.values(agentStatuses).filter((s) => s !== 'idle').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: isMobile ? 16 : 20 }}>
      {/* ── Top Stats Row ─────────────────────────────────────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
          gap: isMobile ? 10 : 14,
        }}
      >
        <StatCard
          label="Active Goals"
          value={activeGoals}
          icon={<Target size={16} />}
          color="#00e5ff"
          glow="#00e5ff"
          sub={`${goals.length} total`}
        />
        <StatCard
          label="Completed"
          value={completedGoals}
          icon={<CheckCircle2 size={16} />}
          color="#00ff88"
          glow="#00ff88"
        />
        <StatCard
          label="Agents"
          value={`${activeAgentCount}/${agents.length}`}
          icon={<Users size={16} />}
          color="#b84cff"
          glow="#b84cff"
          sub={activeAgentCount > 0 ? 'working' : 'standing by'}
        />
        <StatCard
          label="Status"
          value={connected ? 'LIVE' : 'OFF'}
          icon={<Zap size={16} />}
          color={connected ? '#00ff88' : '#ff3b5c'}
          glow={connected ? '#00ff88' : '#ff3b5c'}
          sub={connected ? 'WebSocket connected' : 'Reconnecting...'}
        />
      </div>

      {/* ── Main Grid: Chat + Sidebar ─────────────────────────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : '1fr 320px',
          gap: isMobile ? 16 : 20,
          minHeight: isMobile ? 'auto' : 'calc(100vh - 300px)',
        }}
      >
        {/* ── Left: Chat + Input ────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Chat area */}
          <div
            style={{
              flex: 1,
              borderRadius: 14,
              background: 'rgba(13,17,23,0.6)',
              border: '1px solid rgba(0,229,255,0.08)',
              backdropFilter: 'blur(8px)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              minHeight: isMobile ? 280 : 400,
            }}
          >
            {/* Chat header */}
            <div
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid rgba(0,229,255,0.06)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: 'linear-gradient(135deg, #00e5ff20, #b84cff20)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Sparkles size={14} color="#00e5ff" />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-apex-text)' }}>
                  APEX Command
                </div>
                <div style={{ fontSize: 9, color: 'var(--color-apex-muted)' }}>
                  Natural language → agent orchestration
                </div>
              </div>
            </div>

            {/* Messages */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <AnimatePresence>
                {messages.map((msg) => (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    style={{
                      display: 'flex',
                      justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                    }}
                  >
                    <div
                      style={{
                        maxWidth: '85%',
                        padding: '10px 14px',
                        borderRadius:
                          msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                        background:
                          msg.role === 'user'
                            ? 'linear-gradient(135deg, rgba(0,229,255,0.15), rgba(184,76,255,0.08))'
                            : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${msg.role === 'user' ? 'rgba(0,229,255,0.18)' : 'rgba(255,255,255,0.05)'}`,
                        fontSize: 13,
                        lineHeight: 1.5,
                        color: 'var(--color-apex-text)',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {msg.text}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              {submitMut.isPending && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    color: '#00e5ff',
                    fontSize: 12,
                  }}
                >
                  <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  Routing to agents...
                </motion.div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input area */}
          <div>
            {expanded && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                style={{
                  fontSize: 10,
                  color: 'var(--color-apex-muted)',
                  marginBottom: 6,
                  padding: '8px 12px',
                  background: 'rgba(0,229,255,0.03)',
                  border: '1px solid rgba(0,229,255,0.08)',
                  borderRadius: 8,
                }}
              >
                <strong style={{ color: '#00e5ff' }}>Tips:</strong> First line becomes the goal
                title. Say "urgent" or "critical" for high priority. Shift+Enter for newlines.
              </motion.div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <button
                onClick={() => setExpanded(!expanded)}
                style={{
                  background: 'rgba(13,17,23,0.6)',
                  border: '1px solid rgba(0,229,255,0.12)',
                  borderRadius: 10,
                  padding: '11px',
                  cursor: 'pointer',
                  color: expanded ? '#00e5ff' : 'var(--color-apex-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  transition: 'all 0.15s',
                  flexShrink: 0,
                }}
              >
                <ChevronUp
                  size={16}
                  style={{
                    transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s',
                  }}
                />
              </button>
              <textarea
                ref={inputRef}
                className="apex-input"
                placeholder="Tell APEX what to do..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={expanded ? 4 : 1}
                style={{
                  flex: 1,
                  resize: 'none',
                  minHeight: expanded ? 100 : 44,
                  transition: 'min-height 0.2s',
                  fontSize: 14,
                }}
              />
              <motion.button
                className="btn-primary"
                onClick={handleSubmit}
                disabled={!input.trim() || submitMut.isPending}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                style={{
                  padding: '11px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  flexShrink: 0,
                  borderRadius: 10,
                }}
              >
                <Send size={16} />
              </motion.button>
            </div>
          </div>
        </div>

        {/* ── Right Sidebar ──────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: isMobile ? 16 : 14 }}>
          {/* Agent roster */}
          <div
            style={{
              borderRadius: 14,
              background: 'rgba(13,17,23,0.6)',
              border: '1px solid rgba(184,76,255,0.08)',
              backdropFilter: 'blur(8px)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '12px 14px',
                borderBottom: '1px solid rgba(184,76,255,0.06)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Bot size={14} color="#b84cff" />
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: 'var(--color-apex-text)',
                }}
              >
                Agent Roster
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 9,
                  color: 'var(--color-apex-muted)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {agents.length} registered
              </span>
            </div>
            <div
              style={{
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                maxHeight: isMobile ? 200 : 240,
                overflowY: 'auto',
              }}
            >
              {agents.length === 0 ? (
                <div
                  style={{
                    padding: '20px 12px',
                    textAlign: 'center',
                    color: 'var(--color-apex-muted)',
                    fontSize: 11,
                  }}
                >
                  No agents registered yet
                </div>
              ) : (
                agents.slice(0, 10).map((a) => <AgentPill key={a.id} agent={a} />)
              )}
            </div>
          </div>

          {/* Recent goals */}
          <div
            style={{
              borderRadius: 14,
              background: 'rgba(13,17,23,0.6)',
              border: '1px solid rgba(0,229,255,0.08)',
              backdropFilter: 'blur(8px)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '12px 14px',
                borderBottom: '1px solid rgba(0,229,255,0.06)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Target size={14} color="#00e5ff" />
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-apex-text)' }}>
                Recent Goals
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 9,
                  color: 'var(--color-apex-muted)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {activeGoals} active
              </span>
            </div>
            <div
              style={{
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                maxHeight: isMobile ? 250 : 300,
                overflowY: 'auto',
              }}
            >
              {goals.length === 0 ? (
                <div
                  style={{
                    padding: '24px 12px',
                    textAlign: 'center',
                    color: 'var(--color-apex-muted)',
                    fontSize: 11,
                  }}
                >
                  <div style={{ fontSize: 24, marginBottom: 6 }}>🎯</div>
                  No goals yet — type a command above
                </div>
              ) : (
                goals.slice(0, 5).map((g) => <GoalCard key={g.id} goal={g} />)
              )}
            </div>
          </div>

          {/* Live log tail */}
          <div
            style={{
              borderRadius: 14,
              background: 'rgba(13,17,23,0.6)',
              border: '1px solid rgba(0,255,136,0.08)',
              backdropFilter: 'blur(8px)',
              overflow: 'hidden',
              flex: 1,
              minHeight: 0,
            }}
          >
            <div
              style={{
                padding: '12px 14px',
                borderBottom: '1px solid rgba(0,255,136,0.06)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Terminal size={14} color="#00ff88" />
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-apex-text)' }}>
                Live Feed
              </span>
              <div
                style={{
                  marginLeft: 'auto',
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: connected ? '#00ff88' : '#ff3b5c',
                  boxShadow: connected ? '0 0 6px #00ff8880' : 'none',
                }}
              />
            </div>
            <div
              style={{
                padding: '6px 12px',
                maxHeight: isMobile ? 160 : 200,
                overflowY: 'auto',
              }}
            >
              {logs.length === 0 ? (
                <div
                  style={{
                    padding: '16px 8px',
                    textAlign: 'center',
                    color: 'var(--color-apex-muted)',
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  Waiting for activity...
                </div>
              ) : (
                logs.slice(0, 8).map((l) => <LogLine key={l.id} entry={l} />)
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
