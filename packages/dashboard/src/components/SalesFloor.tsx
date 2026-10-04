import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type OutboundPolicyView, type SalesFloorSnapshot } from '../lib/api.js';
import { describeRehearsalOutcome } from '../lib/rehearsal-outcome.js';
import { Headphones, MessageSquare, Phone, ShieldAlert } from 'lucide-react';

const fieldStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--color-apex-line)',
  background: 'rgba(0,0,0,0.28)',
  color: 'var(--color-apex-text)',
  fontSize: 13,
};

function modeLabel(mode: OutboundPolicyView['mode']): string {
  if (mode === 'rehearsal_only') return 'Rehearse on me';
  if (mode === 'capped_live') return 'Live within caps';
  return 'Off';
}

export function SalesFloor() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['sales-floor'],
    queryFn: () => api.salesFloor.floor(),
    refetchInterval: 3000,
  });
  const preview = useQuery({
    queryKey: ['rehearsal-preview'],
    queryFn: () => api.salesFloor.preview(),
  });

  if (isLoading) {
    return <div className="glass-card" style={{ padding: 20, color: 'var(--color-apex-muted)' }}>Loading the sales floor…</div>;
  }
  if (isError || !data) {
    return <div className="glass-card" style={{ padding: 20, color: 'var(--color-apex-red)' }}>{error instanceof Error ? error.message : 'Sales floor failed to load.'}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <PolicyCard policy={data.policy} worker={data.worker} />
      <RehearsalCard preview={preview.data} />
      <LiveCalls calls={data.calls} />
      <RecentEmails emails={data.emails} />
      <Suggestions suggestions={data.suggestions} onChanged={() => queryClient.invalidateQueries({ queryKey: ['sales-floor'] })} />
    </div>
  );
}

function PolicyCard({ policy, worker }: { policy: OutboundPolicyView; worker: SalesFloorSnapshot['worker'] }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(policy);
  const save = useMutation({
    mutationFn: () => api.salesFloor.savePolicy(draft),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sales-floor'] });
      queryClient.invalidateQueries({ queryKey: ['rehearsal-preview'] });
    },
  });
  const kill = useMutation({
    mutationFn: (on: boolean) => api.salesFloor.killSwitch(on),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sales-floor'] }),
  });

  return (
    <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="apex-display" style={{ fontSize: 16 }}>Sales floor</div>
          <div style={{ fontSize: 12, color: 'var(--color-apex-muted)', marginTop: 4 }}>
            {modeLabel(policy.mode)} · worker {worker.stale ? 'stale' : worker.status}
            {policy.killSwitch ? ' · kill switch on' : ''}
          </div>
        </div>
        <button className="btn-danger" onClick={() => kill.mutate(!policy.killSwitch)} disabled={kill.isPending}>
          <ShieldAlert size={14} /> {policy.killSwitch ? 'Resume outbound' : 'Kill switch'}
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))', gap: 10 }}>
        <select style={fieldStyle} value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as OutboundPolicyView['mode'] })}>
          <option value="off">Off</option>
          <option value="rehearsal_only">Rehearse on me</option>
          <option value="capped_live">Live within caps</option>
        </select>
        <input style={fieldStyle} placeholder="Your email" value={draft.rehearsalEmail ?? ''} onChange={(event) => setDraft({ ...draft, rehearsalEmail: event.target.value })} />
        <input style={fieldStyle} placeholder="Your phone" value={draft.rehearsalPhone ?? ''} onChange={(event) => setDraft({ ...draft, rehearsalPhone: event.target.value })} />
        <input style={fieldStyle} placeholder="Your name as the buyer" value={draft.personaName ?? ''} onChange={(event) => setDraft({ ...draft, personaName: event.target.value })} />
        <input style={fieldStyle} placeholder="Company you are playing" value={draft.personaCompany ?? ''} onChange={(event) => setDraft({ ...draft, personaCompany: event.target.value })} />
        <input style={fieldStyle} placeholder="Industry" value={draft.personaIndustry ?? ''} onChange={(event) => setDraft({ ...draft, personaIndustry: event.target.value })} />
        <input style={fieldStyle} placeholder="City" value={draft.personaCity ?? ''} onChange={(event) => setDraft({ ...draft, personaCity: event.target.value })} />
        <input style={fieldStyle} placeholder="Postal address for live email" value={draft.postalAddress ?? ''} onChange={(event) => setDraft({ ...draft, postalAddress: event.target.value })} />
      </div>
      {draft.mode === 'capped_live' && (
        <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>
          Live mode emails and calls real leads without asking each time, up to {draft.dailyEmailCap} emails and {draft.dailyCallCap} calls a day, between {draft.sendWindowStartHour}:00 and {draft.sendWindowEndHour}:00 {draft.timezone}. Deploy and shell stay gated.
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>Save profile</button>
        {save.isError && <span style={{ color: 'var(--color-apex-red)', fontSize: 12 }}>{save.error instanceof Error ? save.error.message : 'Save failed'}</span>}
      </div>
    </div>
  );
}

