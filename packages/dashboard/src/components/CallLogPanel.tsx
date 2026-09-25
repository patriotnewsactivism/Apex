import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { api, type CallOutcome } from '../lib/api.js';
import { Phone, ChevronDown, ChevronRight, PhoneOff } from 'lucide-react';

// Every make_outbound_call attempt now writes a call_outcomes row the instant
// Vapi either accepts or rejects the request (see tool-registry.ts), instead
// of only existing once a webhook eventually reports the call as finished.
// This is the one place that full history -- including calls that failed to
// dial at all -- is visible to a human rather than only living in agent
// reasoning/logs. UpcomingAppointments (SalesOpsPanel.tsx) shows the same
// table filtered to booked meetings only; this shows everything.

const DISPOSITION_COLOR: Record<CallOutcome['disposition'], string> = {
  appointment_booked: '#6a9f78',
  callback_requested: '#c9a84a',
  not_interested: '#7d8a91',
  voicemail: '#7d8a91',
  no_answer: '#7d8a91',
  no_decision: '#5a9eae',
  failed_to_dial: '#c45c66',
};

const DISPOSITION_LABEL: Record<CallOutcome['disposition'], string> = {
  appointment_booked: 'Appointment booked',
  callback_requested: 'Callback requested',
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

function CallRow({ call }: { call: CallOutcome }) {
  const [open, setOpen] = useState(false);
  const color = DISPOSITION_COLOR[call.disposition] ?? '#7d8a91';
  const hasDetail = Boolean(call.transcript || call.summary || call.objection || call.nextAction || call.endedReason);

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
          {call.transcript && (
            <details>
              <summary style={{ fontSize: 11, color: 'var(--color-apex-muted)', cursor: 'pointer' }}>Full transcript</summary>
              <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', lineHeight: 1.5, maxHeight: 260, overflowY: 'auto', marginTop: 6, whiteSpace: 'pre-wrap' }}>
                {call.transcript}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/** Full outbound call history -- every attempt APEX has made, including ones
 *  Vapi rejected before ever dialing. Complements UpcomingAppointments, which
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
        <div style={{ color: 'var(--color-apex-muted)', fontSize: 13 }}>No outbound calls yet.</div>
      )}

      {calls.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {calls.map((c) => <CallRow key={c.id} call={c} />)}
        </div>
      )}
    </motion.div>
  );
}
