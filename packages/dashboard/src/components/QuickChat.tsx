import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import type { Goal } from '../lib/api.js';
import { Send, ChevronUp, Zap, CheckCircle, AlertCircle, Loader } from 'lucide-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'system';
  text: string;
  goalId?: string;
  timestamp: number;
}

function GoalMiniCard({ goal }: { goal: Goal }) {
  const statusColor: Record<string, string> = {
    active: '#00e5ff',
    paused: '#ffd60a',
    completed: '#00ff88',
    cancelled: '#ff3b5c',
  };
  return (
    <div
      style={{
        padding: '10px 14px',
        background: 'rgba(0,229,255,0.04)',
        border: `1px solid ${statusColor[goal.status] ?? '#64748b'}33`,
        borderLeft: `3px solid ${statusColor[goal.status] ?? '#64748b'}`,
        borderRadius: 8,
        marginTop: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span
          style={{
            fontSize: 9,
            padding: '1px 6px',
            borderRadius: 3,
            background: `${statusColor[goal.status]}22`,
            color: statusColor[goal.status],
            fontWeight: 600,
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
          }}
        >
          {goal.status}
        </span>
        <span style={{ fontSize: 9, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
          P{goal.priority}
        </span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-apex-text)' }}>{goal.title}</div>
      {goal.result && (
        <div
          style={{
            fontSize: 11,
            color: '#00ff88',
            fontFamily: 'var(--font-mono)',
            marginTop: 6,
            padding: '6px 8px',
            background: 'rgba(0,255,136,0.06)',
            borderRadius: 4,
          }}
        >
          {goal.result.slice(0, 200)}
        </div>
      )}
    </div>
  );
}

export function QuickChat() {
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'system',
      text: 'What do you need? Type anything — I\'ll route it to the right agents.',
      timestamp: Date.now(),
    },
  ]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();

  const { data: goals = [] } = useQuery({
    queryKey: ['goals'],
    queryFn: () => api.goals.list(),
    refetchInterval: 10000,
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
    onSuccess: (result, variables) => {
      setMessages((prev) => [
        ...prev,
        {
          id: `sys-${Date.now()}`,
          role: 'system',
          text: `✅ Got it. Deployed as goal "${variables.title}" — agents are on it.`,
          goalId: result.goalId,
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

    // Add user message
    setMessages((prev) => [
      ...prev,
      { id: `usr-${Date.now()}`, role: 'user', text, timestamp: Date.now() },
    ]);
    setInput('');

    // Parse: first line = title, rest = description. If short, use whole thing as both.
    const lines = text.split('\n').filter((l) => l.trim());
    let title: string;
    let description: string;
    let priority = 5;

    if (lines.length === 1 && text.length < 200) {
      // Short message — use as both title and description
      title = text.length > 80 ? text.slice(0, 77) + '...' : text;
      description = text;
    } else {
      title = lines[0].length > 80 ? lines[0].slice(0, 77) + '...' : lines[0];
      description = text;
    }

    // Detect priority hints
    const lower = text.toLowerCase();
    if (lower.includes('urgent') || lower.includes('asap') || lower.includes('critical') || lower.includes('immediately')) {
      priority = 1;
    } else if (lower.includes('high priority') || lower.includes('important')) {
      priority = 2;
    } else if (lower.includes('low priority') || lower.includes('when you can') || lower.includes('no rush')) {
      priority = 8;
    }

    // Pad short descriptions to meet the 10-char minimum
    if (description.length < 10) {
      description = description + ' — submitted via quick chat';
    }

    submitMut.mutate({ title, description, priority });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Recent goals for context
  const recentGoals = goals.slice(0, 3);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', maxHeight: 'calc(100vh - 120px)' }}>
      {/* Recent goals summary */}
      {recentGoals.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 10,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-apex-text)' }}>
              Recent Goals
            </span>
            <span
              style={{
                fontSize: 10,
                color: 'var(--color-apex-muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {goals.filter((g) => g.status === 'active').length} active
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recentGoals.map((g) => (
              <GoalMiniCard key={g.id} goal={g} />
            ))}
          </div>
        </div>
      )}

      {/* Chat messages */}
      <div
        className="glass-card"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          minHeight: 200,
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
                  borderRadius: msg.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                  background:
                    msg.role === 'user'
                      ? 'linear-gradient(135deg, rgba(0,229,255,0.15), rgba(184,76,255,0.1))'
                      : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${msg.role === 'user' ? 'rgba(0,229,255,0.2)' : 'rgba(255,255,255,0.06)'}`,
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
            style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-apex-cyan)', fontSize: 12 }}
          >
            <Loader size={14} className="animate-pulse-cyan" />
            Routing to agents...
          </motion.div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{ marginTop: 12 }}>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            style={{
              fontSize: 10,
              color: 'var(--color-apex-muted)',
              marginBottom: 6,
              padding: '6px 10px',
              background: 'rgba(255,255,255,0.02)',
              borderRadius: 6,
            }}
          >
            <strong style={{ color: 'var(--color-apex-cyan)' }}>Tips:</strong> First line becomes the
            goal title. Say "urgent" or "critical" for high priority. Use Shift+Enter for newlines.
          </motion.div>
        )}
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-end',
          }}
        >
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              background: 'transparent',
              border: '1px solid rgba(0,229,255,0.12)',
              borderRadius: 8,
              padding: '10px',
              cursor: 'pointer',
              color: expanded ? 'var(--color-apex-cyan)' : 'var(--color-apex-muted)',
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
              minHeight: expanded ? 100 : 42,
              transition: 'min-height 0.2s',
            }}
          />
          <motion.button
            className="btn-primary"
            onClick={handleSubmit}
            disabled={!input.trim() || submitMut.isPending}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            style={{
              padding: '10px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexShrink: 0,
            }}
          >
            <Send size={16} />
          </motion.button>
        </div>
      </div>
    </div>
  );
}
