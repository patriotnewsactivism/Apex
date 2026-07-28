import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../lib/api.js';
import type { SuggestionRow } from '../lib/api.js';
import {
  Lightbulb,
  Rocket,
  Zap,
  Wrench,
  CheckCircle2,
  RefreshCw,
  AlertTriangle,
  TrendingUp,
  Building2,
} from 'lucide-react';

const IMPACT_COLORS: Record<string, string> = {
  high: '#ff3b5c',
  medium: '#ffd60a',
  low: '#00ff88',
};

const CATEGORY_META: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  self_improvement: { icon: <Zap size={14} />, color: '#00e5ff', label: 'Self-Improvement' },
  app_improvement: { icon: <Building2 size={14} />, color: '#b84cff', label: 'App Improvement' },
};

function SuggestionCard({ suggestion }: { suggestion: SuggestionRow }) {
  const queryClient = useQueryClient();
  const cat = CATEGORY_META[suggestion.category] ?? CATEGORY_META.self_improvement;

  const implementMutation = useMutation({
    mutationFn: () => api.suggestions.implement(suggestion.id, {
      goalTitle: suggestion.goalTitle,
      goalDescription: suggestion.goalDescription,
      goalPriority: suggestion.goalPriority,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suggestions'] });
    },
  });

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      style={{
        background: 'var(--color-apex-card)',
        border: `1px solid ${cat.color}22`,
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-apex-text)', lineHeight: 1.3 }}>
            {suggestion.title}
          </div>
        </div>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 10,
          fontWeight: 600,
          color: cat.color,
          background: `${cat.color}11`,
          padding: '3px 8px',
          borderRadius: 6,
          whiteSpace: 'nowrap',
        }}>
          {cat.icon}
          {cat.label}
        </span>
      </div>

      {/* Description */}
      <p style={{ margin: 0, fontSize: 12, color: 'var(--color-apex-muted)', lineHeight: 1.5 }}>
        {suggestion.description}
      </p>

      {/* Badges */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          color: IMPACT_COLORS[suggestion.impact] ?? '#64748b',
          background: `${IMPACT_COLORS[suggestion.impact] ?? '#64748b'}11`,
          padding: '2px 8px',
          borderRadius: 4,
        }}>
          {suggestion.impact.toUpperCase()} IMPACT
        </span>
        <span style={{
          fontSize: 10,
          color: 'var(--color-apex-muted)',
          background: 'rgba(255,255,255,0.04)',
          padding: '2px 8px',
          borderRadius: 4,
        }}>
          {suggestion.difficulty}
        </span>
      </div>

      {/* Action */}
      {implementMutation.isSuccess ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          color: 'var(--color-apex-green)',
          fontWeight: 600,
        }}>
          <CheckCircle2 size={16} />
          Submitted as goal to CEO
        </div>
      ) : (
        <button
          onClick={() => implementMutation.mutate()}
          disabled={implementMutation.isPending}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 16px',
            borderRadius: 8,
            background: `${cat.color}1a`,
            border: `1px solid ${cat.color}44`,
            color: cat.color,
            fontSize: 12,
            fontWeight: 600,
            cursor: implementMutation.isPending ? 'wait' : 'pointer',
            opacity: implementMutation.isPending ? 0.5 : 1,
            transition: 'all 0.15s',
            width: 'fit-content',
            minHeight: 40,
          }}
        >
          <Rocket size={14} />
          {implementMutation.isPending ? 'Submitting...' : 'Implement'}
        </button>
      )}
    </motion.div>
  );
}

export function SuggestionsPanel() {
  const { data: suggestions = [], refetch, isFetching } = useQuery({
    queryKey: ['suggestions'],
    queryFn: () => api.suggestions.list(),
    refetchInterval: 30_000,
  });

  const selfImprovement = suggestions.filter((s) => s.category === 'self_improvement');
  const appImprovement = suggestions.filter((s) => s.category === 'app_improvement');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-apex-text)', display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
          <Lightbulb size={20} color="#ffd60a" />
          Suggestions
        </h2>
        <button
          onClick={() => refetch()}
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
            minHeight: 36,
          }}
        >
          <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {suggestions.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: 40,
          color: 'var(--color-apex-muted)',
          background: 'var(--color-apex-card)',
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.06)',
        }}>
          <CheckCircle2 size={40} style={{ margin: '0 auto 12px', display: 'block', opacity: 0.5 }} />
          <div style={{ fontSize: 14, fontWeight: 600 }}>System is healthy — no suggestions</div>
          <div style={{ fontSize: 11, marginTop: 4 }}>Suggestions appear automatically when issues or opportunities are detected</div>
        </div>
      ) : (
        <>
          {/* Self-Improvement section */}
          {selfImprovement.length > 0 && (
            <section>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <TrendingUp size={16} color="#00e5ff" />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-apex-cyan)' }}>Self-Improvement</span>
                <span style={{ fontSize: 10, color: 'var(--color-apex-muted)' }}>({selfImprovement.length})</span>
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))',
                gap: 12,
              }}>
                <AnimatePresence>
                  {selfImprovement.map((s) => <SuggestionCard key={s.id} suggestion={s} />)}
                </AnimatePresence>
              </div>
            </section>
          )}

          {/* App-Improvement section */}
          {appImprovement.length > 0 && (
            <section>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <Building2 size={16} color="#b84cff" />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-apex-purple)' }}>App Improvement</span>
                <span style={{ fontSize: 10, color: 'var(--color-apex-muted)' }}>({appImprovement.length})</span>
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))',
                gap: 12,
              }}>
                <AnimatePresence>
                  {appImprovement.map((s) => <SuggestionCard key={s.id} suggestion={s} />)}
                </AnimatePresence>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
