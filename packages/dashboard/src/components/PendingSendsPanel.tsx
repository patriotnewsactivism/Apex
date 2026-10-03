import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SendJobView } from '../lib/api.js';
import { useWebSocket } from '../hooks/useWebSocket.js';

const STATUS_LABEL: Record<string, string> = {
  waiting_confirm: 'waiting for confirm',
  waiting_second_confirm: 'waiting for confirm',
  waiting_code: 'waiting for code',
  waiting_release: 'waiting for confirm',
  sending: 'code entered, sending',
  stopped: 'stopped',
  completed: 'completed',
  voided: 'voided',
};

function preview(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 280 ? `${clean.slice(0, 280)}…` : clean;
}

export function PendingSendsPanel() {
  const queryClient = useQueryClient();
  const { lastEvent } = useWebSocket();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [newCode, setNewCode] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);

  const jobs = useQuery({
    queryKey: ['send-safeguard', lastEvent?.type === 'send-safeguard:status' ? lastEvent.timestamp : 'idle'],
    queryFn: () => api.sendSafeguard.list(),
    refetchInterval: 5000,
  });

  const selected = jobs.data?.jobs.find((job) => job.id === selectedId) ?? jobs.data?.jobs[0] ?? null;
  const locked = jobs.data?.locked === true;
  const liveLabel = lastEvent?.type === 'send-safeguard:status' ? lastEvent.label : null;

  async function run(action: () => Promise<unknown>, ok: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(ok);
      await queryClient.invalidateQueries({ queryKey: ['send-safeguard'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%', maxWidth: '100%', minWidth: 0 }}>
      <section className="glass-card" style={{ padding: 16, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 13, color: 'var(--color-apex-muted)' }}>Outbound gate</div>
            <h2 style={{ margin: '4px 0 0', fontSize: 18 }}>Pending sends</h2>
          </div>
          <div style={{ fontSize: 13, color: locked ? '#f2b8b5' : 'var(--color-apex-muted)' }}>
            {locked ? 'locked' : liveLabel ?? 'live'}
          </div>
        </div>
        {error && <p style={{ color: '#f2b8b5', marginBottom: 0 }}>{error}</p>}
        {notice && <p style={{ color: 'var(--color-apex-muted)', marginBottom: 0 }}>{notice}</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {(jobs.data?.jobs ?? []).length === 0 && <p style={{ margin: 0, color: 'var(--color-apex-muted)' }}>No send jobs yet.</p>}
          {(jobs.data?.jobs ?? []).map((job) => (
            <button
              key={job.id}
              type="button"
              onClick={() => setSelectedId(job.id)}
              style={{
                textAlign: 'left',
                width: '100%',
                minWidth: 0,
                background: selected?.id === job.id ? 'rgba(255,255,255,0.06)' : 'transparent',
                border: '1px solid var(--color-apex-line)',
                borderRadius: 8,
                padding: 10,
                color: 'inherit',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ overflowWrap: 'anywhere' }}>{STATUS_LABEL[job.status] ?? job.status}</strong>
                <span>{job.count} outbound</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-apex-muted)', overflowWrap: 'anywhere' }}>
                {(job.campaignKey && `campaign ${job.campaignKey}`) || (job.storyKey && `story ${job.storyKey}`) || job.id}
              </div>
            </button>
          ))}
        </div>
      </section>

      {selected && <JobDetail job={selected} onRun={run} onCode={() => setShowCode(true)} />}

      {showCode && selected && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(8,10,14,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 50 }}>
          <form
            className="glass-card"
            style={{ padding: 16, width: 'min(420px, 100%)', display: 'flex', flexDirection: 'column', gap: 10 }}
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => api.sendSafeguard.code(selected.id, code), 'Code accepted for this job.').then(() => {
                setCode('');
                setShowCode(false);
              });
            }}
          >
            <strong>Four-digit send code</strong>
            <p style={{ margin: 0, color: 'var(--color-apex-muted)' }}>
              {selected.count} outbound message{selected.count === 1 ? '' : 's'} in this job. This code clears this job only.
            </p>
            <input
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 4))}
              style={{ fontSize: 24, letterSpacing: 8, padding: 8, width: '100%' }}
            />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="submit" disabled={code.length !== 4}>Enter code</button>
              <button type="button" onClick={() => setShowCode(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <section className="glass-card" style={{ padding: 16, minWidth: 0 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Send code</h2>
        <p style={{ color: 'var(--color-apex-muted)' }}>
          Set or change the four-digit code. Re-enter the operator password. The code is stored as a salted hash.
        </p>
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 420 }}
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => api.sendSafeguard.setCode(newCode, password), 'Send code updated.').then(() => setNewCode(''));
          }}
        >
          <input
            inputMode="numeric"
            autoComplete="off"
            placeholder="4-digit code"
            maxLength={4}
            value={newCode}
            onChange={(event) => setNewCode(event.target.value.replace(/\D/g, '').slice(0, 4))}
            style={{ padding: 8, width: '100%' }}
          />
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Operator password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            style={{ padding: 8, width: '100%' }}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="submit" disabled={newCode.length !== 4 || password.length === 0}>Save code</button>
            <button
              type="button"
              disabled={!locked || password.length === 0}
              onClick={() => void run(() => api.sendSafeguard.unlock(password), 'Sending unlocked.')}
            >
              Unlock sending
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function JobDetail({
  job,
  onRun,
  onCode,
}: {
  job: SendJobView;
  onRun: (action: () => Promise<unknown>, ok: string) => Promise<void>;
  onCode: () => void;
}) {
  const stopping = job.status === 'sending' || job.status === 'waiting_release' || job.status === 'waiting_code' || job.status === 'waiting_confirm' || job.status === 'waiting_second_confirm';
  return (
    <section className="glass-card" style={{ padding: 16, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ color: 'var(--color-apex-muted)', fontSize: 13 }}>{STATUS_LABEL[job.status] ?? job.status}</div>
          <h2 style={{ margin: '4px 0' }}>{job.count} outbound message{job.count === 1 ? '' : 's'}</h2>
        </div>
        {stopping && (
          <button type="button" onClick={() => void onRun(() => api.sendSafeguard.stop(job.id), 'Send job stopped.')}>
            Stop
          </button>
        )}
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
        <input
          type="checkbox"
          checked={job.fullAuto}
          onChange={(event) => void onRun(() => api.sendSafeguard.fullAuto(job.id, event.target.checked), 'Full auto updated for this job.')}
        />
        Full auto after the final gate
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" disabled={Boolean(job.confirm1At)} onClick={() => void onRun(() => api.sendSafeguard.confirm(job.id, 1), 'First confirmation recorded.')}>
          Confirm send ({job.count})
        </button>
        <button type="button" disabled={!job.confirm1At || Boolean(job.confirm2At)} onClick={() => void onRun(() => api.sendSafeguard.confirm(job.id, 2), 'Second confirmation recorded.')}>
          Confirm again ({job.count})
        </button>
        {job.status === 'waiting_code' && <button type="button" onClick={onCode}>Enter code</button>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {job.recipients.filter((row) => row.status !== 'voided').map((row) => (
          <article key={row.id} style={{ borderTop: '1px solid var(--color-apex-line)', paddingTop: 8, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ overflowWrap: 'anywhere' }}>{row.channel} · {row.destination}</strong>
              <span>{row.status}</span>
            </div>
            <p style={{ margin: '6px 0', overflowWrap: 'anywhere' }}>{preview(row.messageText)}</p>
            {!job.fullAuto && job.confirm2At && row.status === 'queued' && (
              <button type="button" onClick={() => void onRun(() => api.sendSafeguard.release(job.id, row.id), 'Recipient released.')}>
                Send this one
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
