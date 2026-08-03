import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApexEvent, useWebSocket } from '../hooks/useWebSocket.js';
import { Zap, Target, ChevronRight, Activity } from 'lucide-react';
import type { Goal } from '../lib/api.js';

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
}

const STATUS_COLOR: Record<string, string> = {
  active: '#5a9eae',
  paused: '#c9a84a',
  completed: '#6a9f78',
  cancelled: '#c45c66',
};

const ACCENT = {
  signal: '#5a9eae',
  acting: '#8b7ec8',
  clear: '#6a9f78',
  halt: '#c45c66',
  brass: '#b8956c',
};

function GoalCard({ goal }: { goal: Goal }) {
  return (
    <motion.div
      className="glass-card"
      style={{ padding: '14px 16px', borderLeft: `3px solid ${STATUS_COLOR[goal.status] ?? '#64748b'}` }}
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      whileHover={{ x: 4 }}
      transition={{ duration: 0.2 }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, justifyContent: 'space-between' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: 10,
                padding: '2px 8px',
                borderRadius: 4,
                background: `${STATUS_COLOR[goal.status]}22`,
                color: STATUS_COLOR[goal.status],
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
              }}
            >
              {goal.status}
            </span>
            <span style={{ fontSize: 10, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
              P{goal.priority}
            </span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-apex-text)', marginBottom: 6, wordBreak: 'break-word' }}>
            {goal.title}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-apex-muted)', lineHeight: 1.6, wordBreak: 'break-word' }}>
            {goal.description.slice(0, 150)}{goal.description.length > 150 && '...'}
          </div>
          {goal.result && (
            <div
              style={{
                marginTop: 10,
                fontSize: 11,
                color: '#6a9f78',
                fontFamily: 'var(--font-mono)',
                background: 'rgba(106,159,120,0.06)',
                padding: '8px 12px',
                borderRadius: 6,
                borderLeft: '2px solid #6a9f78',
                wordBreak: 'break-word',
              }}
            >
              Result: {goal.result.slice(0, 200)}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

export function MissionControl() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(5);
  const [submitted, setSubmitted] = useState(false);
  const { connected, agentStatuses } = useWebSocket();
  const qc = useQueryClient();
  const isMobile = useIsMobile();

  const { data: goals = [], refetch } = useQuery({
    queryKey: ['goals'],
    queryFn: () => api.goals.list(),
    refetchInterval: 15000,
  });

  useApexEvent('goal:created', () => refetch());
  useApexEvent('goal:updated', () => refetch());

  const submitMut = useMutation({
    mutationFn: () => api.goals.submit({ title, description, priority }),
    onSuccess: () => {
      setTitle('');
      setDescription('');
      setPriority(5);
      setSubmitted(true);
      setTimeout(() => setSubmitted(false), 3000);
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
  });

  const activeAgents = Object.values(agentStatuses).filter((s) => s !== 'idle').length;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
        gap: isMobile ? 16 : 24,
        height: '100%',
      }}
    >
      {/* Left: Submit Goal */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: isMobile ? 12 : 20 }}>
        {/* Stats Bar */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: isMobile ? 8 : 12,
          }}
        >
          {[
            { label: 'Active Goals', value: goals.filter((g) => g.status === 'active').length, color: ACCENT.signal, icon: <Target size={isMobile ? 14 : 16} /> },
            { label: 'Active Agents', value: activeAgents, color: ACCENT.acting, icon: <Activity size={isMobile ? 14 : 16} /> },
            { label: 'Connected', value: connected ? 'LIVE' : 'OFF', color: connected ? ACCENT.clear : ACCENT.halt, icon: <Zap size={isMobile ? 14 : 16} /> },
          ].map((stat) => (
            <div
              key={stat.label}
              className="glass-card"
              style={{ padding: isMobile ? '10px 12px' : '14px 16px' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: stat.color, marginBottom: 4 }}>
                {stat.icon}
                <span
                  style={{
                    fontSize: isMobile ? 8 : 10,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {stat.label}
                </span>
              </div>
              <div
                style={{
                  fontSize: isMobile ? 18 : 22,
                  fontWeight: 800,
                  color: stat.color,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {stat.value}
              </div>
            </div>
          ))}
        </div>

        {/* Goal Submission Form */}
        <div className="glass-card" style={{ padding: isMobile ? 16 : 24, flex: isMobile ? 'none' : 1 }}>
          <h2 style={{ margin: '0 0 4px 0', fontSize: isMobile ? 14 : 16, fontWeight: 700, color: 'var(--color-apex-text)', fontFamily: 'var(--font-display)' }}>
            Issue a goal
          </h2>
          <p style={{ margin: '0 0 16px 0', fontSize: 12, color: 'var(--color-apex-muted)', lineHeight: 1.45 }}>
            CEO receives it first, then delegates down the hierarchy.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--color-apex-muted)', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Goal Title
              </label>
              <input
                id="goal-title"
                className="apex-input"
                placeholder="e.g. Build a REST API for user management"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--color-apex-muted)', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Description & Requirements
              </label>
              <textarea
                id="goal-description"
                className="apex-input apex-textarea"
                placeholder="Describe what you want APEX to build, research, or accomplish..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={isMobile ? 3 : 5}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--color-apex-muted)', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Priority (1=Highest, 10=Lowest): {priority}
              </label>
              <input
                id="goal-priority"
                type="range"
                min={1}
                max={10}
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value, 10))}
                style={{ width: '100%', accentColor: 'var(--color-apex-brass)' }}
              />
            </div>

            <motion.button
              id="submit-goal-btn"
              className="btn-primary"
              style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', fontSize: 14, padding: isMobile ? '12px 20px' : '10px 20px' }}
              onClick={() => submitMut.mutate()}
              disabled={!title || !description || submitMut.isPending}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              {submitMut.isPending ? (
                'Sending…'
              ) : submitted ? (
                'Goal sent'
              ) : (
                <>Send to CEO <ChevronRight size={16} /></>
              )}
            </motion.button>

            {submitMut.isError && (
              <div style={{ color: 'var(--color-apex-red)', fontSize: 12, padding: '8px 12px', background: 'rgba(196,92,102,0.08)', borderRadius: 6, border: '1px solid rgba(196,92,102,0.25)' }}>
                {submitMut.error?.message ?? 'Could not send goal. Check connection and try again.'}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right: Active Goals */}
      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 style={{ margin: '0 0 4px 0', fontSize: isMobile ? 14 : 16, fontWeight: 700, color: 'var(--color-apex-text)', fontFamily: 'var(--font-display)' }}>
          Active goals
        </h2>
        {goals.length === 0 && (
          <div
            style={{
              textAlign: 'center',
              color: 'var(--color-apex-muted)',
              padding: isMobile ? '40px 16px' : '60px 20px',
              border: '1px dashed var(--color-apex-line)',
              borderRadius: 8,
              background: 'rgba(0,0,0,0.12)',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--color-apex-text)' }}>No goals yet</div>
            <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.45 }}>
              Issue a goal on the left to put the workforce to work.
            </div>
          </div>
        )}
        {goals.map((g) => <GoalCard key={g.id} goal={g} />)}
      </div>
    </div>
  );
}
