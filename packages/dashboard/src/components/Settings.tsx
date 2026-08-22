import { useState } from 'react';
import { motion } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import {
  Check,
  ChevronRight,
  Copy,
  Cpu,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  GitBranch,
  Globe,
  Phone,
  Shield,
  Webhook,
  Zap,
} from 'lucide-react';
import {
  settingsApi,
  type IntegrationCatalogItem,
  type IntegrationProbeResult,
} from '../lib/settingsApi.js';

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  ai: { label: 'AI Models', color: '#8b7ec8' },
  search: { label: 'Search & Lead Data', color: '#5a9eae' },
  voice: { label: 'Voice & Communications', color: '#c9a84a' },
  dev: { label: 'Development', color: '#6a9f78' },
  data: { label: 'Managed Projects & Data', color: '#6d8fc2' },
  business: { label: 'Business & Payments', color: '#b978a6' },
};

const CATEGORY_ORDER = ['ai', 'search', 'voice', 'dev', 'data', 'business'];

function integrationIcon(integration: IntegrationCatalogItem) {
  switch (integration.category) {
    case 'search':
      return <Globe size={18} />;
    case 'voice':
      return <Phone size={18} />;
    case 'dev':
      return <GitBranch size={18} />;
    case 'data':
      return <Database size={18} />;
    case 'business':
      return <Zap size={18} />;
    default:
      return <Cpu size={18} />;
  }
}

function probeColor(status: IntegrationProbeResult['status']) {
  switch (status) {
    case 'connected':
      return '#6a9f78';
    case 'configured':
      return '#5a9eae';
    case 'rate_limited':
      return '#c9a84a';
    case 'billing_required':
    case 'invalid_key':
      return '#c45c66';
    default:
      return '#b978a6';
  }
}

