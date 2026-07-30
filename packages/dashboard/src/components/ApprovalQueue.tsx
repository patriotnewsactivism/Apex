import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApexEvent } from '../hooks/useWebSocket.js';
import type { Approval } from '../lib/api.js';
import { CheckCircle, XCircle, AlertTriangle } from 'lucide-react';

function ApprovalCard({ approval, onDecide }: { approval: Approval; onDecide: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');

  const approveMut = useMutation({
    mutationFn: () => api.approvals.approve(approval.id, note),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['approvals'] }); onDecide(); },
  });
  const rejectMut = useMutation({
    mutationFn: () => api.approvals.reject(approval.id, note),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['approvals'] }); onDecide(); },
  });

  const isPending = approval.status === 'pending';

  return (
    <motion.div
      className="glass-card"
      style={{
        padding: 20,
        borderColor: isPending ? 'rgba(255,214,10,0.3)' : 'rgba(255,255,255,0.08)',
      }}
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
            background: 'rgba(255,214,10,0.08)',
            borderRadius: 6,
            border: '1px solid rgba(255,214,10,0.2)',
          }}
        >
          <AlertTriangle size={14} color="#ffd60a" />
          <span style={{ color: '#ffd60a', fontSize: 11, fontWeight: 600 }}>AWAITING APPROVAL</span>
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
          color: '#00e5ff',
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
          </div>
        </>
      )}
    </motion.div>
  );
}

export function ApprovalQueue() {
  const qc = useQueryClient();
  const { data: pendingApprovals = [], refetch } = useQuery({
    queryKey: ['approvals'],
    queryFn: () => api.approvals.list('pending'),
    refetchInterval: 5000,
  });

  useApexEvent('approval:requested', () => refetch());
  useApexEvent('approval:resolved', () => refetch());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {pendingApprovals.length === 0 && (
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
          <div style={{ fontSize: 14, fontWeight: 500 }}>No pending approvals</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Agents are operating autonomously</div>
        </div>
      )}
      <AnimatePresence>
        {pendingApprovals.map((a) => (
          <ApprovalCard key={a.id} approval={a} onDecide={() => refetch()} />
        ))}
      </AnimatePresence>
    </div>
  );
}
