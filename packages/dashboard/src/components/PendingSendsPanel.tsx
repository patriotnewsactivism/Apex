import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, KeyRound, ShieldAlert, Square, Unlock } from 'lucide-react';
import { api, type SendSafeguardJobDetail, type SendSafeguardJobListItem } from '../lib/api.js';
import { useWebSocket } from '../hooks/useWebSocket.js';

const card: React.CSSProperties = {
  background: 'rgba(0,0,0,0.22)',
  border: '1px solid var(--color-apex-line)',
  borderRadius: 10,
  padding: 14,
  minWidth: 0,
};

const btn = (kind: 'primary' | 'danger' | 'ghost' = 'ghost'): React.CSSProperties => ({
  border: '1px solid var(--color-apex-line)',
  background: kind === 'danger' ? 'rgba(180,40,40,0.18)' : kind === 'primary' ? 'var(--color-apex-brass-soft)' : 'transparent',
  color: kind === 'primary' ? 'var(--color-apex-brass)' : 'var(--color-apex-text)',
  borderRadius: 6,
  padding: '8px 12px',
  fontSize: 12,
  cursor: 'pointer',
  minWidth: 0,
});

export function PendingSendsPanel() {
  const queryClient = useQueryClient();
  const { lastEvent } = useWebSocket();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [newCode, setNewCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const jobs = useQuery({
    queryKey: ['send-safeguard', 'jobs'],
    queryFn: () => api.sendSafeguard.list(),
    refetchInterval: 8000,
  });
  const settings = useQuery({
    queryKey: ['send-safeguard', 'settings'],
    queryFn: () => api.sendSafeguard.settings(),
    refetchInterval: 15000,
  });
  const detail = useQuery({
    queryKey: ['send-safeguard', 'job', selectedId],
    queryFn: () => api.sendSafeguard.get(selectedId!),
    enabled: Boolean(selectedId),
  });

  useEffect(() => {
    if (lastEvent?.type === 'send-safeguard:status') {
      void queryClient.invalidateQueries({ queryKey: ['send-safeguard'] });
    }
  }, [lastEvent, queryClient]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['send-safeguard'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const confirm = useMutation({
    mutationFn: ({ id, step }: { id: string; step: 1 | 2 }) => api.sendSafeguard.confirm(id, step),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['send-safeguard'] }),
    onError: (err: Error) => setError(err.message),
  });

  const rows = jobs.data?.jobs ?? [];
  const job: SendSafeguardJobDetail | undefined = detail.data;
  const locked = Boolean(settings.data?.locked);

  return (
    <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <div className="glass-card" style={{ padding: 16, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', letterSpacing: 0.4 }}>SEND SAFEGUARD</div>
            <h2 style={{ margin: '4px 0 0', fontSize: 20 }}>Pending sends</h2>
            <p style={{ margin: '6px 0 0', color: 'var(--color-apex-muted)', fontSize: 13 }}>
              Nothing goes out until you confirm twice
              {job?.codeRequired || rows.some((row) => row.codeRequired) ? ' and, for 5+ aggregated recipients, enter the 4-digit code' : ''}
              .
            </p>
          </div>
          {locked && (
            <div style={{ ...card, color: 'var(--color-apex-red)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <ShieldAlert size={16} /> Sending locked after failed codes
            </div>
          )}
        </div>
        {error && <div style={{ marginTop: 10, color: 'var(--color-apex-red)', fontSize: 12 }}>{error}</div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
        <div className="glass-card" style={{ padding: 12, minWidth: 0, overflow: 'auto' }}>
          {rows.length === 0 && <div style={{ color: 'var(--color-apex-muted)', fontSize: 13 }}>No send jobs yet.</div>}
          {rows.map((row: SendSafeguardJobListItem) => (
            <button
              key={row.job.id}
              onClick={() => setSelectedId(row.job.id)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '10px 8px',
                border: 'none',
                borderBottom: '1px solid var(--color-apex-line)',
                background: selectedId === row.job.id ? 'var(--color-apex-brass-soft)' : 'transparent',
                color: 'var(--color-apex-text)',
                cursor: 'pointer',
                minWidth: 0,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>{row.publicStatus}</div>
              <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>
                {row.job.recipientCount} recipient{row.job.recipientCount === 1 ? '' : 's'} · {row.job.channelSummary}
                {row.codeRequired ? ` · code required (aggregated ${row.aggregatedCount})` : ''}
              </div>
            </button>
          ))}
        </div>

        {job && (
          <div className="glass-card" style={{ padding: 16, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>{job.publicStatus}</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{job.job.recipientCount} outbound message{job.job.recipientCount === 1 ? '' : 's'}</div>
              </div>
              {!['stopped', 'voided', 'cancelled', 'completed'].includes(job.job.status) && (
                <button style={btn('danger')} onClick={() => run(() => api.sendSafeguard.stop(job.job.id))}>
                  <Square size={12} /> Stop
                </button>
              )}
            </div>

            <pre style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 12,
              background: 'rgba(0,0,0,0.28)',
              padding: 10,
              borderRadius: 8,
              maxHeight: 180,
              overflow: 'auto',
            }}
            >
              {job.job.messageText}
            </pre>

            <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
              {job.recipients.map((recipient) => (
                <div key={recipient.id} style={card}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{recipient.channel} → {recipient.destination}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-apex-muted)' }}>{recipient.status}</div>
                  <div style={{ fontSize: 12, marginTop: 6, wordBreak: 'break-word' }}>{recipient.messageText.slice(0, 280)}</div>
                  {!job.job.fullAuto && job.job.status === 'cleared' && recipient.status === 'pending' && (
                    <button style={{ ...btn('primary'), marginTop: 8 }} onClick={() => run(() => api.sendSafeguard.release(job.job.id, recipient.id))}>
                      Release this send
                    </button>
                  )}
                </div>
              ))}
            </div>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={job.job.fullAuto}
                onChange={(e) => run(() => api.sendSafeguard.setFullAuto(job.job.id, e.target.checked))}
              />
              Full auto after the final gate
            </label>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              <button style={btn('primary')} disabled={Boolean(job.job.confirm1At)} onClick={() => confirm.mutate({ id: job.job.id, step: 1 })}>
                Confirm 1 of 2
              </button>
              <button style={btn('primary')} disabled={!job.job.confirm1At || Boolean(job.job.confirm2At)} onClick={() => confirm.mutate({ id: job.job.id, step: 2 })}>
                Confirm 2 of 2
              </button>
            </div>

            {job.codeRequired && (
              <div style={{ ...card, marginTop: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>4-digit code required</div>
                <input
                  inputMode="numeric"
                  maxLength={4}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="••••"
                  style={{ width: 90, padding: 8, borderRadius: 6, border: '1px solid var(--color-apex-line)', background: 'rgba(0,0,0,0.28)', color: 'inherit' }}
                />
                <button style={{ ...btn('primary'), marginLeft: 8 }} onClick={() => run(() => api.sendSafeguard.submitCode(job.job.id, code))}>
                  Enter code
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="glass-card" style={{ padding: 16, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Operator code</div>
        <div style={{ fontSize: 12, color: 'var(--color-apex-muted)', marginBottom: 10 }}>
          {settings.data?.codeSet ? 'A code is set.' : 'No code is set yet.'} Re-enter your operator password to change it.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="password"
            placeholder="Operator password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ flex: '1 1 160px', minWidth: 0, padding: 8, borderRadius: 6, border: '1px solid var(--color-apex-line)', background: 'rgba(0,0,0,0.28)', color: 'inherit' }}
          />
          <input
            inputMode="numeric"
            maxLength={4}
            placeholder="New 4-digit code"
            value={newCode}
            onChange={(e) => setNewCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
            style={{ width: 140, padding: 8, borderRadius: 6, border: '1px solid var(--color-apex-line)', background: 'rgba(0,0,0,0.28)', color: 'inherit' }}
          />
          <button style={btn('primary')} onClick={() => run(() => api.sendSafeguard.setCode(newCode, password))}>
            <KeyRound size={12} /> Set code
          </button>
          {locked && (
            <button style={btn('danger')} onClick={() => run(() => api.sendSafeguard.unlock(password))}>
              <Unlock size={12} /> Unlock
            </button>
          )}
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-apex-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Ban size={12} /> The code is never shown after it is saved. Three wrong tries lock all sending.
        </div>
      </div>
    </div>
  );
}
