import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import type { IntegrationCatalogEntry, IntegrationProbeResult } from '../lib/api.js';
import {
  Cpu,
  Webhook,
  ExternalLink,
  Check,
  Copy,
  Eye,
  EyeOff,
  Mail,
  MessageSquare,
  Phone,
  GitBranch,
  Database,
  Shield,
  Zap,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';

// ─── Category map ─────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  ai: { label: 'AI Models', color: '#8b7ec8' },
  comms: { label: 'Communications', color: '#5a9eae' },
  dev: { label: 'Development', color: '#6a9f78' },
  data: { label: 'Data & Storage', color: '#c9a84a' },
};

function categoryIcon(category: string) {
  switch (category) {
    case 'ai':
      return <Cpu size={18} />;
    case 'comms':
      return <MessageSquare size={18} />;
    case 'dev':
      return <GitBranch size={18} />;
    case 'data':
      return <Database size={18} />;
    default:
      return <Zap size={18} />;
  }
}

function enrichCategoryIcon(integration: IntegrationCatalogEntry) {
  // Per-identity icons for a few well-known integrations; category fallback otherwise.
  switch (integration.id) {
    case 'vapi':
      return <Phone size={18} />;
    case 'github':
      return <GitBranch size={18} />;
    case 'stripe':
      return <Shield size={18} />;
    case 'resend':
      return <Mail size={18} />;
    case 'slack':
      return <MessageSquare size={18} />;
    default:
      return categoryIcon(integration.category);
  }
}

const PROBE_META: Record<IntegrationProbeResult['status'], { label: string; color: string }> = {
  connected: { label: 'Connected', color: '#6a9f78' },
  rate_limited: { label: 'Rate Limited', color: '#c9a84a' },
  invalid_key: { label: 'Invalid Key', color: '#c45c66' },
  billing_required: { label: 'Billing Required', color: '#c45c66' },
  error: { label: 'Probe Failed', color: '#c45c66' },
  not_probed: { label: 'Saved', color: '#6a9f78' },
};

// ─── Integration card ─────────────────────────────────────────────────────────

