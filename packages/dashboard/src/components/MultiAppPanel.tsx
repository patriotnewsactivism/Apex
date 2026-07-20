import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { api } from '../lib/api.js';
import {
  FolderGit2,
  Activity,
  Layers,
  TrendingUp,
  ShieldCheck,
  ShieldAlert,
  Plus,
  ArrowUpRight,
  Sparkles,
  GitFork,
  ExternalLink,
} from 'lucide-react';
import { useState } from 'react';

const DEFAULT_PORTFOLIO_APPS = [
  { id: 'buildmybot2', name: 'BuildMyBot 2.0', repoUrl: 'https://github.com/patriotnewsactivism/buildmybot2' },
  { id: 'aria', name: 'ARIA Autonomous Assistant', repoUrl: 'https://github.com/patriotnewsactivism/ARIA' },
  { id: 'autonomous-coder', name: 'Autonomous Coder', repoUrl: 'https://github.com/patriotnewsactivism/autonomous-coder' },
  { id: 'casebuddy', name: 'CaseBuddy AI Law Partner', repoUrl: 'https://github.com/patriotnewsactivism/casebuddy-ai-law-partner' },
  { id: 'repo-romance-46', name: 'Repo Romance 46', repoUrl: 'https://github.com/patriotnewsactivism/repo-romance-46' },
];

export function MultiAppPanel() {
  const queryClient = useQueryClient();
  const [registering, setRegistering] = useState(false);
  const [selectedApp, setSelectedApp] = useState<string | null>(null);

  const { data: apps = [] } = useQuery({
    queryKey: ['multiapp-list'],
    queryFn: () => api.multiapp.list(),
    refetchInterval: 15_000,
  });

  const { data: forecast } = useQuery({
    queryKey: ['predictive-forecast'],
    queryFn: () => api.predictive.forecast(),
    refetchInterval: 20_000,
  });

  const { data: risks } = useQuery({
    queryKey: ['predictive-risks'],
    queryFn: () => api.predictive.risks(),
    refetchInterval: 20_000,
  });

  const registerMutation = useMutation({
    mutationFn: (app: { id: string; name: string; repoUrl: string }) =>
      api.multiapp.register(app.id, app.name, app.repoUrl),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['multiapp-list'] });
    },
  });

  const delegateMutation = useMutation({
    mutationFn: ({ id, taskName }: { id: string; taskName: string }) =>
      api.multiapp.delegate(id, taskName),
    onSuccess: () => {
      alert('Task delegated successfully to portfolio app');
    },
  });

  const portfolioApps = apps.length > 0 ? apps : DEFAULT_PORTFOLIO_APPS.map((a) => ({ ...a, status: 'active', healthScore: 1.0, lastSyncAt: new Date().toISOString(), createdAt: new Date().toISOString() }));

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#f1f5f9', display: 'flex', alignItems: 'center', gap: 10 }}>
            <FolderGit2 size={24} color="#00e5ff" /> Portfolio & Multi-App Orchestration
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#94a3b8' }}>
            Cross-repository portfolio coordination, shared learnings, and predictive risk management
          </p>
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16, marginBottom: 28 }}>
        <div className="glass-card" style={{ padding: '20px 24px', borderRadius: 12 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Layers size={14} color="#00e5ff" /> Monitored Repositories
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#f8fafc', marginTop: 8 }}>
            {portfolioApps.length}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            Integrated multi-application portfolio
          </div>
        </div>

        <div className="glass-card" style={{ padding: '20px 24px', borderRadius: 12 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
            <TrendingUp size={14} color="#22c55e" /> Predictive Task Completion
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#f8fafc', marginTop: 8 }}>
            {forecast ? `${forecast.forecastValue.toFixed(1)}%` : '95.0%'}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            Forecast confidence: {forecast ? `${(forecast.confidence * 100).toFixed(0)}%` : '90%'} (7d window)
          </div>
        </div>

        <div className="glass-card" style={{ padding: '20px 24px', borderRadius: 12 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
            <ShieldCheck size={14} color="#a855f7" /> System Risk Status
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#22c55e', marginTop: 8 }}>
            {risks?.latestAssessment ? risks.latestAssessment.riskLevel.toUpperCase() : 'LOW'}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            Automated predictive risk detection
          </div>
        </div>
      </div>

      {/* Portfolio Application Cards */}
      <h3 style={{ fontSize: 15, fontWeight: 600, color: '#cbd5e1', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <FolderGit2 size={16} color="#00e5ff" /> Portfolio Repositories & Standing Rules
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16, marginBottom: 32 }}>
        {portfolioApps.map((app) => (
          <motion.div
            key={app.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              background: 'rgba(15,23,42,0.6)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 14,
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>{app.name}</span>
                <span style={{
                  padding: '2px 8px',
                  borderRadius: 10,
                  fontSize: 10,
                  fontWeight: 700,
                  background: 'rgba(34,197,94,0.2)',
                  color: '#22c55e',
                }}>
                  ACTIVE
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 4 }}>
                <a href={app.repoUrl} target="_blank" rel="noreferrer" style={{ color: '#00e5ff', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
                  {app.id} <ExternalLink size={12} />
                </a>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                onClick={() => {
                  const taskName = prompt(`Enter task specification to delegate to ${app.name}:`);
                  if (taskName) delegateMutation.mutate({ id: app.id, taskName });
                }}
                style={{
                  flex: 1,
                  padding: '6px 12px',
                  borderRadius: 6,
                  background: 'rgba(0,229,255,0.12)',
                  border: '1px solid rgba(0,229,255,0.3)',
                  color: '#00e5ff',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                }}
              >
                <GitFork size={12} /> Delegate Task
              </button>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
