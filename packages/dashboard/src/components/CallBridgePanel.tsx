import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CallBridgeStatus } from '../lib/api.js';
import { PhoneCall, PhoneOff, Bot, AlertTriangle, Users, Radio, MicOff, Mic } from 'lucide-react';

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
  const [fromNumber, setFromNumber] = useState('');
  const [assistantLine, setAssistantLine] = useState('');
  const [topic, setTopic] = useState('');
  const [autoJoinAi, setAutoJoinAi] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  // The operator's own line and recurring numbers live server-side, so a
  // takeover call needs no typing. The operator line auto-fills but stays an
  // editable field — a default, not a lock-in.
  const settings = useQuery({
    queryKey: ['call-bridge', 'dial-settings'],
    queryFn: () => api.callBridge.dialSettings(),
  });
  useEffect(() => {
    if (!operatorNumber && settings.data?.defaultOperatorNumber) {
      setOperatorNumber(settings.data.defaultOperatorNumber);
    }
  }, [settings.data?.defaultOperatorNumber, operatorNumber]);

  const saveDefault = useMutation({
    mutationFn: (number: string) => api.callBridge.updateDialSettings({ defaultOperatorNumber: number }),
    onSuccess: (res) => {
      setSavedNotice(`Your default operator number is now ${res.defaultOperatorNumber}.`);
      void settings.refetch();
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const saveNumber = useMutation({
    mutationFn: async (number: string) => {
      const label = (window.prompt('Name for this number (e.g. County records office)', 'Saved number') ?? '').trim();
      if (!label) throw new Error('Cancelled');
      const existing = settings.data?.savedNumbers ?? [];
      if (existing.some((entry) => entry.number === number)) {
        return settings.data ?? { defaultOperatorNumber: operatorNumber, savedNumbers: existing, approvedAiLines: [] };
      }
      return api.callBridge.updateDialSettings({ savedNumbers: [...existing, { label, number }] });
    },
    onSuccess: () => {
      setSavedNotice('Number saved — it now appears in the pick list.');
      void settings.refetch();
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== 'Cancelled') setError(message);
    },
  });

  const start = useMutation({
    mutationFn: () =>
      api.callBridge.start({
        // Blank means "use the saved operator line" — the server falls back to it.
        ...(operatorNumber.trim() ? { operatorNumber: operatorNumber.trim() } : {}),
        customerNumber: customerNumber.trim(),
        // Empty means "use the configured APEX defaults" — the server only
        // accepts numbers it has already approved for bridge dials.
        ...(fromNumber.trim() ? { fromNumber: fromNumber.trim() } : {}),
        ...(assistantLine.trim() ? { assistantLine: assistantLine.trim() } : {}),
        ...(topic.trim() ? { topic: topic.trim() } : {}),
        autoJoinAi,
      }),
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
            Dials your phone, then the customer once you answer. The AI can sit in from the very start — muted and
            listening — and take over the moment you hand it the call.
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
            placeholder="+183****4970"
            value={operatorNumber}
            onChange={(e) => setOperatorNumber(e.target.value)}
          />
          <button
            type="button"
            className="btn-secondary"
            style={{ marginTop: 6, fontSize: 11 }}
            disabled={!validOperator || saveDefault.isPending}
            onClick={() => {
              setSavedNotice(null);
              saveDefault.mutate(operatorNumber.trim());
            }}
          >
            {saveDefault.isPending ? 'Saving…' : 'Save as my default'}
          </button>
        </div>
        <div>
          <label style={labelStyle}>Customer number (E.164)</label>
          <input
            style={inputStyle}
            placeholder="+183****4970"
            value={customerNumber}
            onChange={(e) => setCustomerNumber(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {settings.data && settings.data.savedNumbers.length > 0 && (
              <select
                style={{ ...inputStyle, maxWidth: 220, fontSize: 11 }}
                value=""
                onChange={(e) => {
                  if (e.target.value) setCustomerNumber(e.target.value);
                }}
              >
                <option value="">Pick a saved number…</option>
                {settings.data.savedNumbers.map((entry) => (
                  <option key={entry.number} value={entry.number}>
                    {entry.label} · {entry.number}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="btn-secondary"
              style={{ fontSize: 11 }}
              disabled={!validCustomer || saveNumber.isPending}
              onClick={() => {
                setSavedNotice(null);
                saveNumber.mutate(customerNumber.trim());
              }}
            >
              {saveNumber.isPending ? 'Saving…' : 'Save this number'}
            </button>
          </div>
        </div>
      </div>
      {savedNotice && <div style={{ fontSize: 11, color: 'var(--color-apex-muted)' }}>{savedNotice}</div>}

      <div>
        <label style={labelStyle}>What this call is about (the AI is briefed with this)</label>
        <textarea
          style={{ ...inputStyle, minHeight: 62, resize: 'vertical', lineHeight: 1.45 }}
          placeholder="e.g. Ask the county records office who authorised the June road closure and when the policy was written."
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: 12 }}>
        <div>
          <label style={labelStyle}>Call from (blank = configured line)</label>
          <input
            style={inputStyle}
            placeholder="+183****7665"
            value={fromNumber}
            onChange={(e) => setFromNumber(e.target.value)}
          />
        </div>
        <div>
          <label style={labelStyle}>AI line the takeover answers on (blank = default)</label>
          <input
            style={inputStyle}
            placeholder="+134****1352"
            value={assistantLine}
            onChange={(e) => setAssistantLine(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {settings.data && settings.data.approvedAiLines.length > 0 && (
              <select
                style={{ ...inputStyle, maxWidth: 240, fontSize: 11 }}
                aria-label="Approved AI lines"
                value=""
                onChange={(e) => {
                  if (e.target.value) setAssistantLine(e.target.value);
                }}
              >
                <option value="">Pick an approved AI line…</option>
                {settings.data.approvedAiLines.map((line) => (
                  <option key={line} value={line}>
                    {line}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={autoJoinAi}
          onChange={(e) => setAutoJoinAi(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span style={{ fontSize: 11.5, color: 'var(--color-apex-muted)', lineHeight: 1.5 }}>
          Put the AI on the bridge before the call rings — <strong>muted</strong>, so it hears the whole conversation
          but cannot say a word until you hand it the call with <strong>Take over</strong>. Off means the AI only joins
          when you ask, from whatever point in the call you ask.
        </span>
      </label>

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
  const [actionError, setActionError] = useState<string | null>(null);
  const [operatorMuted, setOperatorMuted] = useState(false);
  const [dtmfDigits, setDtmfDigits] = useState('');
  const { data: session } = useQuery({
    queryKey: ['call-bridge', id],
    queryFn: () => api.callBridge.status(id),
    refetchInterval: (query) => (query.state.data && LIVE_STATUSES.includes(query.state.data.status) ? 2000 : false),
  });

  const afterAction = () => {
    setActionError(null);
    qc.invalidateQueries({ queryKey: ['call-bridge', id] });
  };
  const onActionError = (err: unknown) => setActionError(err instanceof Error ? err.message : String(err));

  const bringInAi = useMutation({
    mutationFn: () => api.callBridge.bringInAi(id),
    onSuccess: afterAction,
    onError: onActionError,
  });

  // Take over = unmute the AI's conference leg, so it is heard by everyone on
  // the call while it keeps hearing them. Hand back mutes it again.
  const takeover = useMutation({
    mutationFn: () => api.callBridge.takeover(id),
    onSuccess: afterAction,
    onError: onActionError,
  });

  const handBack = useMutation({
    mutationFn: () => api.callBridge.handBack(id),
    onSuccess: afterAction,
    onError: onActionError,
  });

  const end = useMutation({
    mutationFn: () => api.callBridge.end(id),
    onSuccess: () => onEnded(),
    onError: (err: unknown) => setActionError(err instanceof Error ? err.message : String(err)),
  });

  // One-tap listen-in: ring the operator's saved number into this live call as
  // a muted (monitor) supervisor leg. On AI-first autonomous sessions the
  // operator leg is never dialed at start — this is how you tap into a call
  // the AI is running on its own.
  const listenLive = useMutation({
    mutationFn: () => api.callBridge.join(id, 'monitor'),
    onSuccess: afterAction,
    onError: onActionError,
  });

  // Mute my own leg so the AI can run the call while I listen in, then unmute
  // to take it back.
  const muteSelf = useMutation({
    mutationFn: (muted: boolean) => api.callBridge.operatorMute(id, muted),
    onSuccess: (res) => {
      setActionError(null);
      setOperatorMuted(Boolean(res.operatorMuted));
    },
    onError: onActionError,
  });

  // Press digits through to the far end, for an auto attendant that wants a
  // number pressed before it will connect the call.
  const sendDtmf = useMutation({
    mutationFn: (digits: string) => api.callBridge.dtmf(id, digits, 'customer'),
    onSuccess: (_res, digits) => {
      setActionError(null);
      setDtmfDigits((prev) => (prev + digits).slice(-24));
    },
    onError: onActionError,
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
  const aiOnCall = session.status === 'ai_dialing' || session.status === 'ai_joined';
  const aiListening = aiOnCall && session.aiMuted !== false;
  const statusLabel =
    session.status === 'ai_joined'
      ? aiListening
        ? 'Live: you + customer + AI listening'
        : 'Live: you + customer + AI on the call'
      : STATUS_LABEL[session.status];

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
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-apex-text)' }}>{statusLabel}</div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
        You: {session.operatorNumber} · Customer: {session.customerNumber}
        {session.fromNumber ? ` · From: ${session.fromNumber}` : ''}
        {session.assistantLine ? ` · AI line: ${session.assistantLine}` : ''}
      </div>

      {aiListening && (
        <div style={{ fontSize: 11.5, color: 'var(--color-apex-muted)', lineHeight: 1.5 }}>
          The AI is on the bridge muted and listening{session.assistantTopic ? ` — briefed on: “${session.assistantTopic}”` : ''}. It
          cannot be heard until you take over, and it keeps hearing everything after you hand it back.
        </div>
      )}

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
        {!isDone && !session.operatorCallControlId && (
          <button
            className="btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
            disabled={listenLive.isPending}
            onClick={() => {
              setActionError(null);
              listenLive.mutate();
            }}
            title="Ring your saved number into this call, muted (listen-only)"
          >
            <Radio size={14} />
            {listenLive.isPending ? 'Ringing you…' : 'Listen live'}
          </button>
        )}
        {!isDone && !aiOnCall && (
          <button
            className="btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
            disabled={!canBringInAi || bringInAi.isPending}
            onClick={() => {
              setActionError(null);
              bringInAi.mutate();
            }}
            title={canBringInAi ? undefined : 'Wait until the call is active (you + customer connected)'}
          >
            <Bot size={14} />
            {bringInAi.isPending ? 'Bringing the AI in…' : 'Put the AI in (listening)'}
          </button>
        )}
        {!isDone && aiOnCall && aiListening && (
          <button
            className="btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
            disabled={takeover.isPending}
            onClick={() => {
              setActionError(null);
              takeover.mutate();
            }}
            title="Unmute the AI so everyone on the call hears it"
          >
            <Bot size={14} />
            {takeover.isPending ? 'Handing over…' : 'Take over — let the AI talk'}
          </button>
        )}
        {!isDone && aiOnCall && !aiListening && (
          <button
            className="btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
            disabled={handBack.isPending}
            onClick={() => {
              setActionError(null);
              handBack.mutate();
            }}
            title="Mute the AI again — it keeps listening"
          >
            <Bot size={14} />
            {handBack.isPending ? 'Muting…' : 'Take back — mute the AI'}
          </button>
        )}
        {!isDone && (
          <button
            className={operatorMuted ? 'btn-primary' : 'btn-secondary'}
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
            disabled={muteSelf.isPending}
            onClick={() => {
              setActionError(null);
              muteSelf.mutate(!operatorMuted);
            }}
            title={
              operatorMuted
                ? 'You are muted — the other party cannot hear you. Tap to talk.'
                : 'Mute your own line: keep listening without being heard while the AI runs the call.'
            }
          >
            {operatorMuted ? <MicOff size={14} /> : <Mic size={14} />}
            {muteSelf.isPending ? '…' : operatorMuted ? 'Listening only — tap to talk' : 'Mute me (listen only)'}
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
        {actionError && (
          <span style={{ fontSize: 12, color: 'var(--color-apex-red)', fontFamily: 'var(--font-mono)' }}>{actionError}</span>
        )}
        {!isDone && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginBottom: 6 }}>
              Press digits through to the other end — for an auto attendant.
              {dtmfDigits && (
                <span style={{ fontFamily: 'var(--font-mono)', marginLeft: 6 }}>sent: {dtmfDigits}</span>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 40px)', gap: 6 }}>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((key) => (
                <button
                  key={key}
                  className="btn-secondary"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 13, padding: '6px 0' }}
                  disabled={sendDtmf.isPending}
                  onClick={() => {
                    setActionError(null);
                    sendDtmf.mutate(key);
                  }}
                  title={`Send ${key} to the other end`}
                >
                  {key}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Live call monitor: the bridge calls APEX is handling, newest first,
 *  refreshed on a short interval so the operator can watch a call start, watch
 *  the AI join, and watch it hand over — without hunting through logs. */
function LiveCallMonitor({ onOpen }: { onOpen: (id: string) => void }) {
  const sessions = useQuery({
    queryKey: ['call-bridge', 'sessions'],
    queryFn: () => api.callBridge.sessions(),
    refetchInterval: 5000,
  });
  const [joinError, setJoinError] = useState<string | null>(null);
  const listenJoin = useMutation({
    mutationFn: (sid: string) => api.callBridge.join(sid, 'monitor'),
    onSuccess: () => setJoinError(null),
    onError: (err: unknown) => setJoinError(err instanceof Error ? err.message : String(err)),
  });
  const rows = sessions.data?.sessions ?? [];
  const liveCount = rows.filter((s) => LIVE_STATUSES.includes(s.status)).length;
  return (
    <div className="glass-card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ color: 'var(--color-apex-brass)', display: 'flex' }}>
          <Radio size={16} />
        </span>
        <div className="apex-display" style={{ fontSize: 15, color: 'var(--color-apex-text)' }}>
          Live call monitor
        </div>
        <span style={{ fontSize: 11, color: 'var(--color-apex-muted)' }}>
          {liveCount} live · {rows.length} recent
        </span>
      </div>
      {rows.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>
          {sessions.isLoading ? 'Loading…' : 'No bridge calls yet.'}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((s) => (
          <div key={s.id} style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
          <button
            onClick={() => onOpen(s.id)}
            title="Open this call"
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(110px, 1.1fr) minmax(120px, 1.3fr) minmax(80px, 1fr) auto',
              gap: 10,
              alignItems: 'center',
              textAlign: 'left',
              padding: '8px 10px',
              borderRadius: 6,
              background: 'rgba(0,0,0,0.22)',
              border: '1px solid var(--color-apex-line)',
              color: 'var(--color-apex-text)',
              fontSize: 11.5,
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
            }}
          >
            <span style={{ color: STATUS_COLOR[s.status] ?? 'var(--color-apex-muted)' }}>● {s.status}</span>
            <span>{s.customerNumber}</span>
            <span
              style={{
                color: 'var(--color-apex-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {s.assistantTopic || '—'}
            </span>
            <span style={{ color: 'var(--color-apex-muted)', fontSize: 10 }}>
              {new Date(s.createdAt).toLocaleTimeString('en-US', { timeZone: 'America/Chicago' })}
            </span>
          </button>
          {LIVE_STATUSES.includes(s.status) && (
            <button
              onClick={() => listenJoin.mutate(s.id)}
              disabled={listenJoin.isPending}
              title="Ring your saved number into this live call, muted (listen-only)"
              style={{
                display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
                padding: '8px 10px', borderRadius: 6,
                background: 'rgba(90,158,174,0.15)',
                border: '1px solid var(--color-apex-line)',
                color: 'var(--color-apex-text)', fontSize: 11.5,
                fontFamily: 'var(--font-mono)', cursor: 'pointer',
              }}
            >
              <Radio size={13} />
              {listenJoin.isPending && listenJoin.variables === s.id ? 'Ringing…' : 'Listen'}
            </button>
          )}
          </div>
        ))}
      </div>
      {joinError && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#c45c66' }}>{joinError}</div>
      )}
    </div>
  );
}

/** Load and compose the operator-call-with-AI-takeover section of the Calls tab. */
export function CallBridgePanel() {
  const [activeId, setActiveId] = useState<string | null>(null);

  if (activeId) {
    return <LiveSession id={activeId} onEnded={() => setActiveId(null)} />;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <StartForm onStarted={setActiveId} />
      <LiveCallMonitor onOpen={setActiveId} />
    </div>
  );
}
