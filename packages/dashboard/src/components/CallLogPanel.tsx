import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { api, type CallOutcome } from '../lib/api.js';
import { Phone, ChevronDown, ChevronRight, PhoneOff, Play, FileText } from 'lucide-react';

// APEX call attempts and provider call outcomes share call_outcomes. Cartesia
// call-event webhooks also append transcript and summary after the call.
// This is the one place that full history -- including calls that failed to
// dial at all -- is visible to a human rather than only living in agent
// reasoning/logs. UpcomingAppointments (SalesOpsPanel.tsx) shows the same
// table filtered to booked meetings only; this shows everything.

const DISPOSITION_COLOR: Record<CallOutcome['disposition'], string> = {
  appointment_booked: '#6a9f78',
  qualified: '#6a9f78',
  callback_requested: '#c9a84a',
  dnc: '#c45c66',
  not_interested: '#7d8a91',
  voicemail: '#7d8a91',
  no_answer: '#7d8a91',
  no_decision: '#5a9eae',
  failed_to_dial: '#c45c66',
};

const DISPOSITION_LABEL: Record<CallOutcome['disposition'], string> = {
  appointment_booked: 'Appointment booked',
  qualified: 'Qualified',
  callback_requested: 'Callback requested',
  dnc: 'Do not contact',
  not_interested: 'Not interested',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
  no_decision: 'No decision yet',
  failed_to_dial: 'Failed to dial',
};

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/** Loads the recording only when asked (audio is large and most rows are never
 *  played), through the authenticated API so the bearer token is sent. */
function RecordingPlayer({ callId }: { callId: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [src, setSrc] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  // Release the object URL when the row closes or the component unmounts.
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const load = async () => {
    setState('loading');
    setMessage('');
    try {
      const blob = await api.salesOps.recordingBlob(callId);
      setSrc(URL.createObjectURL(blob));
      setState('ready');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not load the recording.');
      setState('error');
    }
  };

  if (state === 'ready' && src) {
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio controls autoPlay src={src} style={{ width: '100%', maxWidth: 420, height: 34 }} />;
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button
        onClick={load}
        disabled={state === 'loading'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', fontSize: 11,
          borderRadius: 4, cursor: state === 'loading' ? 'wait' : 'pointer',
          background: 'rgba(245,166,35,0.12)', color: '#f5a623', border: '1px solid rgba(245,166,35,0.4)',
        }}
      >
        <Play size={11} /> {state === 'loading' ? 'Loading audio...' : 'Listen to call'}
      </button>
      {state === 'error' && <span style={{ fontSize: 11, color: '#c45c66' }}>{message}</span>}
    </div>
  );
}

/** Transcript fetched on demand so it is reachable even when the list payload
 *  was trimmed, and clearly says so when a call has none stored. */
function TranscriptViewer({ callId, inline }: { callId: string; inline: string | null }) {
  const [text, setText] = useState<string | null>(inline);
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>(inline ? 'done' : 'idle');
  const [open, setOpen] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && state === 'idle') {
      setState('loading');
      try {
        const res = await api.salesOps.transcript(callId);
        setText(res.transcript);
        setState('done');
      } catch {
        setState('error');
      }
    }
  };

  return (
    <div>
      <button
        onClick={toggle}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', fontSize: 11,
          borderRadius: 4, cursor: 'pointer', background: 'rgba(255,255,255,0.05)',
          color: 'var(--color-apex-text)', border: '1px solid rgba(255,255,255,0.14)',
        }}
      >
        <FileText size={11} /> {open ? 'Hide transcript' : 'View transcript'}
      </button>
      {open && (
        <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', lineHeight: 1.5, maxHeight: 300, overflowY: 'auto', marginTop: 6, whiteSpace: 'pre-wrap' }}>
          {state === 'loading' && 'Loading transcript...'}
          {state === 'error' && 'Could not load the transcript.'}
          {state === 'done' && (text?.trim() ? text : 'No transcript was stored for this call.')}
        </div>
      )}
    </div>
  );
}

