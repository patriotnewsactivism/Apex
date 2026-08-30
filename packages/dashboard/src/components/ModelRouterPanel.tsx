import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  BrainCircuit,
  Check,
  DollarSign,
  Gauge,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { api } from '../lib/api.js';
import {
  settingsApi,
  type ModelOptimizationObjective,
  type ModelRoutingMode,
  type OpenRouterModelCatalogItem,
  type OpenRouterModelPolicy,
} from '../lib/settingsApi.js';

const DEFAULT_POLICY: OpenRouterModelPolicy = {
  version: 1,
  selectedModelIds: [],
  rolePrimary: {},
  routingMode: 'manual',
  optimizationObjective: 'balanced',
  minimumSamples: 5,
};

type SortMode = 'efficiency' | 'input-price' | 'output-price' | 'context' | 'name';

function price(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return 'FREE';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function money(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return 'FREE';
  if (value < 0.001) return `$${value.toFixed(5)}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(3)}`;
}

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function latency(value: number | null): string {
  if (value === null) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function contextLabel(tokens: number): string {
  if (!tokens) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

function typicalTaskCost(model: OpenRouterModelCatalogItem): number | null {
  const input = model.pricing.inputPerMillion;
  const output = model.pricing.outputPerMillion;
  if (input === null || output === null) return null;
  // Transparent comparison assumption: 20k prompt + 4k completion tokens.
  return input * 0.02 + output * 0.004;
}

function scoreLabel(score: number): string {
  if (score >= 85) return 'Excellent value';
  if (score >= 70) return 'Strong value';
  if (score >= 55) return 'Balanced';
  if (score >= 40) return 'Premium';
  return 'Cost-heavy';
}

function ModelBadge({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 6px',
      borderRadius: 5, border: '1px solid var(--color-apex-border)',
      color: 'var(--color-apex-muted)', fontSize: 9, whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

const MODE_COPY: Record<ModelRoutingMode, string> = {
  manual: 'Exact operator order. APEX records evidence but never changes routing.',
  advisor: 'Exact operator order plus evidence-backed recommendations for you to review.',
  adaptive: 'APEX may reorder evidence-qualified models inside your selected roster. Role pins stay first.',
};

const OBJECTIVE_COPY: Record<ModelOptimizationObjective, string> = {
  quality: 'Favor completed-task success and satisfaction even when a model costs more.',
  balanced: 'Balance completed-task quality, actual cost, provider reliability, and latency.',
  budget: 'Push harder on actual generation cost while preserving outcome quality and reliability.',
  speed: 'Favor lower observed latency while preserving outcome quality and reliability.',
};

export function ModelRouterPanel() {
  const queryClient = useQueryClient();
  const [policy, setPolicy] = useState<OpenRouterModelPolicy>(DEFAULT_POLICY);
  const [initializedFromServer, setInitializedFromServer] = useState(false);
  const [search, setSearch] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [agentReadyOnly, setAgentReadyOnly] = useState(true);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('efficiency');
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [intelligenceRole, setIntelligenceRole] = useState('');
  const [intelligenceComplexity, setIntelligenceComplexity] = useState<string>('all');

  const catalogQuery = useQuery({
    queryKey: ['settings', 'models'],
    queryFn: () => settingsApi.models(),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents.list(),
  });

  useEffect(() => {
    if (!initializedFromServer && catalogQuery.data?.policy) {
      setPolicy(catalogQuery.data.policy);
      setInitializedFromServer(true);
    }
  }, [catalogQuery.data?.policy, initializedFromServer]);

  const models = catalogQuery.data?.models ?? [];
  const modelById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  const selectedSet = useMemo(() => new Set(policy.selectedModelIds), [policy.selectedModelIds]);

  const roles = useMemo(() => {
    const raw = agentsQuery.data as Array<{ role?: string; name?: string }> | undefined;
    const found = new Map<string, string>();
    for (const agent of raw ?? []) {
      if (agent.role) found.set(agent.role, agent.name ?? agent.role);
    }
    return [...found.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [agentsQuery.data]);

  useEffect(() => {
    if (intelligenceRole || roles.length === 0) return;
    const preferred = roles.find(([role]) => role === 'BACKEND') ?? roles[0];
    if (preferred) setIntelligenceRole(preferred[0]);
  }, [intelligenceRole, roles]);

  const visibleModels = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const result = models.filter((model) => {
      if (needle && !`${model.name} ${model.id} ${model.description}`.toLowerCase().includes(needle)) return false;
      if (freeOnly && !model.isFree) return false;
      if (agentReadyOnly && !model.agentReady) return false;
      if (selectedOnly && !selectedSet.has(model.id)) return false;
      return true;
    });

    result.sort((a, b) => {
      if (sortMode === 'efficiency') return b.efficiencyScore - a.efficiencyScore;
      if (sortMode === 'context') return b.contextLength - a.contextLength;
      if (sortMode === 'name') return a.name.localeCompare(b.name);
      const key = sortMode === 'input-price' ? 'inputPerMillion' : 'outputPerMillion';
      const av = a.pricing[key] ?? Number.POSITIVE_INFINITY;
      const bv = b.pricing[key] ?? Number.POSITIVE_INFINITY;
      return av - bv;
    });
    return result;
  }, [models, search, freeOnly, agentReadyOnly, selectedOnly, selectedSet, sortMode]);

  const intelligenceQuery = useQuery({
    queryKey: ['settings', 'models', 'intelligence', intelligenceRole, intelligenceComplexity, catalogQuery.data?.policy?.optimizationObjective, catalogQuery.data?.policy?.minimumSamples],
    queryFn: () => settingsApi.modelIntelligence(intelligenceRole, {
      complexity: intelligenceComplexity === 'all' ? undefined : Number(intelligenceComplexity),
    }),
    enabled: Boolean(intelligenceRole && catalogQuery.data?.policy?.selectedModelIds.length),
    staleTime: 60_000,
    retry: 1,
  });

  const saveMutation = useMutation({
    mutationFn: () => settingsApi.saveModelPolicy(policy),
    onSuccess: (result) => {
      setPolicy(result.policy);
      setSavedMessage(result.warning ?? `Saved — applies to ${result.applies}.`);
      queryClient.invalidateQueries({ queryKey: ['settings', 'models'] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setTimeout(() => setSavedMessage(null), 5000);
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => settingsApi.resetModelPolicy(),
    onSuccess: (result) => {
      setPolicy(result.policy);
      setSavedMessage('Restored the reviewed DeepSeek V4 fallback chain.');
      queryClient.invalidateQueries({ queryKey: ['settings', 'models'] });
    },
  });

  const toggleModel = (modelId: string) => {
    setPolicy((previous) => {
      const selected = previous.selectedModelIds.includes(modelId)
        ? previous.selectedModelIds.filter((id) => id !== modelId)
        : [...previous.selectedModelIds, modelId];
      const selectedNext = new Set(selected);
      const rolePrimary = Object.fromEntries(
        Object.entries(previous.rolePrimary).filter(([, id]) => selectedNext.has(id)),
      );
      return { ...previous, selectedModelIds: selected, rolePrimary };
    });
  };

  const moveSelected = (index: number, delta: number) => {
    setPolicy((previous) => {
      const next = [...previous.selectedModelIds];
      const target = index + delta;
      if (target < 0 || target >= next.length) return previous;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...previous, selectedModelIds: next };
    });
  };

  const setRolePrimary = (role: string, modelId: string) => {
    setPolicy((previous) => {
      const rolePrimary = { ...previous.rolePrimary };
      if (modelId) rolePrimary[role] = modelId;
      else delete rolePrimary[role];
      return { ...previous, rolePrimary };
    });
  };

  const selectedModels = policy.selectedModelIds.map((id) => modelById.get(id)).filter(Boolean) as OpenRouterModelCatalogItem[];
  const freeSelected = selectedModels.filter((model) => model.isFree).length;
  const agentReadySelected = selectedModels.filter((model) => model.agentReady).length;
  const intelligence = intelligenceQuery.data?.report;
  const intelligenceStats = useMemo(() => {
    if (!intelligence) return [];
    const byId = new Map(intelligence.stats.map((stat) => [stat.modelId, stat]));
    return intelligence.recommendedOrder.map((id) => byId.get(id)).filter(Boolean).slice(0, 10);
  }, [intelligence]);

  return (
    <section style={{
      background: 'var(--color-apex-card)', border: '1px solid rgba(139,126,200,0.2)',
      borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 18,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <BrainCircuit size={20} color="#8b7ec8" />
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-apex-text)' }}>OpenRouter Model Control</span>
          </div>
          <p style={{ fontSize: 12, color: 'var(--color-apex-muted)', margin: '6px 0 0', lineHeight: 1.45, maxWidth: 820 }}>
            Select the model roster, compare live price/capabilities, and choose whether APEX should preserve your exact order, advise you from observed outcomes, or adapt inside your selected roster. Static efficiency is a heuristic; learned rankings use completed APEX tasks, observed latency, and OpenRouter-reported generation cost.
          </p>
        </div>
        <button
          className="btn-secondary"
          onClick={() => catalogQuery.refetch()}
          disabled={catalogQuery.isFetching}
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}
        >
          <RefreshCw size={13} /> {catalogQuery.isFetching ? 'Refreshing…' : 'Refresh live prices'}
        </button>
      </div>

      {catalogQuery.error && (
        <div style={{ border: '1px solid rgba(196,92,102,0.35)', borderRadius: 8, padding: 12, color: '#c45c66', fontSize: 11 }}>
          OpenRouter catalog unavailable: {(catalogQuery.error as Error).message}. Existing routing policy is unchanged.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
        {[
          ['Selected', String(policy.selectedModelIds.length)],
          ['Free selected', String(freeSelected)],
          ['Agent-ready', `${agentReadySelected}/${selectedModels.length || 0}`],
          ['Catalog models', String(models.length)],
        ].map(([label, value]) => (
          <div key={label} style={{ padding: 12, borderRadius: 8, border: '1px solid var(--color-apex-border)', background: 'rgba(255,255,255,0.015)' }}>
            <div style={{ fontSize: 10, color: 'var(--color-apex-muted)' }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-apex-text)', marginTop: 3 }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ border: '1px solid rgba(139,126,200,0.28)', borderRadius: 10, padding: 14, background: 'rgba(139,126,200,0.035)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
          <Sparkles size={15} color="#8b7ec8" />
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-apex-text)' }}>Model Intelligence routing policy</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 10 }}>
          <label style={{ display: 'grid', gap: 5 }}>
            <span style={{ fontSize: 9, color: 'var(--color-apex-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Routing mode</span>
            <select className="apex-input" value={policy.routingMode} onChange={(event) => setPolicy((previous) => ({ ...previous, routingMode: event.target.value as ModelRoutingMode }))}>
              <option value="manual">Manual — exact order</option>
              <option value="advisor">Advisor — recommend only</option>
              <option value="adaptive">Adaptive — evidence can reorder</option>
            </select>
          </label>
          <label style={{ display: 'grid', gap: 5 }}>
            <span style={{ fontSize: 9, color: 'var(--color-apex-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Optimization objective</span>
            <select className="apex-input" value={policy.optimizationObjective} onChange={(event) => setPolicy((previous) => ({ ...previous, optimizationObjective: event.target.value as ModelOptimizationObjective }))}>
              <option value="quality">Quality first</option>
              <option value="balanced">Balanced</option>
              <option value="budget">Budget first</option>
              <option value="speed">Speed first</option>
            </select>
          </label>
          <label style={{ display: 'grid', gap: 5 }}>
            <span style={{ fontSize: 9, color: 'var(--color-apex-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Evidence threshold</span>
            <select className="apex-input" value={policy.minimumSamples} onChange={(event) => setPolicy((previous) => ({ ...previous, minimumSamples: Number(event.target.value) }))}>
              {[3, 5, 10, 20, 40].map((value) => <option key={value} value={value}>{value} completed tasks/model</option>)}
            </select>
          </label>
        </div>
        <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', lineHeight: 1.5, marginTop: 9 }}>
          <strong style={{ color: 'var(--color-apex-text)' }}>{MODE_COPY[policy.routingMode]}</strong> {OBJECTIVE_COPY[policy.optimizationObjective]} Models below the evidence threshold keep their operator-defined positions; APEX never fills the roster with an unselected model.
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 260px' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--color-apex-muted)' }} />
          <input
            className="apex-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search models, providers, capabilities…"
            style={{ width: '100%', paddingLeft: 32 }}
          />
        </div>
        <select className="apex-input" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} style={{ width: 'auto', minWidth: 165 }}>
          <option value="efficiency">Best value-efficiency</option>
          <option value="input-price">Lowest input price</option>
          <option value="output-price">Lowest output price</option>
          <option value="context">Largest context</option>
          <option value="name">Name</option>
        </select>
        {[
          ['Free only', freeOnly, setFreeOnly],
          ['Tool-ready only', agentReadyOnly, setAgentReadyOnly],
          ['Selected only', selectedOnly, setSelectedOnly],
        ].map(([label, checked, setter]) => (
          <label key={label as string} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--color-apex-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={checked as boolean} onChange={(event) => (setter as (value: boolean) => void)(event.target.checked)} />
            {label as string}
          </label>
        ))}
      </div>

      <div style={{ border: '1px solid var(--color-apex-border)', borderRadius: 9, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 850, fontSize: 11 }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.025)', color: 'var(--color-apex-muted)', textAlign: 'left' }}>
                <th style={{ padding: 9, width: 40 }}>Use</th>
                <th style={{ padding: 9 }}>Model</th>
                <th style={{ padding: 9 }}><DollarSign size={11} style={{ display: 'inline' }} /> Input / M</th>
                <th style={{ padding: 9 }}>Output / M</th>
                <th style={{ padding: 9 }}>Typical task*</th>
                <th style={{ padding: 9 }}>Context</th>
                <th style={{ padding: 9 }}><Gauge size={11} style={{ display: 'inline' }} /> Static value</th>
                <th style={{ padding: 9 }}>Capabilities</th>
              </tr>
            </thead>
            <tbody>
              {visibleModels.map((model) => {
                const selected = selectedSet.has(model.id);
                const taskCost = typicalTaskCost(model);
                return (
                  <tr key={model.id} style={{ borderTop: '1px solid var(--color-apex-border)', background: selected ? 'rgba(139,126,200,0.06)' : 'transparent' }}>
                    <td style={{ padding: 9 }}>
                      <input type="checkbox" checked={selected} onChange={() => toggleModel(model.id)} aria-label={`Select ${model.name}`} />
                    </td>
                    <td style={{ padding: 9, maxWidth: 300 }}>
                      <div style={{ fontWeight: 650, color: 'var(--color-apex-text)', display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                        {model.name}
                        {model.isFree && <ModelBadge>FREE</ModelBadge>}
                        {!model.agentReady && <ModelBadge>NO TOOLS</ModelBadge>}
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>{model.id}</div>
                    </td>
                    <td style={{ padding: 9, color: model.isFree ? '#6a9f78' : 'var(--color-apex-text)', fontWeight: 600 }}>{price(model.pricing.inputPerMillion)}</td>
                    <td style={{ padding: 9, color: model.isFree ? '#6a9f78' : 'var(--color-apex-text)', fontWeight: 600 }}>{price(model.pricing.outputPerMillion)}</td>
                    <td style={{ padding: 9 }}>{taskCost === null ? '—' : taskCost === 0 ? 'FREE' : `$${taskCost.toFixed(taskCost < 0.01 ? 4 : 3)}`}</td>
                    <td style={{ padding: 9 }}>{contextLabel(model.contextLength)}</td>
                    <td style={{ padding: 9 }}>
                      <div style={{ fontWeight: 700, color: 'var(--color-apex-text)' }}>{model.efficiencyScore}/100</div>
                      <div style={{ fontSize: 9, color: 'var(--color-apex-muted)' }}>{scoreLabel(model.efficiencyScore)}</div>
                    </td>
                    <td style={{ padding: 9 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                        {model.capabilities.toolCalling && <ModelBadge><Wrench size={9} /> tools</ModelBadge>}
                        {model.capabilities.reasoning && <ModelBadge>reasoning</ModelBadge>}
                        {model.capabilities.structuredOutput && <ModelBadge>JSON</ModelBadge>}
                        {model.capabilities.vision && <ModelBadge>vision</ModelBadge>}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!catalogQuery.isLoading && visibleModels.length === 0 && (
                <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: 'var(--color-apex-muted)' }}>No models match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '7px 10px', borderTop: '1px solid var(--color-apex-border)', fontSize: 9, color: 'var(--color-apex-muted)' }}>
          * Typical task is a static comparison estimate using 20K input + 4K output tokens. The learned panel below uses OpenRouter-reported per-generation cost where available.
        </div>
      </div>

      <div style={{ border: '1px solid rgba(90,158,174,0.25)', borderRadius: 10, padding: 14, background: 'rgba(90,158,174,0.03)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <BarChart3 size={15} color="#5a9eae" />
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-apex-text)' }}>Observed Model Intelligence</div>
              <div style={{ fontSize: 9, color: 'var(--color-apex-muted)', marginTop: 2 }}>30-day evidence from actual APEX generations joined to completed task outcomes.</div>
            </div>
          </div>
          <button className="btn-secondary" disabled={!intelligenceRole || intelligenceQuery.isFetching} onClick={() => intelligenceQuery.refetch()} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10 }}>
            <RefreshCw size={11} /> {intelligenceQuery.isFetching ? 'Analyzing…' : 'Refresh evidence'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <select className="apex-input" value={intelligenceRole} onChange={(event) => setIntelligenceRole(event.target.value)} style={{ width: 'auto', minWidth: 190 }}>
            {roles.map(([role, name]) => <option key={role} value={role}>{name} ({role})</option>)}
          </select>
          <select className="apex-input" value={intelligenceComplexity} onChange={(event) => setIntelligenceComplexity(event.target.value)} style={{ width: 'auto', minWidth: 190 }}>
            <option value="all">All task complexities</option>
            <option value="0.25">Routine / light</option>
            <option value="0.5">Moderate</option>
            <option value="0.75">Hard</option>
            <option value="1">Very hard / critical</option>
          </select>
        </div>

        {intelligenceQuery.error && <div style={{ color: '#c45c66', fontSize: 10 }}>Could not load model evidence: {(intelligenceQuery.error as Error).message}</div>}
        {intelligence && (
          <>
            <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', lineHeight: 1.5, marginBottom: 10 }}>
              {intelligenceQuery.data?.explanation} Evidence-qualified models: <strong style={{ color: 'var(--color-apex-text)' }}>{intelligence.evidenceReadyModels}</strong>. Threshold: {intelligence.minimumSamples} completed tasks/model. Objective: {intelligence.objective}. {intelligence.recommendationChanged ? 'The evidence currently recommends a different order for qualified slots.' : 'The evidence does not currently justify changing the saved qualified slots.'}
            </div>
            {intelligenceStats.length > 0 ? (
              <div style={{ overflowX: 'auto', border: '1px solid var(--color-apex-border)', borderRadius: 8 }}>
                <table style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse', fontSize: 10 }}>
                  <thead><tr style={{ textAlign: 'left', color: 'var(--color-apex-muted)', background: 'rgba(255,255,255,0.02)' }}>
                    <th style={{ padding: 8 }}>Rank</th><th style={{ padding: 8 }}>Model</th><th style={{ padding: 8 }}>Observed score</th><th style={{ padding: 8 }}>Task success</th><th style={{ padding: 8 }}>Samples</th><th style={{ padding: 8 }}>Avg actual cost</th><th style={{ padding: 8 }}>Avg latency</th><th style={{ padding: 8 }}>Confidence</th>
                  </tr></thead>
                  <tbody>
                    {intelligenceStats.map((stat, index) => {
                      if (!stat) return null;
                      const model = modelById.get(stat.modelId);
                      const ready = stat.taskSamples >= intelligence.minimumSamples;
                      return <tr key={stat.modelId} style={{ borderTop: '1px solid var(--color-apex-border)' }}>
                        <td style={{ padding: 8, color: 'var(--color-apex-muted)' }}>#{index + 1}</td>
                        <td style={{ padding: 8 }}><div style={{ fontWeight: 650, color: 'var(--color-apex-text)' }}>{model?.name ?? stat.modelId}</div><div style={{ fontSize: 8, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>{stat.modelId}</div></td>
                        <td style={{ padding: 8, fontWeight: 700 }}>{stat.observedScore === null ? 'Learning…' : `${Math.round(stat.observedScore * 100)}/100`}</td>
                        <td style={{ padding: 8 }}>{pct(stat.taskSuccessRate)}</td>
                        <td style={{ padding: 8 }}>{stat.taskSamples} {ready ? <ModelBadge>QUALIFIED</ModelBadge> : <ModelBadge>LEARNING</ModelBadge>}</td>
                        <td style={{ padding: 8 }}>{money(stat.avgCostUsd)}</td>
                        <td style={{ padding: 8 }}>{latency(stat.avgLatencyMs)}</td>
                        <td style={{ padding: 8 }}>{pct(stat.confidence)}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', padding: 12, border: '1px dashed var(--color-apex-border)', borderRadius: 8 }}>
                No attributable task/model evidence yet for this role. APEX will populate this automatically as the instrumented runtime serves generations and completed task outcomes arrive. Until enough evidence exists, adaptive mode preserves your saved order.
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px,1fr) minmax(300px,1fr)', gap: 14 }} className="model-routing-grid">
        <div style={{ border: '1px solid var(--color-apex-border)', borderRadius: 9, padding: 13, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-apex-text)' }}>Global fallback priority</div>
          <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', margin: '3px 0 10px' }}>Manual/advisor use this exact order. Adaptive may reorder only evidence-qualified slots; unqualified models keep their positions.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {policy.selectedModelIds.map((id, index) => {
              const model = modelById.get(id);
              return (
                <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: 7, borderRadius: 7, background: 'rgba(255,255,255,0.025)', minWidth: 0 }}>
                  <span style={{ width: 20, color: 'var(--color-apex-muted)', fontSize: 10 }}>{index + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-apex-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model?.name ?? id}</div>
                    <div style={{ fontSize: 8, color: 'var(--color-apex-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{id}</div>
                  </div>
                  <button className="btn-secondary" onClick={() => moveSelected(index, -1)} disabled={index === 0} aria-label="Move up" style={{ padding: 4 }}><ArrowUp size={11} /></button>
                  <button className="btn-secondary" onClick={() => moveSelected(index, 1)} disabled={index === policy.selectedModelIds.length - 1} aria-label="Move down" style={{ padding: 4 }}><ArrowDown size={11} /></button>
                </div>
              );
            })}
            {policy.selectedModelIds.length === 0 && <div style={{ color: '#c45c66', fontSize: 10 }}>Select at least one model before saving.</div>}
          </div>
        </div>

        <div style={{ border: '1px solid var(--color-apex-border)', borderRadius: 9, padding: 13, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-apex-text)' }}>Role-specific first choice</div>
          <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', margin: '3px 0 10px' }}>A role pin is a hard operator decision. It stays first even in adaptive mode; learned ranking applies to the remaining eligible slots.</div>
          <div style={{ display: 'grid', gap: 7 }}>
            {roles.map(([role, name]) => (
              <label key={role} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px,0.8fr) minmax(160px,1.2fr)', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 10, color: 'var(--color-apex-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name} <span style={{ opacity: 0.55 }}>({role})</span></span>
                <select
                  className="apex-input"
                  value={policy.rolePrimary[role] ?? ''}
                  onChange={(event) => setRolePrimary(role, event.target.value)}
                  disabled={policy.selectedModelIds.length === 0}
                  style={{ fontSize: 10, padding: '6px 8px' }}
                >
                  <option value="">Use learned/global order</option>
                  {policy.selectedModelIds.map((id) => <option key={id} value={id}>{modelById.get(id)?.name ?? id}</option>)}
                </select>
              </label>
            ))}
            {!agentsQuery.isLoading && roles.length === 0 && <div style={{ fontSize: 10, color: 'var(--color-apex-muted)' }}>Agent roles are unavailable; the global chain can still be configured.</div>}
          </div>
        </div>
      </div>

      <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', lineHeight: 1.5 }}>
        {catalogQuery.data?.efficiencyMethod ?? 'Efficiency is a cost/capability/context heuristic.'}
        {catalogQuery.data?.pricingUpdatedAt && <> Live catalog refreshed {new Date(catalogQuery.data.pricingUpdatedAt).toLocaleString()}.</>}
      </div>

      {(saveMutation.error || resetMutation.error) && (
        <div style={{ color: '#c45c66', fontSize: 11 }}>{((saveMutation.error ?? resetMutation.error) as Error).message}</div>
      )}
      {savedMessage && <div style={{ color: '#6a9f78', fontSize: 11, display: 'flex', alignItems: 'center', gap: 5 }}><Check size={13} /> {savedMessage}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn-primary"
          onClick={() => saveMutation.mutate()}
          disabled={policy.selectedModelIds.length === 0 || saveMutation.isPending}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <Save size={13} /> {saveMutation.isPending ? 'Saving…' : `Save routing (${policy.selectedModelIds.length} models)`}
        </button>
        <button
          className="btn-secondary"
          onClick={() => resetMutation.mutate()}
          disabled={resetMutation.isPending}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <RotateCcw size={13} /> Reset to reviewed defaults
        </button>
      </div>

      <style>{`@media (max-width: 760px) { .model-routing-grid { grid-template-columns: 1fr !important; } }`}</style>
    </section>
  );
}