function IntegrationCard({
  integration,
  onChanged,
}: {
  integration: IntegrationCatalogEntry;
  onChanged: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, IntegrationProbeResult>>({});

  const cat = CATEGORY_LABELS[integration.category];
  const disabled = integration.state !== 'active';

  const saveMutation = useMutation({
    mutationFn: async () => {
      const entries = Object.entries(values).filter(([, v]) => v);
      const results: Record<string, IntegrationProbeResult> = {};
      for (const [key, val] of entries) {
        const r = await api.settings.saveIntegration(key, val);
        if (r.probe) results[key] = r.probe;
      }
      return results;
    },
    onSuccess: (results) => {
      setSaveError(null);
      setProbes(results);
      setSaved(true);
      setValues({});
      onChanged();
      setTimeout(() => setSaved(false), 2000);
    },
    onError: (err: Error) => setSaveError(err.message),
  });

  const hasValues = integration.envVars.some((v) => v.configured || values[v.key]);

  return (
    <motion.div
      className="glass-card"
      style={{ overflow: 'hidden', opacity: disabled ? 0.55 : 1 }}
      initial={false}
    >
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
          {enrichCategoryIcon(integration)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {integration.name}
            {disabled ? (
              <span
                style={{
                  fontSize: 9,
                  padding: '1px 6px',
                  borderRadius: 3,
                  background: 'rgba(255,255,255,0.06)',
                  color: 'var(--color-apex-muted)',
                  fontWeight: 600,
                }}
              >
                NOT WIRED
              </span>
            ) : (
              hasValues && (
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
              )
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginTop: 2 }}>
            {disabled && integration.stateReason ? integration.stateReason : integration.description}
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
              const storedVal = envVar.configured ? '(configured)' : null;
              const isSecret = envVar.secret;
              const show = showSecrets[envVar.key];
              const probe = probes[envVar.key];
              const probeMeta = probe ? PROBE_META[probe.status] : undefined;

              return (
                <div key={envVar.key}>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
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
                      type={isSecret && !show ? 'password' : 'text'}
                      placeholder={storedVal ? '••••••••  (saved)' : envVar.placeholder}
                      value={values[envVar.key] || ''}
                      onChange={(e) => setValues((prev) => ({ ...prev, [envVar.key]: e.target.value }))}
                      disabled={disabled}
                      style={{ flex: 1 }}
                    />
                    {isSecret && (
                      <button
                        onClick={() =>
                          setShowSecrets((prev) => ({ ...prev, [envVar.key]: !prev[envVar.key] }))
                        }
                        style={{
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid var(--color-apex-border)',
                          borderRadius: 8,
                          padding: '0 10px',
                          cursor: 'pointer',
                          color: 'var(--color-apex-muted)',
                          display: 'flex',
                          alignItems: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {show ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    )}
                  </div>
                  {probeMeta && (
                    <div style={{ fontSize: 11, color: probeMeta.color, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Check size={11} /> {probeMeta.label}
                      {probe?.detail && (
                        <span style={{ opacity: 0.7 }}>— {probe.detail.slice(0, 120)}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              {saveError && (
                <div style={{ fontSize: 11, color: '#c45c66' }}>Save failed: {saveError}</div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn-primary"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending || disabled}
                  title={disabled ? integration.stateReason : undefined}
                  style={{
                    fontSize: 12,
                    padding: '8px 16px',
                    opacity: saveMutation.isPending || disabled ? 0.6 : 1,
                  }}
                >
                  {saved ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Check size={14} /> Saved
                    </span>
                  ) : saveMutation.isPending ? (
                    'Saving…'
                  ) : (
                    'Save'
                  )}
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
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}

// ─── Settings screen ──────────────────────────────────────────────────────────

export function Settings() {
  const queryClient = useQueryClient();

  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents.list(),
  });

  // System settings (autonomy level)
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

  const { data: tools = [] } = useQuery({
    queryKey: ['tools'],
    queryFn: () => api.tools.list(),
  });

  // The backend integration catalog — the single source of truth for what
  // APEX supports. No hard-coded provider list lives in this component.
  const { data: catalog = [] } = useQuery({
    queryKey: ['settings', 'integration-catalog'],
    queryFn: () => api.settings.listIntegrationCatalog(),
  });
  const refetchCatalog = () => queryClient.invalidateQueries({ queryKey: ['settings', 'integration-catalog'] });

  const recoverMutation = useMutation({
    mutationFn: () => api.settings.recoverWorkforce(),
  });

  const categories = ['ai', 'comms', 'dev', 'data'] as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Autonomy Level */}
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
          Controls how aggressively APEX operates. Adjusts the CEO's goal review frequency and overall system throughput.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {([
            { value: 'conservative', label: 'Conservative', desc: '30 min reviews' },
            { value: 'balanced', label: 'Balanced', desc: '15 min reviews' },
            { value: 'aggressive', label: 'Aggressive', desc: '10 min reviews' },
          ] as const).map((opt) => {
            const isActive = autonomyLevel === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => autonomyMutation.mutate(opt.value)}
                style={{
                  flex: '1 1 0',
                  minWidth: 120,
                  minHeight: 56,
                  background: isActive ? 'rgba(90,158,174,0.12)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${isActive ? 'rgba(90,158,174,0.4)' : 'rgba(255,255,255,0.08)'}`,
                  borderRadius: 10,
                  padding: '10px 14px',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  alignItems: 'center',
                  transition: 'all 0.15s',
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: isActive ? 700 : 500,
                    color: isActive ? 'var(--color-apex-cyan)' : 'var(--color-apex-text)',
                  }}
                >
                  {opt.label}
                </span>
                <span style={{ fontSize: 10, color: 'var(--color-apex-muted)' }}>{opt.desc}</span>
              </button>
            );
          })}
        </div>
        {autonomyMutation.isSuccess && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--color-apex-green)',
              marginTop: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Check size={12} /> Applied — goal review cadence updated
          </div>
        )}
      </div>

      {/* Recover Workforce */}
      <div
        className="glass-card"
        style={{
          padding: 16,
          border: '1px solid rgba(201,168,74,0.25)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <RefreshCw size={16} color="#c9a84a" />
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-apex-text)' }}>Recover Workforce</span>
        </div>
        <p style={{ fontSize: 12, color: 'var(--color-apex-muted)', margin: '0 0 12px', lineHeight: 1.4 }}>
          When LLM providers run out of quota or are billing-blocked, APEX fails tasks with "All LLM providers
          failed" and affected agents turn red (ERROR). After you've saved/restored working keys above, run this
          to requeue those tasks and reset the affected agents.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="btn-primary"
            onClick={() => recoverMutation.mutate()}
            disabled={recoverMutation.isPending}
            style={{ fontSize: 12, padding: '8px 16px', opacity: recoverMutation.isPending ? 0.6 : 1 }}
          >
            {recoverMutation.isPending ? 'Recovering…' : 'Recover Workforce'}
          </button>
          {recoverMutation.isSuccess && recoverMutation.data && (
            <span style={{ fontSize: 11, color: '#6a9f78', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Check size={12} /> {recoverMutation.data.requeuedTasks} task(s) requeued, {recoverMutation.data.resetAgents} agent(s) reset
            </span>
          )}
          {recoverMutation.isError && (
            <span style={{ fontSize: 11, color: '#c45c66' }}>
              {(recoverMutation.error as Error).message}
            </span>
          )}
        </div>
      </div>

      {/* System overview */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        {[
          { label: 'Agents', value: agents.length, color: '#8b7ec8', icon: <Cpu size={14} /> },
          { label: 'Tools', value: tools.length, color: '#5a9eae', icon: <Zap size={14} /> },
          {
            label: 'Configured',
            value: catalog.filter((i) => i.state === 'active' && i.envVars.some((v) => v.configured)).length,
            color: '#6a9f78',
            icon: <Check size={14} />,
          },
          {
            label: 'Missing',
            value: catalog.filter((i) => i.state === 'active' && !i.envVars.some((v) => v.configured)).length,
            color: '#c45c66',
            icon: <Shield size={14} />,
          },
        ].map((stat) => (
          <div key={stat.label} className="glass-card" style={{ padding: '12px 14px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: stat.color,
                marginBottom: 4,
              }}
            >
              {stat.icon}
              <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>{stat.label}</span>
            </div>
            <div
              style={{
                fontSize: 20,
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

      {/* Webhook config */}
      <div className="glass-card" style={{ padding: 16 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 12,
            color: 'var(--color-apex-cyan)',
          }}
        >
          <Webhook size={16} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>Inbound Webhook</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-apex-muted)', marginBottom: 10 }}>
          POST goals to APEX from external services (Slack, Zapier, n8n, etc.)
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
          <code style={{ flex: 1, whiteSpace: 'nowrap' }}>
            POST {window.location.origin}/api/goals
          </code>
          <button
            onClick={() => navigator.clipboard.writeText(`${window.location.origin}/api/goals`)}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--color-apex-muted)',
              padding: 4,
              flexShrink: 0,
            }}
          >
            <Copy size={14} />
          </button>
        </div>
        <div
          style={{
            marginTop: 8,
            fontSize: 11,
            color: 'var(--color-apex-muted)',
            fontFamily: 'var(--font-mono)',
            padding: '8px 12px',
            background: 'rgba(255,255,255,0.02)',
            borderRadius: 6,
            whiteSpace: 'pre',
            overflowX: 'auto',
          }}
        >
{`{
  "title": "Your goal title",
  "description": "What APEX should do",
  "priority": 5
}`}
        </div>
      </div>

      {/* Integrations by category */}
      {categories.map((cat) => {
        const catIntegrations = catalog.filter((i) => i.category === cat);
        if (catIntegrations.length === 0) return null;
        const catInfo = CATEGORY_LABELS[cat];
        return (
          <div key={cat}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: catInfo.color,
                }}
              />
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-apex-text)' }}>
                {catInfo.label}
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: 'var(--color-apex-muted)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                ({catIntegrations.length})
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {catIntegrations.map((integration) => (
                <IntegrationCard
                  key={integration.id}
                  integration={integration}
                  onChanged={refetchCatalog}
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
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-apex-text)' }}>
              Available Tools
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
            {tools.map((tool) => (
              <div
                key={tool.name}
                className="glass-card"
                style={{ padding: '10px 14px' }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-apex-text)', marginBottom: 4 }}>
                  {tool.name}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', lineHeight: 1.4 }}>
                  {tool.description}
                </div>
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