function RehearsalCard({ preview }: { preview?: { subject: string; body: string; firstMessage: string; profileComplete: boolean } }) {
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.salesFloor.rehearse(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sales-floor'] }),
  });
  return (
    <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="apex-display" style={{ fontSize: 15 }}>Sell to me</div>
      <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>
        Sends the designed intro to your email and calls your phone as if you were the client. Nothing else is contacted. If Pending sends is holding outbound work, the call is staged there instead of dialing immediately.
      </div>
      {preview && (
        <div style={{ fontSize: 12, color: 'var(--color-apex-text)', whiteSpace: 'pre-wrap' }}>
          <strong>{preview.subject}</strong>
          <div style={{ marginTop: 8 }}>{preview.body}</div>
          <div style={{ marginTop: 8, color: 'var(--color-apex-muted)' }}>Opens the call with: {preview.firstMessage}</div>
        </div>
      )}
      <button className="btn-primary" disabled={!preview?.profileComplete || run.isPending} onClick={() => run.mutate()}>
        {run.isPending ? 'Calling…' : 'Sell to me'}
      </button>
      {run.isError && <div style={{ color: 'var(--color-apex-red)', fontSize: 12 }}>{run.error instanceof Error ? run.error.message : 'Rehearsal failed'}</div>}
      {run.data && (
        <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>
          {describeRehearsalOutcome(run.data)}
        </div>
      )}
      {run.data?.awaitingSafeguard && (
        <button
          type="button"
          className="btn-secondary"
          onClick={() => window.dispatchEvent(new CustomEvent('apex:navigate', { detail: { page: 'pending-sends' } }))}
        >
          Open Pending sends
        </button>
      )}
    </div>
  );
}

function LiveCalls({ calls }: { calls: SalesFloorSnapshot['calls'] }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const join = useMutation({
    mutationFn: (input: { id: string; role: 'monitor' | 'whisper' | 'barge' }) => api.callBridge.join(input.id, input.role),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sales-floor'] }),
  });
  const coach = useMutation({
    mutationFn: (id: string) => api.callBridge.coach(id, note),
    onSuccess: () => {
      setNote('');
      queryClient.invalidateQueries({ queryKey: ['sales-floor'] });
    },
  });
  const live = calls.filter((call) => !['ended', 'failed'].includes(call.status));
  return (
    <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="apex-display" style={{ fontSize: 15 }}>Live calls</div>
      {live.length === 0 && <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>No call in progress. Vapi one-shot calls are not joinable from here.</div>}
      {live.map((call) => (
        <div key={call.id} style={{ borderTop: '1px solid var(--color-apex-line)', paddingTop: 10 }}>
          <div style={{ fontSize: 13 }}>{call.buyerName || call.customerNumber} · {call.status}{call.operatorJoinRole ? ` · you are ${call.operatorJoinRole}` : ''}</div>
          {call.transcriptTail && <div style={{ fontSize: 12, color: 'var(--color-apex-muted)', marginTop: 4 }}>{call.transcriptTail}</div>}
          {call.lastError && <div style={{ fontSize: 12, color: 'var(--color-apex-red)', marginTop: 4 }}>{call.lastError}</div>}
          {call.joinable && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <button className="btn-secondary" onClick={() => join.mutate({ id: call.id, role: 'monitor' })}><Headphones size={13} /> Listen</button>
              <button className="btn-secondary" onClick={() => join.mutate({ id: call.id, role: 'whisper' })}><MessageSquare size={13} /> Whisper</button>
              <button className="btn-secondary" onClick={() => join.mutate({ id: call.id, role: 'barge' })}><Phone size={13} /> Talk</button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8, minWidth: 0 }}>
            <input style={fieldStyle} placeholder="Coach note (stored on the call, not emailed)" value={note} onChange={(event) => setNote(event.target.value)} />
            <button className="btn-secondary" onClick={() => coach.mutate(call.id)} disabled={!note.trim()}>Save</button>
          </div>
          {call.coachNote && <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginTop: 4 }}>Note: {call.coachNote}</div>}
        </div>
      ))}
      {join.isError && <div style={{ color: 'var(--color-apex-red)', fontSize: 12 }}>{join.error instanceof Error ? join.error.message : 'Join failed'}</div>}
    </div>
  );
}

function RecentEmails({ emails }: { emails: SalesFloorSnapshot['emails'] }) {
  return (
    <div className="glass-card" style={{ padding: 16 }}>
      <div className="apex-display" style={{ fontSize: 15, marginBottom: 8 }}>Recent email</div>
      {emails.length === 0 && <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>No email sends yet.</div>}
      {emails.map((email) => (
        <div key={email.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '6px 0', borderTop: '1px solid var(--color-apex-line)' }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{email.toEmail} — {email.subject}</span>
          <span style={{ flex: 'none' }}>{email.status}{email.errorMessage ? `: ${email.errorMessage.slice(0, 80)}` : ''}</span>
        </div>
      ))}
    </div>
  );
}

function Suggestions({ suggestions, onChanged }: { suggestions: SalesFloorSnapshot['suggestions']; onChanged: () => void }) {
  const dismiss = useMutation({
    mutationFn: (fingerprint: string) => api.salesFloor.dismissSuggestion(fingerprint),
    onSuccess: onChanged,
  });
  if (suggestions.length === 0) return null;
  return (
    <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="apex-display" style={{ fontSize: 15 }}>What to do next</div>
      {suggestions.map((suggestion) => (
        <div key={suggestion.fingerprint} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>{suggestion.title}</div>
            <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>{suggestion.detail}</div>
          </div>
          <button className="btn-secondary" onClick={() => dismiss.mutate(suggestion.fingerprint)}>Dismiss</button>
        </div>
      ))}
    </div>
  );
}