function CallRow({ call }: { call: CallOutcome }) {
  const [open, setOpen] = useState(false);
  const color = DISPOSITION_COLOR[call.disposition] ?? '#7d8a91';
  // Every call is expandable: audio and transcript load on demand, so even a
  // row with no stored text can still be listened to.
  const hasDetail = call.disposition !== 'failed_to_dial' || Boolean(call.endedReason);

  return (
    <div style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <button
        onClick={() => hasDetail && setOpen(!open)}
        disabled={!hasDetail}
        style={{
          display: 'flex',
          width: '100%',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          padding: '8px 0',
          background: 'none',
          border: 'none',
          color: 'var(--color-apex-text)',
          cursor: hasDetail ? 'pointer' : 'default',
          textAlign: 'left',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
          {hasDetail ? (
            open ? <ChevronDown size={12} /> : <ChevronRight size={12} style={{ opacity: 0.6 }} />
          ) : (
            <span style={{ width: 12 }} />
          )}
          {call.disposition === 'failed_to_dial' ? (
            <PhoneOff size={12} style={{ color, flex: 'none' }} />
          ) : (
            <Phone size={12} style={{ opacity: 0.6, flex: 'none' }} />
          )}
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {call.customerName ? `${call.customerName} (${call.customerNumber})` : call.customerNumber}
          </span>
        </span>
        <span style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              background: `${color}1f`,
              color,
              border: `1px solid ${color}55`,
              whiteSpace: 'nowrap',
            }}
          >
            {DISPOSITION_LABEL[call.disposition] ?? call.disposition}
          </span>
          <span style={{ color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {formatWhen(call.createdAt)}
          </span>
        </span>
      </button>
      {open && hasDetail && (
        <div style={{ margin: '2px 0 10px', padding: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {call.disposition === 'failed_to_dial' && call.endedReason && (
            <div style={{ fontSize: 11, color: '#c45c66' }}>
              <strong>Why it failed:</strong> {call.endedReason}
            </div>
          )}
          {call.disposition !== 'failed_to_dial' && call.endedReason && (
            <div style={{ fontSize: 11, color: 'var(--color-apex-muted)' }}>
              <strong style={{ color: 'var(--color-apex-text)' }}>Ended:</strong> {call.endedReason}
              {call.costUsd != null && ` · $${call.costUsd.toFixed(3)}`}
            </div>
          )}
          {call.summary && (
            <div style={{ fontSize: 11, color: 'var(--color-apex-muted)' }}>
              <strong style={{ color: 'var(--color-apex-text)' }}>Summary:</strong> {call.summary}
            </div>
          )}
          {call.objection && (
            <div style={{ fontSize: 11, color: 'var(--color-apex-muted)' }}>
              <strong style={{ color: 'var(--color-apex-text)' }}>Objection:</strong> {call.objection}
            </div>
          )}
          {call.nextAction && (
            <div style={{ fontSize: 11, color: 'var(--color-apex-muted)' }}>
              <strong style={{ color: 'var(--color-apex-text)' }}>Next action:</strong> {call.nextAction}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 }}>
            <RecordingPlayer callId={call.callId} />
            <TranscriptViewer callId={call.callId} inline={call.transcript} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Call history, including outbound attempts rejected before dialing and
 *  Cartesia calls. Complements UpcomingAppointments, which
 *  only shows booked meetings; this is the "what has it actually done" view. */
export function CallLogPanel() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['sales-ops-call-log'],
    queryFn: () => api.salesOps.callOutcomes({ limit: 50 }),
    refetchInterval: 15000,
  });

  const calls = data?.outcomes ?? [];
  const failed = calls.filter((c) => c.disposition === 'failed_to_dial').length;

  return (
    <motion.div className="glass-card" style={{ padding: 18 }} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-apex-text)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Phone size={16} /> Call log
        </div>
        <div style={{ fontSize: 11, color: failed > 0 ? '#c45c66' : 'var(--color-apex-muted)' }}>
          {calls.length} recent{failed > 0 ? ` · ${failed} failed to dial` : ''}
        </div>
      </div>

      {isLoading && <div style={{ color: 'var(--color-apex-muted)', fontSize: 13 }}>Loading…</div>}
      {isError && (
        <div style={{ color: 'var(--color-apex-red)', fontSize: 13, fontFamily: 'var(--font-mono)' }}>
          Failed to load: {error instanceof Error ? error.message : String(error)}
        </div>
      )}
      {!isLoading && !isError && calls.length === 0 && (
        <div style={{ color: 'var(--color-apex-muted)', fontSize: 13 }}>No calls recorded yet.</div>
      )}

      {calls.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {calls.map((c) => <CallRow key={c.id} call={c} />)}
        </div>
      )}
    </motion.div>
  );
}
