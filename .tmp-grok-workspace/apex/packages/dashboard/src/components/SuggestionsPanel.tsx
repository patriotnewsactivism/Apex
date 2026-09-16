import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bot,
  CheckCircle2,
  Clock3,
  Lightbulb,
  RefreshCw,
  Rocket,
  Sparkles,
  Target,
  Trash2,
} from 'lucide-react';
import { api, type SuggestionRow } from '../lib/api.js';

const CATEGORY_META: Record<string, { color: string; label: string }> = {
  product_growth: { color: '#8b7ec8', label: 'Product Growth' },
  revenue: { color: '#6a9f78', label: 'Revenue' },
  efficiency: { color: '#5a9eae', label: 'Efficiency' },
  reliability: { color: '#cf8a54', label: 'Reliability' },
  user_experience: { color: '#8b7ec8', label: 'User Experience' },
  security: { color: '#c45c66', label: 'Security' },
  prompt_improvement: { color: '#c9a84a', label: 'Prompt Evolution' },
  cost_optimization: { color: '#6a9f78', label: 'Cost' },
  automation: { color: '#5a9eae', label: 'Automation' },
  distribution: { color: '#8b7ec8', label: 'Distribution' },
  consolidation: { color: '#cf8a54', label: 'Consolidation' },
  self_improvement: { color: '#5a9eae', label: 'APEX Upgrade' },
};

function percentage(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function SuggestionCard({ suggestion }: { suggestion: SuggestionRow }) {
  const queryClient = useQueryClient();
  const meta = CATEGORY_META[suggestion.category] ?? CATEGORY_META.product_growth;
  const implement = useMutation({
    mutationFn: () => api.suggestions.implement(suggestion.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['suggestions'] }),
  });
  const dismiss = useMutation({
    mutationFn: () => api.suggestions.dismiss(suggestion.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['suggestions'] }),
  });
  const observed = Array.isArray(suggestion.evidence?.observed)
    ? suggestion.evidence.observed as unknown[]
    : [];

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      style={{
        background: 'var(--color-apex-card)',
        border: `1px solid ${meta.color}33`,
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 11,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div>
          <div style={{ color: 'var(--color-apex-text)', fontSize: 14, fontWeight: 700, lineHeight: 1.35 }}>
            {suggestion.title}
          </div>
          <div style={{ color: 'var(--color-apex-muted)', fontSize: 10, marginTop: 4 }}>
            {suggestion.projectName} · {suggestion.source.replace(/_/g, ' ')}
          </div>
        </div>
        <span style={{ color: meta.color, background: `${meta.color}16`, borderRadius: 6, padding: '3px 7px', fontSize: 10, whiteSpace: 'nowrap' }}>
          {meta.label}
        </span>
      </div>

      <p style={{ margin: 0, color: 'var(--color-apex-muted)', fontSize: 12, lineHeight: 1.55 }}>
        {suggestion.description}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <span style={{ color: meta.color, background: `${meta.color}12`, borderRadius: 4, padding: '2px 7px', fontSize: 10, fontWeight: 700 }}>
          VALUE {suggestion.valueScore}/100
        </span>
        <span style={{ color: 'var(--color-apex-muted)', background: 'rgba(255,255,255,0.04)', borderRadius: 4, padding: '2px 7px', fontSize: 10 }}>
          {suggestion.impact} impact · {suggestion.difficulty} effort
        </span>
        <span style={{ color: 'var(--color-apex-muted)', background: 'rgba(255,255,255,0.04)', borderRadius: 4, padding: '2px 7px', fontSize: 10 }}>
          {percentage(suggestion.confidence)} confidence · {percentage(suggestion.novelty)} novelty
        </span>
      </div>

      <details style={{ color: 'var(--color-apex-muted)', fontSize: 11 }}>
        <summary style={{ cursor: 'pointer', color: 'var(--color-apex-cyan)' }}>Why this could matter</summary>
        <p style={{ lineHeight: 1.5 }}>{suggestion.rationale}</p>
        {observed.length > 0 && (
          <div><strong>Observed evidence:</strong> {observed.map(String).join(' · ')}</div>
        )}
        {suggestion.category === 'prompt_improvement' && typeof suggestion.proposedPlan?.candidatePrompt === 'string' && (
          <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', fontSize: 10, padding: 10, borderRadius: 8, background: 'rgba(0,0,0,0.2)' }}>
            {suggestion.proposedPlan.candidatePrompt}
          </pre>
        )}
      </details>

      <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
        {implement.isSuccess ? (
          <span style={{ color: 'var(--color-apex-green)', display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
            <CheckCircle2 size={15} /> Activated as a goal
          </span>
        ) : (
          <button
            onClick={() => implement.mutate()}
            disabled={implement.isPending || dismiss.isPending}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8, border: `1px solid ${meta.color}55`, background: `${meta.color}18`, color: meta.color, cursor: 'pointer', fontSize: 11, fontWeight: 700, minHeight: 38 }}
          >
            <Rocket size={14} /> {implement.isPending ? 'Activating…' : 'Implement'}
          </button>
        )}
        {!implement.isSuccess && (
          <button
            aria-label="Dismiss and teach APEX not to repeat this idea"
            onClick={() => dismiss.mutate()}
            disabled={dismiss.isPending || implement.isPending}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: 'var(--color-apex-muted)', cursor: 'pointer', fontSize: 11, minHeight: 38 }}
          >
            <Trash2 size={13} /> {dismiss.isPending ? 'Learning…' : 'Not useful'}
          </button>
        )}
      </div>
      {(implement.error || dismiss.error) && (
        <div style={{ color: '#c45c66', fontSize: 10 }}>
          {(implement.error ?? dismiss.error)?.message}
        </div>
      )}
    </motion.article>
  );
}

