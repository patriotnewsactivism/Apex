// ─── Missions Dashboard Container ─────────────────────────────────────────────────
//
// Container page for the revenue operations missions dashboard.
// Lists all revenue-ops missions with status, budget, and controls.
// Per D1: missions are APEX goals with missionType='revenue_ops' in goal.result.

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Target, Pause, Play, Send, DollarSign, Plus, MoreVertical, CheckCircle, XCircle, AlertCircle, Loader2, X } from 'lucide-react';
import { api } from '../lib/api.js';
import type { MissionSummary, MissionDetail } from '../lib/missions.js';
import { useIsMobile } from '../hooks/useIsMobile.js';

// ─── Status colors ────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, { bg: string; text: string; dot: string }> = {
  draft: { bg: 'rgba(156,163,175,0.12)', text: '#9ca3af', dot: '#9ca3af' },
  validating: { bg: 'rgba(96,165,250,0.12)', text: '#60a5fa', dot: '#60a5fa' },
  ready: { bg: 'rgba(74,222,128,0.12)', text: '#4ade80', dot: '#4ade80' },
  running: { bg: 'rgba(90,158,174,0.12)', text: '#5a9eae', dot: '#5a9eae' },
  waiting_approval: { bg: 'rgba(250,204,21,0.12)', text: '#facc15', dot: '#facc15' },
  paused: { bg: 'rgba(201,168,74,0.12)', text: '#c9a84a', dot: '#c9a84a' },
  blocked: { bg: 'rgba(248,113,113,0.12)', text: '#f87171', dot: '#f87171' },
  budget_exhausted: { bg: 'rgba(248,113,113,0.12)', text: '#f87171', dot: '#f87171' },
  completed: { bg: 'rgba(106,159,120,0.12)', text: '#6a9f78', dot: '#6a9f78' },
  cancelled: { bg: 'rgba(196,92,102,0.12)', text: '#c45c66', dot: '#c45c66' },
  failed: { bg: 'rgba(196,92,102,0.12)', text: '#c45c66', dot: '#c45c66' },
};

const STATUS_ORDER = [
  'draft', 'validating', 'ready', 'running', 'waiting_approval',
  'paused', 'blocked', 'budget_exhausted', 'completed', 'cancelled', 'failed',
];

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(cents / 100);
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Mission Card ────────────────────────────────────────────────────────────────

