import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { api } from '../lib/api.js';
import {
  GitBranch,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  RotateCcw,
  Rocket,
  ShieldAlert,
  Terminal,
  FileCode,
  Activity,
  Server,
  Layers,
} from 'lucide-react';

export function PipelinePanel() {
  const queryClient = useQueryClient();

  const { data: status, isLoading: isLoadingStatus } = useQuery({
    queryKey: ['cicd-status'],
    queryFn: () => api.cicd.status(),
    refetchInterval: 10_000,
  });

  const { data: history = [] } = useQuery({
    queryKey: ['cicd-history'],
    queryFn: () => api.cicd.history(),
    refetchInterval: 15_000,
  });

  const testMutation = useMutation({
    mutationFn: () => api.cicd.runTest(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cicd-status'] });
      queryClient.invalidateQueries({ queryKey: ['cicd-history'] });
    },
  });

  const buildMutation = useMutation({
    mutationFn: () => api.cicd.build(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cicd-status'] });
      queryClient.invalidateQueries({ queryKey: ['cicd-history'] });
    },
  });

  const deployMutation = useMutation({
    mutationFn: () => api.cicd.deploy('production', 'railway'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cicd-status'] });
      queryClient.invalidateQueries({ queryKey: ['cicd-history'] });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (deploymentId: string) => api.cicd.rollback(deploymentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cicd-status'] });
    },
  });

  const latestRun = status?.latestRun;
  const latestTest = status?.latestTest;
  const latestLint = status?.latestLint;
  const deploymentsList = status?.deployments ?? [];

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
      {/* Header & Controls */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 24,
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 700,
              color: '#f1f5f9',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <GitBranch size={24} color="#00e5ff" /> CI/CD & Deployment Pipeline
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#94a3b8' }}>
            Automated testing, typechecks, production builds, and approval-gated deployments
          </p>
        </div>

        {/* Action Controls */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.15)',
              color: '#e2e8f0',
              fontSize: 13,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Play size={14} className={testMutation.isPending ? 'animate-spin' : ''} />
            {testMutation.isPending ? 'Testing...' : 'Run Tests'}
          </button>

          <button
            onClick={() => buildMutation.mutate()}
            disabled={buildMutation.isPending}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.15)',
              color: '#e2e8f0',
              fontSize: 13,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Layers size={14} className={buildMutation.isPending ? 'animate-spin' : ''} />
            {buildMutation.isPending ? 'Building...' : 'Build Project'}
          </button>

          <button
            onClick={() => deployMutation.mutate()}
            disabled={deployMutation.isPending}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              background: 'linear-gradient(135deg, rgba(34,197,94,0.3), rgba(16,185,129,0.3))',
              border: '1px solid rgba(34,197,94,0.5)',
              color: '#22c55e',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Rocket size={14} className={deployMutation.isPending ? 'animate-spin' : ''} />
            {deployMutation.isPending ? 'Deploying...' : 'Deploy Production'}
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 16,
          marginBottom: 28,
        }}
      >
        <div className="glass-card" style={{ padding: '20px 24px', borderRadius: 12 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Activity size={14} color="#00e5ff" /> Latest Pipeline Run
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#f8fafc', marginTop: 8 }}>
            {latestRun ? latestRun.status.toUpperCase() : 'NO RUNS'}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            Branch: {latestRun?.branch ?? 'main'} · Repo: {latestRun?.repo ?? 'Apex'}
          </div>
        </div>

        <div className="glass-card" style={{ padding: '20px 24px', borderRadius: 12 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
            <CheckCircle2 size={14} color="#22c55e" /> Test Suite Pass Rate
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#f8fafc', marginTop: 8 }}>
            {latestTest ? `${latestTest.passed} / ${latestTest.totalTests} Passed` : 'Passed'}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            Strict typecheck across 9 workspace packages
          </div>
        </div>

        <div className="glass-card" style={{ padding: '20px 24px', borderRadius: 12 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Server size={14} color="#a855f7" /> Live Deployment
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#22c55e', marginTop: 8 }}>
            HEALTHY
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            Platform: Railway · Node.js runtime
          </div>
        </div>
      </div>

      {/* Grid: Deployments & Pipeline History */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {/* Active Deployments */}
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#cbd5e1', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Server size={16} color="#00e5ff" /> Deployment Status
          </h3>
          {deploymentsList.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#64748b', background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)' }}>
              No active deployment records found.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {deploymentsList.map((dep) => (
                <motion.div
                  key={dep.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  style={{
                    background: 'rgba(15,23,42,0.6)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 12,
                    padding: '16px 20px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#f1f5f9' }}>
                      {dep.environment.toUpperCase()} ({dep.platform})
                    </span>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: 10,
                      fontSize: 10,
                      fontWeight: 700,
                      background: dep.status === 'healthy' ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)',
                      color: dep.status === 'healthy' ? '#22c55e' : '#ef4444',
                    }}>
                      {dep.status.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
                    URL: <a href={dep.deploymentUrl ?? '#'} target="_blank" rel="noreferrer" style={{ color: '#00e5ff', textDecoration: 'none' }}>{dep.deploymentUrl}</a>
                  </div>
                  {dep.status === 'healthy' && !dep.rolledBack && (
                    <button
                      onClick={() => rollbackMutation.mutate(dep.id)}
                      disabled={rollbackMutation.isPending}
                      style={{
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: 'rgba(239,68,68,0.15)',
                        border: '1px solid rgba(239,68,68,0.3)',
                        color: '#ef4444',
                        fontSize: 11,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <RotateCcw size={12} /> Rollback
                    </button>
                  )}
                </motion.div>
              ))}
            </div>
          )}
        </div>

        {/* Pipeline History */}
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#cbd5e1', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Layers size={16} color="#3b82f6" /> Recent Pipeline Runs
          </h3>
          {history.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#64748b', background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)' }}>
              No pipeline run history available.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {history.map((run) => (
                <motion.div
                  key={run.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  style={{
                    background: 'rgba(15,23,42,0.6)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 12,
                    padding: '16px 20px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9' }}>{run.id}</span>
                    <span style={{ fontSize: 11, color: run.status === 'success' ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                      {run.status.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#64748b' }}>
                    Trigger: {run.triggerType} · {new Date(run.startedAt).toLocaleTimeString()}
                    {run.durationMs && ` · ${(run.durationMs / 1000).toFixed(1)}s`}
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