function IntegrationCard({
  integration,
  onChanged,
}: {
  integration: IntegrationCatalogItem;
  onChanged: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, IntegrationProbeResult>>({});
  const [probingKey, setProbingKey] = useState<string | null>(null);
  const [clearingKey, setClearingKey] = useState<string | null>(null);

  const cat = CATEGORY_LABELS[integration.category] ?? {
    label: integration.category,
    color: '#5a9eae',
  };
  const hasConfigured = integration.envVars.some((envVar) => envVar.configured);
  const hasEnteredValue = integration.envVars.some((envVar) => Boolean(values[envVar.key]?.trim()));

  const saveMutation = useMutation({
    mutationFn: async () => {
      const entries = integration.envVars
        .map((envVar) => [envVar.key, values[envVar.key]?.trim()] as const)
        .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));

      if (entries.length === 0) {
        throw new Error('Enter at least one value before saving.');
      }

      const results: Record<string, IntegrationProbeResult> = {};
      for (const [key, value] of entries) {
        await settingsApi.save(key, value);
        results[key] = await settingsApi.probe(key);
      }
      return results;
    },
    onSuccess: (results) => {
      setSaveError(null);
      setProbeResults((previous) => ({ ...previous, ...results }));
      setSaved(true);
      setValues({});
      onChanged();
      setTimeout(() => setSaved(false), 2500);
    },
    onError: (err: Error) => setSaveError(err.message),
  });

  const handleProbe = async (key: string) => {
    setProbingKey(key);
    setSaveError(null);
    try {
      const result = await settingsApi.probe(key);
      setProbeResults((previous) => ({ ...previous, [key]: result }));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbingKey(null);
    }
  };

  const handleClear = async (key: string) => {
    setClearingKey(key);
    setSaveError(null);
    try {
      await settingsApi.clear(key);
      setProbeResults((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
      onChanged();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearingKey(null);
    }
  };

  return (
    <motion.div className="glass-card" style={{ overflow: 'hidden' }} initial={false}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--color-apex-text)',
          fontFamily: 'var(--font-sans)',
          textAlign: 'left',
        }}
      >
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: `${cat.color}15`,
            border: `1px solid ${cat.color}30`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: cat.color,
            flexShrink: 0,
          }}
        >
          {integrationIcon(integration)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            {integration.name}
            {hasConfigured && (
              <span
                style={{
                  fontSize: 9,
                  padding: '1px 6px',
                  borderRadius: 3,
                  background: 'rgba(106,159,120,0.1)',
                  color: '#6a9f78',
                  fontWeight: 600,
                }}
              >
                CONFIGURED
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginTop: 2 }}>
            {integration.description}
          </div>
        </div>
        <ChevronRight
          size={16}
          style={{
            color: 'var(--color-apex-muted)',
            transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s',
            flexShrink: 0,
          }}
        />
      </button>

      {isOpen && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          style={{ padding: '0 16px 16px', borderTop: '1px solid rgba(255,255,255,0.04)' }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
            {integration.envVars.map((envVar) => {
              const show = showSecrets[envVar.key];
              const probeResult = probeResults[envVar.key];
              return (
                <div key={envVar.key}>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      fontSize: 10,
                      color: 'var(--color-apex-muted)',
                      marginBottom: 4,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                    }}
                  >
                    <span>{envVar.label}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', opacity: 0.5 }}>{envVar.key}</span>
                  </label>

                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      className="apex-input"
                      type={envVar.secret && !show ? 'password' : 'text'}
                      placeholder={envVar.configured ? '••••••••  (saved)' : envVar.placeholder}
                      value={values[envVar.key] || ''}
                      onChange={(e) => setValues((previous) => ({ ...previous, [envVar.key]: e.target.value }))}
                      style={{ flex: 1 }}
                    />
                    {envVar.secret && (
                      <button
                        onClick={() => setShowSecrets((previous) => ({ ...previous, [envVar.key]: !previous[envVar.key] }))}
                        style={{
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid var(--color-apex-border)',
                          borderRadius: 8,
                          padding: '0 10px',
                          cursor: 'pointer',
                          color: 'var(--color-apex-muted)',
                          display: 'flex',
                          alignItems: 'center',
                        }}
                        aria-label={show ? 'Hide secret' : 'Show secret'}
                      >
                        {show ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    )}
                  </div>

                  {envVar.configured && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                      <button
                        className="btn-secondary"
                        onClick={() => handleProbe(envVar.key)}
                        disabled={probingKey === envVar.key}
                        style={{ fontSize: 10, padding: '5px 9px' }}
                      >
                        {probingKey === envVar.key ? 'Testing…' : envVar.probeable ? 'Test connection' : 'Check status'}
                      </button>
                      <button
                        className="btn-secondary"
                        onClick={() => handleClear(envVar.key)}
                        disabled={clearingKey === envVar.key}
                        style={{ fontSize: 10, padding: '5px 9px' }}
                      >
                        {clearingKey === envVar.key ? 'Clearing…' : 'Clear'}
                      </button>
                      {probeResult && (
                        <span style={{ fontSize: 10, color: probeColor(probeResult.status) }}>
                          {probeResult.status.toUpperCase().replace('_', ' ')} — {probeResult.detail}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {saveError && (
              <div style={{ fontSize: 11, color: '#c45c66' }}>Save/test failed: {saveError}</div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn-primary"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending || !hasEnteredValue}
                style={{
                  fontSize: 12,
                  padding: '8px 16px',
                  opacity: saveMutation.isPending || !hasEnteredValue ? 0.55 : 1,
                }}
              >
                {saved ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Check size={14} /> Saved & checked
                  </span>
                ) : saveMutation.isPending ? 'Saving & testing…' : 'Save'}
              </button>
              {integration.docsUrl && (
                <a
                  href={integration.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary"
                  style={{
                    fontSize: 12,
                    padding: '8px 16px',
                    textDecoration: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  Docs <ExternalLink size={12} />
                </a>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}

export function Settings() {
  const queryClient = useQueryClient();

  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents.list(),
  });

  const { data: tools = [] } = useQuery({
    queryKey: ['tools'],
    queryFn: () => api.tools.list(),
  });

  const { data: systemSettings } = useQuery({
    queryKey: ['system-settings'],
    queryFn: () => api.system.get(),
  });
  const autonomyLevel = systemSettings?.settings?.autonomy_level ?? 'balanced';

  const autonomyMutation = useMutation({
    mutationFn: (level: string) => api.system.update({ autonomy_level: level }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-settings'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const {
    data: integrationData,
    isLoading: integrationsLoading,
    error: integrationsError,
  } = useQuery({
    queryKey: ['settings', 'integrations', 'catalog'],
    queryFn: () => settingsApi.list(),
  });
  const integrations = integrationData?.catalog ?? [];
  const configuredCount = integrations.filter((integration) =>
    integration.envVars.some((envVar) => envVar.configured)
  ).length;

  const refreshIntegrations = () => {
    queryClient.invalidateQueries({ queryKey: ['settings', 'integrations', 'catalog'] });
    queryClient.invalidateQueries({ queryKey: ['settings', 'integrations'] });
  };

  const recoverMutation = useMutation({
    mutationFn: () => settingsApi.recoverWorkforce(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['logs'] });
    },
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Autonomy level */}
      <div
        style={{
          background: 'var(--color-apex-card)',
          border: '1px solid rgba(90,158,174,0.15)',
          borderRadius: 12,
          padding: 20,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Shield size={20} color="#5a9eae" />
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-apex-text)' }}>Autonomy Level</span>
        </div>
        <p style={{ fontSize: 12, color: 'var(--color-apex-muted)', margin: '0 0 16px', lineHeight: 1.4 }}>
          Controls how aggressively APEX operates. This changes the CEO goal-review cadence without bypassing approval gates.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {([
            { value: 'conservative', label: 'Conservative', desc: '30 min reviews' },
            { value: 'balanced', label: 'Balanced', desc: '15 min reviews' },
            { value: 'aggressive', label: 'Aggressive', desc: '10 min reviews' },
          ] as const).map((option) => {
            const active = autonomyLevel === option.value;
            return (
              <button
                key={option.value}
                onClick={() => autonomyMutation.mutate(option.value)}
                style={{
                  flex: '1 1 0',
                  minWidth: 120,
                  minHeight: 56,
                  background: active ? 'rgba(90,158,174,0.12)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${active ? 'rgba(90,158,174,0.4)' : 'rgba(255,255,255,0.08)'}`,
                  borderRadius: 10,
                  padding: '10px 14px',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  alignItems: 'center',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: active ? 700 : 500, color: active ? 'var(--color-apex-cyan)' : 'var(--color-apex-text)' }}>
                  {option.label}
                </span>
                <span style={{ fontSize: 10, color: 'var(--color-apex-muted)' }}>{option.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Provider recovery */}
      <div className="glass-card" style={{ padding: 16, border: '1px solid rgba(196,92,102,0.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Zap size={17} color="#c9a84a" />
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-apex-text)' }}>Workforce Recovery</span>
        </div>
        <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--color-apex-muted)', marginBottom: 10 }}>
          After restoring an LLM key, quota, or billing, requeue only tasks that failed because the provider chain was exhausted. APEX releases at most 25 tasks per click so a restored account is not immediately stampede-loaded.
        </div>
        <button
          className="btn-secondary"
          onClick={() => recoverMutation.mutate()}
          disabled={recoverMutation.isPending}
          style={{ fontSize: 12, padding: '8px 14px' }}
        >
          {recoverMutation.isPending ? 'Recovering…' : 'Recover provider failures'}
        </button>
        {recoverMutation.isSuccess && (
          <div style={{ fontSize: 11, color: '#6a9f78', marginTop: 8 }}>
            Requeued {recoverMutation.data.recoveredTasks} task(s); reset {recoverMutation.data.resetAgentRows} agent row(s).
            {recoverMutation.data.skippedTasks > 0 ? ` ${recoverMutation.data.skippedTasks} more matching task(s) remain for a later batch.` : ''}
            {' '}{recoverMutation.data.note}
          </div>
        )}
        {recoverMutation.isError && (
          <div style={{ fontSize: 11, color: '#c45c66', marginTop: 8 }}>
            Recovery failed: {recoverMutation.error.message}
          </div>
        )}
      </div>

      {/* System overview */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        {[
          { label: 'Agents', value: agents.length, color: '#8b7ec8', icon: <Cpu size={14} /> },
          { label: 'Tools', value: tools.length, color: '#5a9eae', icon: <Zap size={14} /> },
          { label: 'Configured', value: configuredCount, color: '#6a9f78', icon: <Check size={14} /> },
          { label: 'Missing', value: Math.max(0, integrations.length - configuredCount), color: '#c45c66', icon: <Shield size={14} /> },
        ].map((stat) => (
          <div key={stat.label} className="glass-card" style={{ padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: stat.color, marginBottom: 4 }}>
              {stat.icon}
              <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>{stat.label}</span>
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, color: stat.color, fontFamily: 'var(--font-mono)' }}>
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      {/* Webhook config */}
      <div className="glass-card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, color: 'var(--color-apex-cyan)' }}>
          <Webhook size={16} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>Inbound Webhook</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-apex-muted)', marginBottom: 10 }}>
          POST goals to APEX from external services.
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            background: 'rgba(255,255,255,0.03)',
            borderRadius: 8,
            border: '1px solid var(--color-apex-border)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--color-apex-text)',
            overflowX: 'auto',
          }}
        >
          <code style={{ flex: 1, whiteSpace: 'nowrap' }}>POST {window.location.origin}/api/goals</code>
          <button
            onClick={() => navigator.clipboard.writeText(`${window.location.origin}/api/goals`)}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-apex-muted)', padding: 4 }}
          >
            <Copy size={14} />
          </button>
        </div>
      </div>

      {/* Integrations */}
      {integrationsLoading && (
        <div className="glass-card" style={{ padding: 16, color: 'var(--color-apex-muted)', fontSize: 12 }}>
          Loading the live backend integration catalog…
        </div>
      )}
      {integrationsError && (
        <div className="glass-card" style={{ padding: 16, color: '#c45c66', fontSize: 12 }}>
          Could not load integrations: {integrationsError.message}
        </div>
      )}

      {CATEGORY_ORDER.map((category) => {
        const categoryIntegrations = integrations.filter((integration) => integration.category === category);
        if (categoryIntegrations.length === 0) return null;
        const categoryInfo = CATEGORY_LABELS[category] ?? { label: category, color: '#5a9eae' };
        return (
          <div key={category}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: categoryInfo.color }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-apex-text)' }}>{categoryInfo.label}</span>
              <span style={{ fontSize: 10, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
                ({categoryIntegrations.length})
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {categoryIntegrations.map((integration) => (
                <IntegrationCard
                  key={integration.id}
                  integration={integration}
                  onChanged={refreshIntegrations}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* Available tools */}
      {tools.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#5a9eae' }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-apex-text)' }}>Available Tools</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
            {tools.map((tool) => (
              <div key={tool.name} className="glass-card" style={{ padding: '10px 14px' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-apex-text)', marginBottom: 4 }}>
                  {tool.name}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', lineHeight: 1.4 }}>{tool.description}</div>
                {tool.requiresApproval && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 9,
                      padding: '1px 6px',
                      borderRadius: 3,
                      background: 'rgba(255,216,10,0.1)',
                      color: '#c9a84a',
                      fontWeight: 600,
                      display: 'inline-block',
                    }}
                  >
                    REQUIRES APPROVAL
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