function MissionCard({ mission, onView, onPause, onResume, onCancel, onSubmit }: {
  mission: MissionSummary;
  onView: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const status = mission.effectiveStatus;
  const colors = STATUS_COLOR[status] || STATUS_COLOR.draft;
  const isDraft = status === 'draft';
  const isRunning = status === 'running';
  const isPaused = status === 'paused';
  const isCompleted = status === 'completed' || status === 'cancelled' || status === 'failed';
  const budgetPct = mission.budgetCents > 0 ? Math.min(100, Math.round((mission.spentCents / mission.budgetCents) * 100)) : 0;
  const budgetWarning = budgetPct >= 90;

  return (
    <motion.div
      className="glass-card"
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.18 }}
      style={{
        padding: '14px 16px',
        borderLeft: `3px solid ${colors.dot}`,
        position: 'relative',
      }}
    >
      {/* Status + title row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: colors.dot, flexShrink: 0 }} />
          <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: colors.bg, color: colors.text, fontWeight: 600, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', flexShrink: 0 }}>
            {status.replace('_', ' ')}
          </span>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-apex-text)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {mission.title}
          </h3>
        </div>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            style={{
              background: 'transparent',
              border: '1px solid var(--color-apex-line)',
              borderRadius: 5,
              padding: '4px 8px',
              cursor: 'pointer',
              color: 'var(--color-apex-muted)',
              display: 'flex',
              alignItems: 'center',
              fontSize: 13,
            }}
          >
            <MoreVertical size={14} />
          </button>
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 36,
                  background: 'var(--color-apex-surface)',
                  border: '1px solid var(--color-apex-line)',
                  borderRadius: 6,
                  padding: 4,
                  zIndex: 10,
                  minWidth: 140,
                }}
              >
                {isDraft && (
                  <button onClick={() => { onSubmit(); setMenuOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-apex-text)', fontSize: 12, borderRadius: 4 }}>
                    <Send size={14} /> Submit for validation
                  </button>
                )}
                {isRunning && (
                  <>
                    <button onClick={() => { onPause(); setMenuOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-apex-text)', fontSize: 12, borderRadius: 4 }}>
                      <Pause size={14} /> Pause
                    </button>
                    <button onClick={() => { onCancel(); setMenuOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-apex-red)', fontSize: 12, borderRadius: 4 }}>
                      <XCircle size={14} /> Cancel
                    </button>
                  </>
                )}
                {isPaused && (
                  <button onClick={() => { onResume(); setMenuOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-apex-text)', fontSize: 12, borderRadius: 4 }}>
                    <Play size={14} /> Resume
                  </button>
                )}
                <button onClick={() => { onView(); setMenuOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-apex-brass)', fontSize: 12, borderRadius: 4 }}>
                  <Target size={14} /> View details
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Objective */}
      <p style={{ fontSize: 12, color: 'var(--color-apex-muted)', margin: '0 0 10px', lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
        {mission.objective}
      </p>

      {/* Budget bar */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <DollarSign size={12} style={{ color: budgetWarning ? 'var(--color-apex-red)' : 'var(--color-apex-muted)' }} />
          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-apex-muted)' }}>
            {formatCents(mission.spentCents)} / {formatCents(mission.budgetCents)}
          </span>
          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: budgetWarning ? 'var(--color-apex-red)' : 'var(--color-apex-muted)' }}>
            ({budgetPct}%)
          </span>
          {budgetWarning && (
            <AlertCircle size={12} style={{ color: 'var(--color-apex-red)', flexShrink: 0 }} />
          )}
        </div>
        <div style={{ height: 4, background: 'var(--color-apex-line)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${budgetPct}%`, background: budgetWarning ? 'var(--color-apex-red)' : 'var(--color-apex-brass)', borderRadius: 2, transition: 'width 0.3s' }} />
        </div>
      </div>

      {/* Meta row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: 'var(--color-apex-muted)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Target size={12} />
          {mission.allowedChannels.length > 0 ? mission.allowedChannels.join(' · ') : 'No channels'}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          {formatDate(mission.deadlineAt)}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', color: mission.remainingCents > 0 ? 'var(--color-apex-green)' : 'var(--color-apex-muted)' }}>
          {formatCents(mission.remainingCents)} left
        </span>
      </div>

      {/* Quick action */}
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--color-apex-line)' }}>
        <button
          onClick={onView}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            background: 'var(--color-apex-brass-soft)',
            border: 'none',
            borderRadius: 5,
            cursor: 'pointer',
            color: 'var(--color-apex-brass)',
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          <Target size={14} />
          View mission details
        </button>
      </div>
    </motion.div>
  );
}

// ─── Mission Detail Modal ─────────────────────────────────────────────────────────

