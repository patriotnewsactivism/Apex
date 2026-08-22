import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApexEvent } from '../hooks/useWebSocket.js';
import type { Approval, ApprovalKind } from '../lib/api.js';
import { CheckCircle, XCircle, AlertTriangle, Megaphone, Repeat } from 'lucide-react';

// Two queues, not one. A gated approval BLOCKS an agent until a human answers;
// an escalation is a message the agent sent before carrying on. Showing them
// together under a single "pending" filter is how 8,683 escalations came to
// bury 16 gated calls and made this screen unusable for its actual job.

function ApprovalCard({
  approval,
  kind,
  onDecide,
}: {
  approval: Approval;
  kind: ApprovalKind;
  onDecide: () => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const isEscalation = kind === 'escalation';

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['approvals'] });
    qc.invalidateQueries({ queryKey: ['approvalCounts'] });
    onDecide();
  };

  const approveMut = useMutation({
    mutationFn: () => api.approvals.approve(approval.id, note),
    onSuccess: invalidate,
  });
  const rejectMut = useMutation({
    mutationFn: () => api.approvals.reject(approval.id, note),
    onSuccess: invalidate,
  });
  const ackMut = useMutation({
    mutationFn: () => api.approvals.acknowledge(approval.id, note),
    onSuccess: invalidate,
  });

  const isPending = approval.status === 'pending';
  const accent = isEscalation ? '#5a9eae' : '#c9a84a';
  const repeats = approval.occurrences ?? 1;

  return (
    <motion.div
      className="glass-card"
      style={{ padding: 20, borderColor: isPending ? `${accent}4d` : 'rgba(255,255,255,0.08)' }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
    >
      {isPending && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 14,
            padding: '6px 10px',
            background: `${accent}14`,
            borderRadius: 6,
            border: `1px solid ${accent}33`,
          }}
        >
          {isEscalation ? <Megaphone size={14} color={accent} /> : <AlertTriangle size={14} color={accent} />}
          <span style={{ color: accent, fontSize: 11, fontWeight: 600 }}>
            {isEscalation ? 'RAISED TO YOU — NOTHING IS BLOCKED' : 'AGENT BLOCKED — AWAITING APPROVAL'}
          </span>
          {repeats > 1 && (
            <span
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                fontWeight: 600,
                color: '#c45c66',
                fontFamily: 'var(--font-mono)',
              }}
              title={`Re-raised ${repeats} times${approval.lastOccurredAt ? ` — last ${new Date(approval.lastOccurredAt).toLocaleString()}` : ''}`}
            >
              <Repeat size={12} /> {repeats}×
            </span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-apex-text)', marginBottom: 4 }}>
            {approval.toolName}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
            Agent: {approval.agentId.replace('apex-', '').replace('-001', '')}
          </div>
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--color-apex-text)', marginBottom: 10, lineHeight: 1.6 }}>
        {approval.reason}
      </div>

      <pre
        style={{
          fontSize: 11,
          background: 'rgba(0,0,0,0.4)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 6,
          padding: '10px 12px',
          overflowX: 'auto',
          color: '#5a9eae',
          fontFamily: 'var(--font-mono)',
          margin: '0 0 14px 0',
        }}
      >
        {JSON.stringify(approval.toolArgs, null, 2)}
      </pre>

      {isPending && (
        <>
          <input
            className="apex-input"
            placeholder="Optional note..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ marginBottom: 10 }}
          />
          <div style={{ display: 'flex', gap: 10 }}>
            {isEscalation ? (
              // An escalation authorizes nothing, so "Approve" would be a lie.
              // Acknowledging clears it and records that you saw it.
              <button
                id={`acknowledge-${approval.id}`}
                className="btn-primary"
                style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, justifyContent: 'center' }}
                onClick={() => ackMut.mutate()}
                disabled={ackMut.isPending}
              >
                <CheckCircle size={14} />
                {ackMut.isPending ? 'Clearing...' : 'Acknowledge'}
              </button>
            ) : (
              <>
                <button
                  id={`approve-${approval.id}`}
                  className="btn-primary"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, justifyContent: 'center' }}
                  onClick={() => approveMut.mutate()}
                  disabled={approveMut.isPending}
                >
                  <CheckCircle size={14} />
                  {approveMut.isPending ? 'Approving...' : 'Approve'}
                </button>
                <button
                  id={`reject-${approval.id}`}
                  className="btn-danger"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, justifyContent: 'center' }}
                  onClick={() => rejectMut.mutate()}
                  disabled={rejectMut.isPending}
                >
                  <XCircle size={14} />
                  {rejectMut.isPending ? 'Rejecting...' : 'Reject'}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </motion.div>
  );
}

function Tab({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? 'rgba(90,158,174,0.12)' : 'transparent',
        border: `1px solid ${active ? 'rgba(90,158,174,0.35)' : 'rgba(255,255,255,0.08)'}`,
        borderRadius: 6,
        padding: '6px 14px',
        color: active ? '#5a9eae' : 'var(--color-apex-muted)',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        gap: 7,
      }}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            padding: '1px 6px',
            borderRadius: 10,
            background: active ? 'rgba(90,158,174,0.2)' : 'rgba(255,255,255,0.06)',
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function ApprovalQueue() {
  const [kind, setKind] = useState<ApprovalKind>('approval');

  const { data: rows = [], refetch } = useQuery({
    queryKey: ['approvals', kind],
    queryFn: () => api.approvals.list('pending', kind),
    refetchInterval: 5000,
  });

  const { data: counts, refetch: refetchCounts } = useQuery({
    queryKey: ['approvalCounts'],
    queryFn: () => api.approvals.counts(),
    refetchInterval: 10000,
  });

  const refreshAll = () => {
    refetch();
    refetchCounts();
  };

  useApexEvent('approval:requested', refreshAll);
  useApexEvent('approval:resolved', refreshAll);

  const isEscalation = kind === 'escalation';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Tab
          active={kind === 'approval'}
          label="Approvals"
          count={counts?.approval}
          onClick={() => setKind('approval')}
        />
        <Tab
          active={kind === 'escalation'}
          label="Escalations"
          count={counts?.escalation}
          onClick={() => setKind('escalation')}
        />
        <span style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginLeft: 4 }}>
          {isEscalation
            ? 'Decisions agents asked for. Nothing is blocked on these.'
            : 'Tool calls an agent cannot run until you say yes.'}
        </span>
      </div>

      {rows.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            color: 'var(--color-apex-muted)',
            padding: '60px 20px',
            border: '1px dashed rgba(255,255,255,0.08)',
            borderRadius: 12,
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>
            {isEscalation ? 'No open escalations' : 'No pending approvals'}
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            {isEscalation
              ? 'Nothing is waiting on a decision from you'
              : 'Agents are operating autonomously'}
          </div>
        </div>
      )}

      <AnimatePresence>
        {rows.map((a) => (
          <ApprovalCard key={a.id} approval={a} kind={kind} onDecide={refreshAll} />
        ))}
      </AnimatePresence>
    </div>
  );
}
