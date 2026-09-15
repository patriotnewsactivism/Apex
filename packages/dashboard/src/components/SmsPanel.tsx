import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SmsMessage, type SmsThreadSummary } from '../lib/api.js';
import { MessageSquare, Send, Plus, AlertTriangle } from 'lucide-react';

// One thread per contact number (both directions share sms_messages, keyed by
// counterpartyNumber). Inbound replies land here automatically via Telnyx's
// messaging-profile webhook; this panel is the manual-send + read side.

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

function formatWhen(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/** One row in the thread list. */
function ThreadRow({
  thread,
  active,
  onClick,
}: {
  thread: SmsThreadSummary;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        width: '100%',
        textAlign: 'left',
        padding: '10px 12px',
        borderRadius: 6,
        border: 'none',
        cursor: 'pointer',
        background: active ? 'var(--color-apex-brass-soft)' : 'transparent',
        color: active ? 'var(--color-apex-brass)' : 'var(--color-apex-text)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, fontWeight: 600 }}>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{thread.counterpartyNumber}</span>
        <span style={{ fontSize: 10, color: 'var(--color-apex-muted)', flexShrink: 0 }}>{formatWhen(thread.createdAt)}</span>
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: 'var(--color-apex-muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {thread.direction === 'outbound' ? 'You: ' : ''}
        {thread.body}
      </div>
    </button>
  );
}

/** One message bubble in an open thread. */
function MessageBubble({ message }: { message: SmsMessage }) {
  const outbound = message.direction === 'outbound';
  return (
    <div style={{ display: 'flex', justifyContent: outbound ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '78%',
          minWidth: 0,
          padding: '8px 12px',
          borderRadius: 10,
          background: outbound ? 'var(--color-apex-brass-soft)' : 'rgba(255,255,255,0.06)',
          border: `1px solid ${outbound ? 'rgba(184,150,94,0.35)' : 'var(--color-apex-line)'}`,
        }}
      >
        <div style={{ fontSize: 13, color: 'var(--color-apex-text)', overflowWrap: 'anywhere' }}>{message.body}</div>
        <div style={{ fontSize: 9.5, color: 'var(--color-apex-muted)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
          {outbound ? (message.createdByAgentId === 'apex-front-desk' ? 'AI · ' : 'You · ') : ''}
          {formatWhen(message.createdAt)}
          {message.status === 'failed' && ' · failed'}
        </div>
      </div>
    </div>
  );
}

/** Compose box shared by an open thread and a brand-new conversation. */
function ComposeBox({ toNumber, onSent }: { toNumber: string; onSent: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () => api.salesOps.sendSms({ toNumber, body: text.trim() }),
    onSuccess: (res) => {
      if (!res.success) {
        setError(res.error ?? 'Send failed.');
        return;
      }
      setText('');
      setError(null);
      onSent();
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const valid = text.trim().length > 0 && /^\+?[0-9\s()-]{7,20}$/.test(toNumber.trim());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          style={{ ...inputStyle, minHeight: 44, resize: 'vertical', fontFamily: 'var(--font-sans)', flex: 1 }}
          placeholder="Type a message…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && valid && !send.isPending) {
              e.preventDefault();
              setError(null);
              send.mutate();
            }
          }}
        />
        <button
          className="btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '10px 14px', flexShrink: 0 }}
          disabled={!valid || send.isPending}
          onClick={() => {
            setError(null);
            send.mutate();
          }}
        >
          <Send size={14} />
          {send.isPending ? 'Sending…' : 'Send'}
        </button>
      </div>
      {error && <div style={{ fontSize: 11, color: 'var(--color-apex-red)' }}>{error}</div>}
    </div>
  );
}

/** New-conversation form: pick a destination number, then reuses ComposeBox. */
function NewThreadForm({ onStarted }: { onStarted: (number: string) => void }) {
  const [number, setNumber] = useState('');
  const valid = /^\+?[0-9\s()-]{7,20}$/.test(number.trim());

  return (
    <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-apex-muted)', marginBottom: 5, display: 'block' }}>
          Destination number (E.164)
        </label>
        <input
          style={inputStyle}
          placeholder="+18328804970"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
      </div>
      {valid && <ComposeBox toNumber={number.trim()} onSent={() => onStarted(number.trim())} />}
    </div>
  );
}

/** Load and compose the Sales Operations SMS sub-tab: thread list + open thread. */
export function SmsPanel() {
  const [selected, setSelected] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const qc = useQueryClient();

  const { data: threads = [] } = useQuery({
    queryKey: ['sms-threads'],
    queryFn: () => api.salesOps.smsThreads(),
    refetchInterval: 8000,
  });

  const { data: messages = [] } = useQuery({
    queryKey: ['sms-thread', selected],
    queryFn: () => api.salesOps.smsThread(selected as string),
    enabled: Boolean(selected),
    refetchInterval: selected ? 8000 : false,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sms-threads'] });
    if (selected) qc.invalidateQueries({ queryKey: ['sms-thread', selected] });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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
          Sends immediately from the Apex front desk number, no approval step. Replies arrive here and the AI
          front desk assistant also answers automatically — this view is for you to watch or jump in.
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
          onClick={() => {
            setShowNew(!showNew);
            setSelected(null);
          }}
        >
          <Plus size={14} /> New message
        </button>
      </div>

      <AnimatePresence>
        {showNew && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <NewThreadForm
              onStarted={(number) => {
                setShowNew(false);
                setSelected(number);
                refresh();
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 260px) minmax(0, 1fr)',
          gap: 14,
        }}
        className="sms-layout"
      >
        <div className="glass-card" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, maxHeight: 520, overflowY: 'auto' }}>
          {threads.length === 0 && (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--color-apex-muted)', fontSize: 12 }}>
              <MessageSquare size={22} style={{ opacity: 0.5, marginBottom: 6 }} />
              <div>No SMS conversations yet.</div>
            </div>
          )}
          {threads.map((t) => (
            <ThreadRow
              key={t.counterpartyNumber}
              thread={t}
              active={selected === t.counterpartyNumber}
              onClick={() => {
                setSelected(t.counterpartyNumber);
                setShowNew(false);
              }}
            />
          ))}
        </div>

        <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          {!selected ? (
            <div style={{ padding: '40px 12px', textAlign: 'center', color: 'var(--color-apex-muted)', fontSize: 12.5 }}>
              Select a conversation, or start a new message.
            </div>
          ) : (
            <>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--color-apex-text)' }}>
                {selected}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto', minWidth: 0 }}>
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} />
                ))}
              </div>
              <ComposeBox toNumber={selected} onSent={refresh} />
            </>
          )}
        </div>
      </div>

      {/* Stack the two panes at narrow widths instead of squeezing a 260px
          rail — inline styles cannot media-query, so this one breakpoint
          rule lives in a scoped <style> tag rather than the object above. */}
      <style>{`
        @media (max-width: 700px) {
          .sms-layout { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </div>
  );
}