function MissionDetailModal({ mission, onClose }: { mission: MissionDetail; onClose: () => void }) {
  const budgetPct = mission.budgetCents > 0 ? Math.min(100, Math.round((mission.spentCents / mission.budgetCents) * 100)) : 0;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(8,10,14,0.85)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 20,
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.2 }}
        style={{
          background: 'var(--color-apex-surface)',
          border: '1px solid var(--color-apex-line)',
          borderRadius: 10,
          width: '100%',
          maxWidth: 600,
          maxHeight: '80vh',
          overflow: 'auto',
        }}
      >
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-apex-line)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: STATUS_COLOR[mission.effectiveStatus]?.dot || '#9ca3af', flexShrink: 0, marginTop: 4 }} />
          <div style={{ flex: 1 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-apex-text)', margin: '0 0 4px' }}>{mission.title}</h2>
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: `${STATUS_COLOR[mission.effectiveStatus]?.bg || 'transparent'}`, color: STATUS_COLOR[mission.effectiveStatus]?.text || '#9ca3af', fontWeight: 600, fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}>
              {mission.effectiveStatus.replace('_', ' ')}
            </span>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-apex-muted)', padding: 4, display: 'flex', alignItems: 'center' }}>
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '16px 20px' }}>
          {/* Objective */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', fontWeight: 500, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Objective</div>
            <p style={{ fontSize: 13, color: 'var(--color-apex-text)', lineHeight: 1.5, margin: 0 }}>{mission.objective}</p>
          </div>

          {/* Target definition */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', fontWeight: 500, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Target Definition</div>
            <pre style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--color-apex-muted)', background: 'rgba(255,255,255,0.03)', padding: '8px 12px', borderRadius: 6, overflow: 'auto', border: '1px solid var(--color-apex-line)' }}>
              {JSON.stringify(mission.targetDefinition, null, 2)}
            </pre>
          </div>

          {/* Policy */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', fontWeight: 500, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Policy</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
              <div>
                <span style={{ color: 'var(--color-apex-muted)' }}>Budget cap:</span>
                <span style={{ color: 'var(--color-apex-text)', fontWeight: 500 }}> {formatCents(mission.budgetCents)}</span>
              </div>
              <div>
                <span style={{ color: 'var(--color-apex-muted)' }}>Approve before pivot:</span>
                <span style={{ color: 'var(--color-apex-text)' }}> {mission.approveBeforePivot ? 'Yes' : 'No'}</span>
              </div>
              <div>
                <span style={{ color: 'var(--color-apex-muted)' }}>First touch opt-in:</span>
                <span style={{ color: 'var(--color-apex-text)' }}> {mission.firstTouchOptIn}</span>
              </div>
              <div>
                <span style={{ color: 'var(--color-apex-muted)' }}>Allowed channels:</span>
                <span style={{ color: 'var(--color-apex-text)' }}> {mission.allowedChannels.join(', ')}</span>
              </div>
            </div>
          </div>

          {/* Budget bar */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>Budget used</span>
              <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: budgetPct >= 90 ? 'var(--color-apex-red)' : 'var(--color-apex-text)' }}>
                {formatCents(mission.spentCents)} / {formatCents(mission.budgetCents)} ({budgetPct}%)
              </span>
            </div>
            <div style={{ height: 6, background: 'var(--color-apex-line)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${budgetPct}%`, background: budgetPct >= 90 ? 'var(--color-apex-red)' : 'var(--color-apex-brass)', borderRadius: 3, transition: 'width 0.3s' }} />
            </div>
          </div>

          {/* Tasks */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', fontWeight: 500, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 8 }}>
              Mission Steps ({mission.activeTasks.length} active / {mission.completedTasks} completed / {mission.totalTasks} total)
            </div>
            {mission.activeTasks.length === 0 && mission.totalTasks === 0 ? (
              <div style={{ padding: '12px', textAlign: 'center', color: 'var(--color-apex-muted)', fontSize: 12, background: 'rgba(255,255,255,0.02)', borderRadius: 6, border: '1px dashed var(--color-apex-line)' }}>
                No steps created yet. Steps are created by agents as they execute the mission.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {mission.activeTasks.map(t => (
                  <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(255,255,255,0.02)', borderRadius: 5, borderLeft: `2px solid ${STATUS_COLOR[t.status]?.dot || '#64748b'}` }}>
                    <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: STATUS_COLOR[t.status]?.text || '#64748b', textTransform: 'uppercase', flexShrink: 0 }}>{t.status}</span>
                    <span style={{ fontSize: 12, color: 'var(--color-apex-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{t.title}</span>
                    <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-apex-muted)', flexShrink: 0 }}>P{t.priority}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Approvals */}
          {mission.pendingApprovals.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', fontWeight: 500, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Pending Approvals ({mission.pendingApprovals.length})
              </div>
              {mission.pendingApprovals.map(a => (
                <div key={a.id} style={{ padding: '8px 12px', background: 'rgba(250,204,21,0.06)', border: '1px solid rgba(250,204,21,0.2)', borderRadius: 5, marginBottom: 4 }}>
                  <div style={{ fontSize: 12, color: 'var(--color-apex-text)', marginBottom: 2 }}>{a.reason}</div>
                  <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-apex-muted)' }}>
                    {a.toolName} · {formatDate(a.createdAt)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--color-apex-line)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ padding: '7px 14px', background: 'transparent', border: '1px solid var(--color-apex-line)', borderRadius: 5, cursor: 'pointer', color: 'var(--color-apex-muted)', fontSize: 12 }}>
            Close
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Create Mission Dialog ────────────────────────────────────────────────────────

function CreateMissionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [objective, setObjective] = useState('');
  const [title, setTitle] = useState('');
  const [budgetCents, setBudgetCents] = useState(40000);
  const [deadlineAt, setDeadlineAt] = useState('');
  const [firstTouchOptIn, setFirstTouchOptIn] = useState<'manual' | 'auto_with_warn'>('manual');
  const [approvedBeforePivot, setApprovedBeforePivot] = useState(true);
  const [channels, setChannels] = useState<string[]>(['call', 'email']);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      setSubmitting(true);
      setError('');
      try {
        const result = await api.missions.create({
          objective: objective.trim(),
          targetDefinition: { industries: [], cities: [], employeeRange: [10, 100] },
          qualificationRules: { mustHavePhone: true, mustHaveEmail: true },
          allowedChannels: channels,
          policy: {
            budgetCents,
            approveBeforePivot: approvedBeforePivot,
            firstTouchOptIn,
            requireApprovalForNewCampaigns: true,
            requireApprovalForOfferChange: true,
          },
          deadlineAt: deadlineAt || undefined,
          title: title.trim() || `Revenue Ops Mission: ${objective.slice(0, 60)}`,
        });
        onCreated();
        onClose();
        return result;
      } finally {
        setSubmitting(false);
      }
    },
    onSuccess: () => { onCreated(); onClose(); },
    onError: (err: any) => { setError(err?.message || 'Failed to create mission'); },
  });

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(8,10,14,0.85)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 20,
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.2 }}
        style={{
          background: 'var(--color-apex-surface)',
          border: '1px solid var(--color-apex-line)',
          borderRadius: 10,
          width: '100%',
          maxWidth: 480,
        }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-apex-line)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-apex-text)', margin: 0 }}>New Revenue Ops Mission</h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-apex-muted)', padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '16px 20px' }}>
          {error && (
            <div style={{ padding: '8px 12px', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 5, color: 'var(--color-apex-red)', fontSize: 12, marginBottom: 12 }}>
              {error}
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--color-apex-muted)', fontWeight: 500, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Objective *</label>
            <textarea
              value={objective}
              onChange={e => setObjective(e.target.value)}
              placeholder="e.g., Generate 12 qualified demonstrations with commercial roofing companies in Texas..."
              rows={3}
              style={{ width: '100%', padding: '8px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--color-apex-line)', borderRadius: 6, color: 'var(--color-apex-text)', fontSize: 13, fontFamily: 'var(--font-sans)', resize: 'vertical', outline: 'none' }}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--color-apex-muted)', fontWeight: 500, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Title (optional)</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Leave blank to auto-generate from objective"
              style={{ width: '100%', padding: '8px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--color-apex-line)', borderRadius: 6, color: 'var(--color-apex-text)', fontSize: 13, fontFamily: 'var(--font-sans)', outline: 'none' }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--color-apex-muted)', fontWeight: 500, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Budget (USD)</label>
              <input
                type="number"
                value={budgetCents / 100}
                onChange={e => setBudgetCents(Math.round(parseInt(e.target.value) * 100 || 0))}
                min={100}
                step={100}
                style={{ width: '100%', padding: '8px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--color-apex-line)', borderRadius: 6, color: 'var(--color-apex-text)', fontSize: 13, fontFamily: 'var(--font-sans)', outline: 'none' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--color-apex-muted)', fontWeight: 500, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Deadline (ISO date)</label>
              <input
                type="date"
                value={deadlineAt}
                onChange={e => setDeadlineAt(e.target.value)}
                style={{ width: '100%', padding: '8px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--color-apex-line)', borderRadius: 6, color: 'var(--color-apex-text)', fontSize: 13, fontFamily: 'var(--font-sans)', outline: 'none' }}
              />
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--color-apex-muted)', fontWeight: 500, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Allowed Channels</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {['call', 'email', 'sms'].map(ch => (
                <label key={ch} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--color-apex-line)', borderRadius: 5, cursor: 'pointer', fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={channels.includes(ch)}
                    onChange={e => {
                      if (e.target.checked) channels.push(ch);
                      else channels.splice(channels.indexOf(ch), 1);
                      setChannels([...channels]);
                    }}
                    style={{ cursor: 'pointer' }}
                  />
                  {ch.charAt(0).toUpperCase() + ch.slice(1)}
                </label>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--color-apex-muted)', fontWeight: 500, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>First Touch Opt-In</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['manual', 'auto_with_warn'] as const).map(opt => (
                <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--color-apex-line)', borderRadius: 5, cursor: 'pointer', fontSize: 12 }}>
                  <input
                    type="radio"
                    name="firstTouchOptIn"
                    checked={firstTouchOptIn === opt}
                    onChange={() => setFirstTouchOptIn(opt)}
                    style={{ cursor: 'pointer' }}
                  />
                  {opt === 'manual' ? 'Manual (require consent per contact)' : 'Auto with warn (log warning, proceed)'}
                </label>
              ))}
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={approvedBeforePivot}
              onChange={e => setApprovedBeforePivot(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            Require approval before channel pivots
          </label>
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--color-apex-line)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ padding: '7px 14px', background: 'transparent', border: '1px solid var(--color-apex-line)', borderRadius: 5, cursor: 'pointer', color: 'var(--color-apex-muted)', fontSize: 12 }}>
            Cancel
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={submitting || objective.trim().length < 10}
            style={{
              padding: '7px 14px',
              background: submitting || objective.trim().length < 10 ? 'var(--color-apex-line)' : 'var(--color-apex-brass)',
              border: 'none',
              borderRadius: 5,
              cursor: submitting || objective.trim().length < 10 ? 'not-allowed' : 'pointer',
              color: 'var(--color-apex-surface)',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {submitting ? 'Creating…' : 'Create Mission'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Missions Dashboard ───────────────────────────────────────────────────────────

export function MissionsDashboard() {
  const [detailMission, setDetailMission] = useState<MissionDetail | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();

  const { data: stats } = useQuery({
    queryKey: ['missions', 'stats'],
    queryFn: () => api.missions.stats(),
    refetchInterval: 30000,
  });

  const statusFilter = activeFilter || 'all';

  const { data: missionsData, refetch } = useQuery({
    queryKey: ['missions', statusFilter],
    queryFn: () => {
      if (statusFilter === 'all') {
        return api.missions.list({ limit: 50 });
      }
      return api.missions.list({ status: statusFilter, limit: 50 });
    },
    refetchInterval: 15000,
  });

  const missions = missionsData?.missions || [];
  const total = missionsData?.total || 0;

  const pauseMutation = useMutation({
    mutationFn: (missionId: string) => api.missions.pause(missionId, 'Paused from dashboard'),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['missions'] }); refetch(); },
  });

  const resumeMutation = useMutation({
    mutationFn: (missionId: string) => api.missions.resume(missionId, 'Resumed from dashboard'),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['missions'] }); refetch(); },
  });

  const cancelMutation = useMutation({
    mutationFn: (missionId: string) => api.missions.cancel(missionId, 'Cancelled from dashboard'),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['missions'] }); refetch(); },
  });

  const submitMutation = useMutation({
    mutationFn: (missionId: string) => api.missions.submit(missionId, 'Submitted from dashboard'),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['missions'] }); refetch(); },
  });

  const fetchDetail = async (missionId: string) => {
    const detail = await api.missions.get(missionId);
    setDetailMission(detail);
  };

  if (isMobile) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Target size={20} style={{ color: 'var(--color-apex-brass)' }} />
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Missions</h1>
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {['all', 'running', 'paused', 'waiting_approval', 'budget_exhausted', 'completed', 'cancelled'].map(s => (
            <button
              key={s}
              onClick={() => setActiveFilter(s === 'all' ? null : s)}
              style={{
                padding: '4px 10px',
                background: activeFilter === s ? 'var(--color-apex-brass-soft)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${activeFilter === s ? 'var(--color-apex-brass)' : 'var(--color-apex-line)'}`,
                borderRadius: 12,
                cursor: 'pointer',
                fontSize: 11,
                color: activeFilter === s ? 'var(--color-apex-brass)' : 'var(--color-apex-muted)',
              }}
            >
              {s === 'all' ? 'All' : s.replace('_', ' ')}
            </button>
          ))}
        </div>

        <button
          onClick={() => setCreateDialogOpen(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '10px 16px',
            background: 'var(--color-apex-brass)',
            color: 'var(--color-apex-surface)',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 16,
          }}
        >
          <Plus size={16} /> New Mission
        </button>

        <AnimatePresence>
          {missions.map(m => (
            <MissionCard
              key={m.missionId}
              mission={m}
              onView={() => fetchDetail(m.missionId)}
              onPause={() => pauseMutation.mutate(m.missionId)}
              onResume={() => resumeMutation.mutate(m.missionId)}
              onCancel={() => cancelMutation.mutate(m.missionId)}
              onSubmit={() => submitMutation.mutate(m.missionId)}
            />
          ))}
        </AnimatePresence>

        {missions.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--color-apex-muted)' }}>
            <Target size={32} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
            <p style={{ fontSize: 13 }}>No missions yet.</p>
            <p style={{ fontSize: 11, marginTop: 4 }}>Create one to start a revenue operations workflow.</p>
          </div>
        )}
      </div>
    );
  }

  // Desktop layout
  return (
    <div style={{ display: 'flex', gap: 24, minHeight: 'calc(100vh - 120px)' }}>
      {/* Sidebar: stats + filters */}
      <div style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Stats card */}
        {stats && (
          <div className="glass-card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', fontWeight: 500, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Mission Stats</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
              <div>
                <div style={{ color: 'var(--color-apex-muted)' }}>Total</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-apex-text)', fontFamily: 'var(--font-mono)' }}>{stats.total}</div>
              </div>
              <div>
                <div style={{ color: 'var(--color-apex-muted)' }}>Active</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-apex-brass)', fontFamily: 'var(--font-mono)' }}>{stats.activeMissions}</div>
              </div>
              <div>
                <div style={{ color: 'var(--color-apex-muted)' }}>Budget pool</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-apex-text)', fontFamily: 'var(--font-mono)' }}>
                  {formatCents(stats.totalBudgetCents)}
                </div>
              </div>
              <div>
                <div style={{ color: 'var(--color-apex-muted)' }}>Spent</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: stats.totalSpentCents > stats.totalBudgetCents * 0.9 ? 'var(--color-apex-red)' : 'var(--color-apex-text)', fontFamily: 'var(--font-mono)' }}>
                  {formatCents(stats.totalSpentCents)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Status filter */}
        <div className="glass-card" style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', fontWeight: 500, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Filter by Status</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {[
              { id: 'all', label: 'All Missions', count: stats?.total ?? 0 },
              { id: 'running', label: 'Running', count: stats?.byStatus?.running ?? 0 },
              { id: 'paused', label: 'Paused', count: stats?.byStatus?.paused ?? 0 },
              { id: 'waiting_approval', label: 'Waiting Approval', count: stats?.byStatus?.waiting_approval ?? 0 },
              { id: 'blocked', label: 'Blocked', count: stats?.byStatus?.blocked ?? 0 },
              { id: 'budget_exhausted', label: 'Budget Exhausted', count: stats?.byStatus?.budget_exhausted ?? 0 },
              { id: 'completed', label: 'Completed', count: stats?.byStatus?.completed ?? 0 },
              { id: 'cancelled', label: 'Cancelled/Failed', count: (stats?.byStatus?.cancelled ?? 0) + (stats?.byStatus?.failed ?? 0) },
              { id: 'draft', label: 'Draft', count: stats?.byStatus?.draft ?? 0 },
            ].map(item => (
              <button
                key={item.id}
                onClick={() => setActiveFilter(item.id === 'all' ? null : item.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '5px 8px',
                  background: activeFilter === item.id ? 'var(--color-apex-brass-soft)' : 'transparent',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 12,
                  color: activeFilter === item.id ? 'var(--color-apex-brass)' : 'var(--color-apex-muted)',
                  textAlign: 'left',
                  width: '100%',
                }}
              >
                <span>{item.label}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: activeFilter === item.id ? 'rgba(212,165,116,0.2)' : 'rgba(255,255,255,0.05)', padding: '1px 6px', borderRadius: 3 }}>
                  {item.count}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.02)', borderRadius: 6, border: '1px solid var(--color-apex-line)' }}>
          <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', marginBottom: 6, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status Legend</div>
          {Object.entries(STATUS_COLOR).map(([status, colors]) => (
            <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, marginBottom: 2 }}>
              <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: colors.dot, flexShrink: 0 }} />
              <span style={{ color: colors.text, textTransform: 'capitalize' }}>{status.replace('_', ' ')}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Main: mission list */}
      <div style={{ flex: 1, overflow: 'auto', paddingRight: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Target size={20} style={{ color: 'var(--color-apex-brass)' }} />
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Revenue Ops Missions</h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
              {total} mission{total !== 1 ? 's' : ''}
            </span>
            <button
              onClick={() => setCreateDialogOpen(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 14px',
                background: 'var(--color-apex-brass)',
                color: 'var(--color-apex-surface)',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              <Plus size={16} /> New Mission
            </button>
          </div>
        </div>

        <AnimatePresence>
          {missions.map(m => (
            <MissionCard
              key={m.missionId}
              mission={m}
              onView={() => fetchDetail(m.missionId)}
              onPause={() => pauseMutation.mutate(m.missionId)}
              onResume={() => resumeMutation.mutate(m.missionId)}
              onCancel={() => cancelMutation.mutate(m.missionId)}
              onSubmit={() => submitMutation.mutate(m.missionId)}
            />
          ))}
        </AnimatePresence>

        {missions.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--color-apex-muted)' }}>
            <Target size={40} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
            <p style={{ fontSize: 15, fontWeight: 500 }}>No missions found</p>
            <p style={{ fontSize: 12, marginTop: 4 }}>
              {activeFilter ? `No missions with status "${activeFilter.replace('_', ' ')}"` : 'Create one to start a revenue operations workflow.'}
            </p>
          </div>
        )}
      </div>

      {/* Detail modal */}
      <AnimatePresence>
        {detailMission && (
          <MissionDetailModal mission={detailMission} onClose={() => setDetailMission(null)} />
        )}
      </AnimatePresence>

      {/* Create dialog */}
      <AnimatePresence>
        {createDialogOpen && (
          <CreateMissionDialog
            onClose={() => setCreateDialogOpen(false)}
            onCreated={() => { setCreateDialogOpen(false); refetch(); }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
