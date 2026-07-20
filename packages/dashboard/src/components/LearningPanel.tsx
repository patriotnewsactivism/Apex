import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { api } from '../lib/api.js';
import type { LearningInsightRow, StrategyRecommendationRow } from '../lib/api.js';
import {
  Brain,
  TrendingUp,
  Lightbulb,
  CheckCircle,
  XCircle,
  Clock,
  Sparkles,
  Zap,
  Check,
  X,
  RefreshCw,
  BarChart3,
} from 'lucide-react';

export function LearningPanel() {
  const queryClient = useQueryClient();

  const { data: outcomes = [], isLoading: isLoadingOutcomes } = useQuery({
    queryKey: ['learning-outcomes'],
    queryFn: () => api.learning.outcomes(),
    refetchInterval: 15_000,
  });

  const { data: insights = [] } = useQuery({
    queryKey: ['learning-insights'],
    queryFn: () => api.learning.insights(),
    refetchInterval: 15_000,
  });

  const { data: recommendations = [] } = useQuery({
    queryKey: ['learning-recommendations'],
    queryFn: () => api.learning.recommendations(),
    refetchInterval: 15_000,
  });

  const analyzeMutation = useMutation({
    mutationFn: () => api.learning.analyze(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['learning-insights'] });
      queryClient.invalidateQueries({ queryKey: ['learning-recommendations'] });
    },
  });

  const respondMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' }) =>
      api.learning.respondRecommendation(id, action),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['learning-recommendations'] });
    },
  });

  const totalTasks = outcomes.length;
  const successCount = outcomes.filter((o) => o.success).length;
  const successRate = totalTasks > 0 ? (successCount / totalTasks) * 100 : 100;
  const avgDurationMs =
    totalTasks > 0
      ? outcomes.reduce((sum, o) => sum + o.durationMs, 0) / totalTasks
      : 0;

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
      {/* Header & Trigger */}
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
            <Brain size={24} color="#00e5ff" /> Learning & Adaptation System
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#94a3b8' }}>
            Continuous performance tracking, automated pattern recognition, and approval-gated strategy optimization
          </p>
        </div>
        <button
          onClick={() => analyzeMutation.mutate()}
          disabled={analyzeMutation.isPending}
          style={{
            padding: '10px 18px',
            borderRadius: 8,
            background: 'linear-gradient(135deg, rgba(0,229,255,0.2), rgba(59,130,246,0.2))',
            border: '1px solid rgba(0,229,255,0.4)',
            color: '#00e5ff',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Sparkles size={16} className={analyzeMutation.isPending ? 'animate-spin' : ''} />
          {analyzeMutation.isPending ? 'Analyzing...' : 'Run Pattern Analysis'}
        </button>
      </div>

      {/* KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 16,
          marginBottom: 28,
        }}
      >
        <div className="glass-card" style={{ padding: '20px 24px', borderRadius: 12 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
            <TrendingUp size={14} color="#22c55e" /> Success Rate
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#f8fafc', marginTop: 8 }}>
            {successRate.toFixed(1)}%
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            {successCount} / {totalTasks} tasks completed successfully
          </div>
        </div>

        <div className="glass-card" style={{ padding: '20px 24px', borderRadius: 12 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Clock size={14} color="#3b82f6" /> Avg Execution Time
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#f8fafc', marginTop: 8 }}>
            {(avgDurationMs / 1000).toFixed(1)}s
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            Across {totalTasks} tracked task outcomes
          </div>
        </div>

        <div className="glass-card" style={{ padding: '20px 24px', borderRadius: 12 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Lightbulb size={14} color="#eab308" /> Active Insights
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#f8fafc', marginTop: 8 }}>
            {insights.length}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            Automated patterns & improvements
          </div>
        </div>

        <div className="glass-card" style={{ padding: '20px 24px', borderRadius: 12 }}>
          <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Zap size={14} color="#a855f7" /> Strategy Queue
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#f8fafc', marginTop: 8 }}>
            {recommendations.filter((r) => r.status === 'pending').length}
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            Pending human approval
          </div>
        </div>
      </div>

      {/* Grid for Insights & Recommendations */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {/* Learning Insights Feed */}
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#cbd5e1', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Lightbulb size={16} color="#eab308" /> Learning Insights Feed
          </h3>
          {insights.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#64748b', background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)' }}>
              No insights generated yet. Execute more tasks or click "Run Pattern Analysis" above.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {insights.map((insight) => (
                <motion.div
                  key={insight.id}
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
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#f1f5f9' }}>{insight.title}</span>
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: 10,
                      fontSize: 10,
                      fontWeight: 700,
                      background: insight.insightType === 'warning' ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.2)',
                      color: insight.insightType === 'warning' ? '#ef4444' : '#22c55e',
                    }}>
                      {(insight.confidence * 100).toFixed(0)}% confidence
                    </span>
                  </div>
                  <p style={{ margin: 0, fontSize: 12, color: '#94a3b8', lineHeight: 1.4 }}>{insight.description}</p>
                </motion.div>
              ))}
            </div>
          )}
        </div>

        {/* Strategy Recommendations Queue */}
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: '#cbd5e1', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Zap size={16} color="#a855f7" /> Strategy Recommendations (Approval Gated)
          </h3>
          {recommendations.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#64748b', background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)' }}>
              No pending strategy recommendations.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {recommendations.map((rec) => (
                <motion.div
                  key={rec.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  style={{
                    background: 'rgba(15,23,42,0.6)',
                    border: '1px solid rgba(168,85,247,0.3)',
                    borderRadius: 12,
                    padding: '16px 20px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#f1f5f9' }}>{rec.title}</span>
                    <span style={{ fontSize: 11, color: '#a855f7', fontWeight: 600 }}>{rec.status.toUpperCase()}</span>
                  </div>
                  <p style={{ margin: '4px 0 8px', fontSize: 12, color: '#94a3b8', lineHeight: 1.4 }}>{rec.text}</p>
                  <div style={{ fontSize: 11, color: '#22c55e', fontStyle: 'italic', marginBottom: 12 }}>
                    Impact: {rec.expectedImpact}
                  </div>
                  {rec.status === 'pending' && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => respondMutation.mutate({ id: rec.id, action: 'approve' })}
                        style={{
                          padding: '6px 12px',
                          borderRadius: 6,
                          background: 'rgba(34,197,94,0.2)',
                          border: '1px solid rgba(34,197,94,0.4)',
                          color: '#22c55e',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <Check size={14} /> Approve
                      </button>
                      <button
                        onClick={() => respondMutation.mutate({ id: rec.id, action: 'reject' })}
                        style={{
                          padding: '6px 12px',
                          borderRadius: 6,
                          background: 'rgba(239,68,68,0.2)',
                          border: '1px solid rgba(239,68,68,0.4)',
                          color: '#ef4444',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <X size={14} /> Reject
                      </button>
                    </div>
                  )}
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