export function SuggestionsPanel() {
  const queryClient = useQueryClient();
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['suggestions'],
    queryFn: () => api.suggestions.list(),
    refetchInterval: 30_000,
  });
  const discover = useMutation({
    mutationFn: () => api.suggestions.discover(),
    onSuccess: () => {
      window.setTimeout(() => queryClient.invalidateQueries({ queryKey: ['suggestions'] }), 4_000);
    },
  });
  const suggestions = data?.suggestions ?? [];
  const background = data?.background;
  const backgroundActive = background?.runningWithoutDashboard ?? false;
  const nextDiscovery = background?.coreJobs.find((job) => job.jobType === 'opportunity_discovery')?.nextRunAt;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-apex-text)', display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <Sparkles size={19} color="#c9a84a" /> Autonomous Opportunities
          </h2>
          <div style={{ color: 'var(--color-apex-muted)', fontSize: 11, marginTop: 4 }}>
            New ways to increase product value, efficiency, quality, distribution, and agent performance
          </div>
        </div>
        <div style={{ display: 'flex', gap: 7 }}>
          <button onClick={() => discover.mutate()} disabled={discover.isPending} style={{ background: 'rgba(201,168,74,0.10)', border: '1px solid rgba(201,168,74,0.25)', borderRadius: 8, padding: '7px 11px', color: '#c9a84a', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, minHeight: 38 }}>
            <Lightbulb size={13} /> {discover.isPending ? 'Queuing…' : 'Find new ideas'}
          </button>
          <button onClick={() => refetch()} aria-label="Refresh opportunities" style={{ background: 'rgba(90,158,174,0.06)', border: '1px solid rgba(90,158,174,0.15)', borderRadius: 8, padding: '7px 10px', color: 'var(--color-apex-cyan)', cursor: 'pointer', minHeight: 38 }}>
            <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
        <div style={{ background: 'var(--color-apex-card)', border: '1px solid rgba(90,158,174,0.15)', borderRadius: 10, padding: 11, color: 'var(--color-apex-muted)', fontSize: 11 }}>
          <Bot size={14} color="#5a9eae" style={{ verticalAlign: 'middle', marginRight: 6 }} />
          Background mode <strong style={{ color: backgroundActive ? 'var(--color-apex-green)' : '#c45c66' }}>{backgroundActive ? 'active' : 'starting'}</strong>
        </div>
        <div style={{ background: 'var(--color-apex-card)', border: '1px solid rgba(90,158,174,0.15)', borderRadius: 10, padding: 11, color: 'var(--color-apex-muted)', fontSize: 11 }}>
          <Target size={14} color="#8b7ec8" style={{ verticalAlign: 'middle', marginRight: 6 }} />
          {background?.activeProjectLoops ?? 0} project improvement loops
        </div>
        <div style={{ background: 'var(--color-apex-card)', border: '1px solid rgba(90,158,174,0.15)', borderRadius: 10, padding: 11, color: 'var(--color-apex-muted)', fontSize: 11 }}>
          <Clock3 size={14} color="#c9a84a" style={{ verticalAlign: 'middle', marginRight: 6 }} />
          Next discovery {nextDiscovery ? new Date(nextDiscovery).toLocaleString() : 'is being scheduled'}
        </div>
      </div>

      {suggestions.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 38, color: 'var(--color-apex-muted)', background: 'var(--color-apex-card)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)' }}>
          <Sparkles size={36} style={{ margin: '0 auto 10px', display: 'block', opacity: 0.5 }} />
          <div style={{ fontSize: 13, fontWeight: 700 }}>Building the next opportunity set</div>
          <div style={{ fontSize: 11, marginTop: 4 }}>Discovery continues on schedule even while the dashboard is closed.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))', gap: 12 }}>
          <AnimatePresence>
            {suggestions.map((suggestion) => <SuggestionCard key={suggestion.id} suggestion={suggestion} />)}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
