import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CallBridgeStatus } from '../lib/api.js';
import { PhoneCall, PhoneOff, Bot, AlertTriangle, Users } from 'lucide-react';

// Bridges the operator's own phone with a customer's, live, with the option
// to bring the Apex Front Desk AI assistant in as a third participant who can
// listen and speak — distinct from SingleCallLauncher, which fires an
// entirely AI-run call from the start. See call-bridge.ts for the Telnyx
// Call Control + conference design this drives.

const inputStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  padding: '9px 11px',
  borderRadius: 6,
  background: 'rgba(0,0,0,0.28)',
  border: '1px solid var(--color-apex-line)',
  color: 'var(--color-apex-text)',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-apex-muted)',
  marginBottom: 5,
  display: 'block',
};

const STATUS_LABEL: Record<CallBridgeStatus, string> = {
  dialing_operator: 'Calling you…',
  dialing_customer: 'You answered — calling the customer…',
  active: 'Live: you + customer',
  ai_dialing: 'Bringing the AI in…',
  ai_joined: 'Live: you + customer + AI',
  ended: 'Call ended',
  failed: 'Failed',
};

const STATUS_COLOR: Record<CallBridgeStatus, string> = {
  dialing_operator: '#c9a84a',
  dialing_customer: '#c9a84a',
  active: '#6a9f78',
  ai_dialing: '#c9a84a',
  ai_joined: '#5a9eae',
  ended: '#7d8a91',
  failed: '#c45c66',
};

const LIVE_STATUSES: CallBridgeStatus[] = ['dialing_operator', 'dialing_customer', 'active', 'ai_dialing', 'ai_joined'];

function StartForm({ onStarted }: { onStarted: (id: string) => void }) {
  const [operatorNumber, setOperatorNumber] = useState('');
  const [customerNumber, setCustomerNumber] = useState('');
  const [error, setError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () =>
      api.callBridge.start({ operatorNumber: operatorNumber.trim(), customerNumber: customerNumber.trim() }),
    onSuccess: (res) => {
      if (res.error) {
        setError(res.error);
        return;
      }
      onStarted(res.id);
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const validOperator = /^\+?[0-9\s()-]{7,20}$/.test(operatorNumber.trim());
  const validCustomer = /^\+?[0-9\s()-]{7,20}$/.test(customerNumber.trim());
  const ready = validOperator && validCustomer;

  return (
    <div className="glass-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: 'var(--color-apex-brass)', display: 'flex' }}>
          <Users size={18} />
        </span>
        <div>
          <div className="apex-display" style={{ fontSize: 15, color: 'var(--color-apex-text)' }}>
            Call with live AI takeover
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginTop: 1 }}>
            Dials your phone, then the customer once you answer. Bring the AI in live once you're connected.
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          padding: '9px 11px',
          borderRadius: 6,
          background: 'rgba(214,158,46,0.08)',
          border: '1px solid rgba(214,158,46,0.28)',
        }}
      >
        <AlertTriangle size={15} color="var(--color-apex-orange)" style={{ marginTop: 1, flexShrink: 0 }} />
        <span style={{ fontSize: 11.5, color: 'var(--color-apex-muted)', lineHeight: 1.5 }}>
          Dials immediately with no approval step. You are responsible for consent and Do-Not-Call compliance for
          the customer number.
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: 12 }}>
        <div>
          <label style={labelStyle}>Your number (E.164)</label>
          <input
            style={inputStyle}
            placeholder="+18328804970"
            value={operatorNumber}
            onChange={(e) => setOperatorNumber(e.target.value)}
          />
        </div>
        <div>
          <label style={labelStyle}>Customer number (E.164)</label>
          <input
            style={inputStyle}
            placeholder="+18328804970"
            value={customerNumber}
            onChange={(e) => setCustomerNumber(e.target.value)}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <button
          className="btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
          disabled={!ready || start.isPending}
          onClick={() => {
            setError(null);
            start.mutate();
          }}
        >
          <PhoneCall size={14} />
          {start.isPending ? 'Calling…' : 'Call me + customer'}
        </button>
        {error && (
          <span style={{ fontSize: 12, color: 'var(--color-apex-red)', fontFamily: 'var(--font-mono)' }}>{error}</span>
        )}
      </div>
    </div>
  );
}

function LiveSession({ id, onEnded }: { id: string; onEnded: () => void }) {
  const qc = useQueryClient();
  const { data: session } = useQuery({
    queryKey: ['call-bridge', id],
    queryFn: () => api.callBridge.status(id),
    refetchInterval: (query) => (query.state.data && LIVE_STATUSES.includes(query.state.data.status) ? 2000 : false),
  });

  const bringInAi = useMutation({
    mutationFn: () => api.callBridge.bringInAi(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['call-bridge', id] }),
  });

  const end = useMutation({
    mutationFn: () => api.callBridge.end(id),
    onSuccess: () => onEnded(),
  });

  if (!session) {
    return (
      <div className="glass-card" style={{ padding: 20, fontSize: 12, color: 'var(--color-apex-muted)' }}>
        Loading call status…
      </div>
    );
  }

  const color = STATUS_COLOR[session.status];
  const canBringInAi = session.status === 'active';
  const isDone = session.status === 'ended' || session.status === 'failed';

  return (
    <div className="glass-card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: color,
            boxShadow: !isDone ? `0 0 0 3px ${color}33` : 'none',
            animation: !isDone ? 'pulse-live 1.8s ease-in-out infinite' : 'none',
            flexShrink: 0,
          }}
        />
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-apex-text)' }}>{STATUS_LABEL[session.status]}</div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
        You: {session.operatorNumber} · Customer: {session.customerNumber}
      </div>

      {session.lastError && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '9px 11px',
            borderRadius: 6,
            background: 'rgba(196,92,102,0.10)',
            border: '1px solid rgba(196,92,102,0.30)',
            fontSize: 11.5,
            color: '#c45c66',
          }}
        >
          <AlertTriangle size={14} style={{ marginTop: 1, flexShrink: 0 }} />
          {session.lastError}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {!isDone && (
          <button
            className="btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
            disabled={!canBringInAi || bringInAi.isPending}
            onClick={() => bringInAi.mutate()}
            title={canBringInAi ? undefined : 'Wait until the call is active (you + customer connected)'}
          >
            <Bot size={14} />
            {session.status === 'ai_dialing' || session.status === 'ai_joined' ? 'AI is on the call' : 'Bring in AI'}
          </button>
        )}
        {!isDone && (
          <button
            className="btn-danger"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
            disabled={end.isPending}
            onClick={() => end.mutate()}
          >
            <PhoneOff size={14} />
            {end.isPending ? 'Ending…' : 'End call'}
          </button>
        )}
        {isDone && (
          <button className="btn-secondary" style={{ fontSize: 12 }} onClick={onEnded}>
            New call
          </button>
        )}
      </div>
    </div>
  );
}

/** Load and compose the operator-call-with-AI-takeover section of the Calls tab. */
export function CallBridgePanel() {
  const [activeId, setActiveId] = useState<string | null>(null);

  if (activeId) {
    return <LiveSession id={activeId} onEnded={() => setActiveId(null)} />;
  }
  return <StartForm onStarted={setActiveId} />;
}
