import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import {
  Settings as SettingsIcon,
  Key,
  Webhook,
  Link2,
  ExternalLink,
  Check,
  Copy,
  Eye,
  EyeOff,
  Cpu,
  Globe,
  Mail,
  MessageSquare,
  GitBranch,
  Database,
  Shield,
  Zap,
  ChevronRight,
} from 'lucide-react';

interface IntegrationConfig {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  category: 'ai' | 'comms' | 'dev' | 'data';
  envVars: { key: string; label: string; placeholder: string; secret?: boolean }[];
  docsUrl?: string;
}

const INTEGRATIONS: IntegrationConfig[] = [
  {
    id: 'groq',
    name: 'Groq',
    description: 'Ultra-fast LLM inference (free tier)',
    icon: <Zap size={18} />,
    category: 'ai',
    envVars: [{ key: 'GROQ_API_KEY', label: 'API Key', placeholder: 'gsk_...', secret: true }],
    docsUrl: 'https://console.groq.com',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    description: 'High-speed AI inference',
    icon: <Cpu size={18} />,
    category: 'ai',
    envVars: [{ key: 'CEREBRAS_API_KEY', label: 'API Key', placeholder: 'csk-...', secret: true }],
    docsUrl: 'https://cloud.cerebras.ai',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Gemini 2.5 Flash (free tier)',
    icon: <Cpu size={18} />,
    category: 'ai',
    envVars: [{ key: 'GEMINI_API_KEY', label: 'API Key', placeholder: 'AIza...', secret: true }],
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    description: 'Command R+ model for agents',
    icon: <Cpu size={18} />,
    category: 'ai',
    envVars: [
      { key: 'COHERE_TRIAL_API_KEY', label: 'Trial Key', placeholder: 'cohere_...', secret: true },
      { key: 'COHERE_API_KEY', label: 'Production Key', placeholder: 'cohere_...', secret: true },
    ],
    docsUrl: 'https://dashboard.cohere.com/api-keys',
  },
  {
    id: 'poolside',
    name: 'Poolside',
    description: 'Laguna model for code generation',
    icon: <Cpu size={18} />,
    category: 'ai',
    envVars: [{ key: 'POOLSIDE_API_KEY', label: 'API Key', placeholder: 'sky_...', secret: true }],
    docsUrl: 'https://platform.poolside.ai',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Multi-model routing (primary)',
    icon: <Globe size={18} />,
    category: 'ai',
    envVars: [{ key: 'OPENROUTER_API_KEY', label: 'API Key', placeholder: 'sk-or-...', secret: true }],
    docsUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'slack',
    name: 'Slack Webhook',
    description: 'Send notifications to Slack',
    icon: <MessageSquare size={18} />,
    category: 'comms',
    envVars: [
      { key: 'SLACK_NOTIFY_WEBHOOK', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/...' },
    ],
    docsUrl: 'https://api.slack.com/messaging/webhooks',
  },
  {
    id: 'resend',
    name: 'Resend',
    description: 'Transactional email delivery',
    icon: <Mail size={18} />,
    category: 'comms',
    envVars: [{ key: 'RESEND_API_KEY', label: 'API Key', placeholder: 're_...', secret: true }],
    docsUrl: 'https://resend.com/api-keys',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repo access for code agents',
    icon: <GitBranch size={18} />,
    category: 'dev',
    envVars: [{ key: 'GITHUB_TOKEN', label: 'Personal Access Token', placeholder: 'ghp_...', secret: true }],
    docsUrl: 'https://github.com/settings/tokens',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Database & auth backend',
    icon: <Database size={18} />,
    category: 'data',
    envVars: [
      { key: 'SUPABASE_URL', label: 'Project URL', placeholder: 'https://xxx.supabase.co' },
      { key: 'SUPABASE_SERVICE_ROLE_KEY', label: 'Service Role Key', placeholder: 'eyJ...', secret: true },
    ],
    docsUrl: 'https://supabase.com/dashboard',
  },
];

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  ai: { label: 'AI Models', color: '#b84cff' },
  comms: { label: 'Communications', color: '#00e5ff' },
  dev: { label: 'Development', color: '#00ff88' },
  data: { label: 'Data & Storage', color: '#ffd60a' },
};

function IntegrationCard({ integration }: { integration: IntegrationConfig }) {
  const [isOpen, setIsOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(false);

  const cat = CATEGORY_LABELS[integration.category];

  const handleSave = () => {
    // Save to localStorage for now — in production these would go to env vars via API
    for (const [key, val] of Object.entries(values)) {
      if (val) localStorage.setItem(`apex_env_${key}`, val);
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const hasValues = integration.envVars.some(
    (v) => values[v.key] || localStorage.getItem(`apex_env_${v.key}`)
  );

  return (
    <motion.div
      className="glass-card"
      style={{ overflow: 'hidden' }}
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
          {integration.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            {integration.name}
            {hasValues && (
              <span
                style={{
                  fontSize: 9,
                  padding: '1px 6px',
                  borderRadius: 3,
                  background: 'rgba(0,255,136,0.1)',
                  color: '#00ff88',
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
          style={{
            padding: '0 16px 16px',
            borderTop: '1px solid rgba(255,255,255,0.04)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
            {integration.envVars.map((envVar) => {
              const storedVal = localStorage.getItem(`apex_env_${envVar.key}`);
              const isSecret = envVar.secret;
              const show = showSecrets[envVar.key];

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
                </div>
              );
            })}

            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button className="btn-primary" onClick={handleSave} style={{ fontSize: 12, padding: '8px 16px' }}>
                {saved ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Check size={14} /> Saved
                  </span>
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
        </motion.div>
      )}
    </motion.div>
  );
}

export function Settings() {
  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents.list(),
  });

  const { data: tools = [] } = useQuery({
    queryKey: ['tools'],
    queryFn: () => api.tools.list(),
  });

  const categories = ['ai', 'comms', 'dev', 'data'] as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* System overview */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
        {[
          { label: 'Agents', value: agents.length, color: '#b84cff', icon: <Cpu size={14} /> },
          { label: 'Tools', value: tools.length, color: '#00e5ff', icon: <Zap size={14} /> },
          {
            label: 'Configured',
            value: INTEGRATIONS.filter((i) =>
              i.envVars.some((v) => localStorage.getItem(`apex_env_${v.key}`))
            ).length,
            color: '#00ff88',
            icon: <Check size={14} />,
          },
          {
            label: 'Missing',
            value:
              INTEGRATIONS.length -
              INTEGRATIONS.filter((i) =>
                i.envVars.some((v) => localStorage.getItem(`apex_env_${v.key}`))
              ).length,
            color: '#ff3b5c',
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
              <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
                {stat.label}
              </span>
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
        const catIntegrations = INTEGRATIONS.filter((i) => i.category === cat);
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
                <IntegrationCard key={integration.id} integration={integration} />
              ))}
            </div>
          </div>
        );
      })}

      {/* Available tools */}
      {tools.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#00e5ff' }} />
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
                      color: '#ffd60a',
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
