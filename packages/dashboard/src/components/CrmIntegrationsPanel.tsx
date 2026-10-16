/**
 * CRM phase 3: marketing-tool integrations.
 *
 * A connector carries a CRM audience out to the marketing tool a client
 * actually uses. The panel lists every connector the registry knows, shows the
 * ones already wired up (with their credential fields masked — a secret's value
 * is never echoed back), and lets the operator store a credential, test it,
 * push an audience, and read the run history.
 *
 * Storing a credential, deleting one, pushing an audience and applying a
 * provider webhook all need the operator dashboard session, the same as any
 * other privileged CRM action. The panel says so rather than pretending a click
 * landed when it did not.
 */
import { useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CrmMarketingConnection, type CrmMarketingConnector } from '../lib/api.js';

const wrap: CSSProperties = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0, maxWidth: '100%' };
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0 };
const label: CSSProperties = { fontSize: 12, color: 'var(--color-apex-muted)' };
const input: CSSProperties = { flex: '1 1 160px', minWidth: 0, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-apex-line)', background: 'rgba(0,0,0,0.28)', color: 'var(--color-apex-text)' };
const button: CSSProperties = { padding: '6px 10px' };
const card: CSSProperties = { minWidth: 0, padding: 12, borderRadius: 10, background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.10)' };

function statusTone(status: string): string {
  if (status === 'connected' || status === 'ok') return 'var(--color-apex-brass)';
  if (status === 'partial' || status === 'degraded') return '#d9a441';
  if (status === 'error' || status === 'invalid_key') return '#e06c6c';
  return 'var(--color-apex-muted)';
}

function ConnectorCard({ connector, connection }: { connector: CrmMarketingConnector; connection?: CrmMarketingConnection }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [audience, setAudience] = useState(connection?.audience ?? '');
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['crm-integrations'] });

  const save = useMutation({
    mutationFn: () =>
      api.crm.integrations.save(connector.id, {
        credentials: values,
        audience: audience || undefined,
      }),
    onSuccess: () => { setNotice('Credentials stored.'); setValues({}); refresh(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not store the credentials.'),
  });
  const test = useMutation({
    mutationFn: () => api.crm.integrations.test(connector.id),
    onSuccess: (result) => setNotice(`${result.status}: ${result.detail}`),
    onError: (error) => setNotice(error instanceof Error ? error.message : 'The test failed.'),
  });
  const sync = useMutation({
    mutationFn: () => api.crm.integrations.sync(connector.id, { limit: 500 }),
    onSuccess: (result) => {
      setNotice(`Pushed ${result.pushed}, skipped ${result.skipped}, failed ${result.failed}.`);
      refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'The sync failed.'),
  });
  const remove = useMutation({
    mutationFn: () => api.crm.integrations.remove(connector.id),
    onSuccess: () => { setNotice('Connection removed.'); refresh(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not remove the connection.'),
  });

  const busy = save.isPending || test.isPending || sync.isPending || remove.isPending;

  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={row}>
        <span style={{ fontWeight: 700 }}>{connector.name}</span>
        {connection ? (
          <span style={{ ...label, color: statusTone(connection.status) }}>● {connection.status}</span>
        ) : (
          <span style={label}>not configured</span>
        )}
        <a href={connector.docsUrl} target="_blank" rel="noreferrer" style={{ ...label, marginLeft: 'auto' }}>docs</a>
      </div>
      <div style={{ ...label, ...wrap }}>{connector.description}</div>
      {connection && (
        <div style={{ ...row, gap: 6 }}>
          {connection.fields.map((field) => (
            <span key={field.key} style={{ ...label, padding: '2px 6px', borderRadius: 6, background: 'rgba(255,255,255,0.06)' }}>
              {field.label}: {field.set ? 'set' : 'missing'}
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {connector.fields.map((field) => (
          <input
            key={field.key}
            aria-label={`${connector.name} ${field.label}`}
            type={field.secret ? 'password' : 'text'}
            placeholder={field.placeholder ?? field.label}
            value={values[field.key] ?? ''}
            onChange={(event) => setValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
            style={{ ...input, flex: '1 1 100%' }}
          />
        ))}
        <input
          aria-label={`${connector.name} audience`}
          placeholder={connector.audienceField}
          value={audience}
          onChange={(event) => setAudience(event.target.value)}
          style={{ ...input, flex: '1 1 100%' }}
        />
      </div>
      <div style={row}>
        <button
          type="button"
          className="btn-primary"
          style={button}
          disabled={busy || Object.values(values).every((value) => !value.trim())}
          onClick={() => save.mutate()}
        >
          Save (Matthew)
        </button>
        <button type="button" style={button} disabled={busy || !connection} onClick={() => test.mutate()}>Test</button>
        <button type="button" style={button} disabled={busy || !connection} onClick={() => sync.mutate()}>Push audience (Matthew)</button>
        <button type="button" style={button} disabled={busy || !connection} onClick={() => remove.mutate()}>Remove (Matthew)</button>
      </div>
      {notice && <div style={{ ...wrap, fontSize: 13 }}>{notice}</div>}
    </div>
  );
}

function WebhookTester() {
  const [provider, setProvider] = useState('mailchimp');
  const [payload, setPayload] = useState('{"type":"unsubscribe","data":{"email":"someone@example.com"}}');
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useMutation({
    mutationFn: () => api.crm.integrations.webhook(provider, JSON.parse(payload)),
    onSuccess: (result) => {
      setNotice(
        result.event.kind === 'other'
          ? `Recorded a "${result.event.eventType}" event (no opt-out applied).`
          : `${result.event.kind} for ${result.event.email ?? 'unknown'}: ${result.appliedContactIds.length} contact(s) opted out.`,
      );
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not apply the webhook.'),
  });

  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 700 }}>Apply a provider webhook</div>
      <div style={{ ...label, ...wrap }}>
        Paste a provider payload to normalise it and, for an unsubscribe or bounce, set the matching contact
        do-not-contact. Needs the operator session.
      </div>
      <div style={row}>
        <select aria-label="Webhook provider" value={provider} onChange={(event) => setProvider(event.target.value)} style={input}>
          <option value="mailchimp">Mailchimp</option>
          <option value="klaviyo">Klaviyo</option>
          <option value="activecampaign">Active Campaign</option>
          <option value="hubspot">HubSpot</option>
        </select>
      </div>
      <textarea
        aria-label="Webhook payload"
        value={payload}
        onChange={(event) => setPayload(event.target.value)}
        rows={3}
        style={{ ...input, flex: '1 1 100%', fontFamily: 'monospace' }}
      />
      <div style={row}>
        <button type="button" style={button} disabled={apply.isPending} onClick={() => apply.mutate()}>Apply (Matthew)</button>
      </div>
      {notice && <div style={{ ...wrap, fontSize: 13 }}>{notice}</div>}
    </div>
  );
}

export function CrmIntegrationsPanel() {
  const query = useQuery({ queryKey: ['crm-integrations'], queryFn: () => api.crm.integrations.list() });
  const connectors = query.data?.connectors ?? [];
  const connections = query.data?.connections ?? [];
  const syncs = query.data?.syncs ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, maxWidth: '100%' }}>
      <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <div style={row}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Marketing integrations</div>
          <span style={label}>Push a CRM audience out; mirror unsubscribes back.</span>
        </div>
        {query.isError && <div style={wrap}>Could not load integrations.</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {connectors.map((connector) => (
            <ConnectorCard
              key={connector.id}
              connector={connector}
              connection={connections.find((c) => c.provider === connector.id)}
            />
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div className="glass-card" style={{ padding: 16, flex: '1 1 380px', minWidth: 0 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Recent syncs</div>
          {syncs.length === 0 && <span style={label}>No audience syncs recorded yet.</span>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {syncs.map((sync) => (
              <div key={sync.id} style={{ ...row, gap: 10 }}>
                <span style={{ ...wrap, flex: '0 0 110px', fontWeight: 600 }}>{sync.provider}</span>
                <span style={{ ...label, color: statusTone(sync.status), flex: '0 0 70px' }}>{sync.status}</span>
                <span style={{ ...label, ...wrap, flex: '1 1 140px' }}>
                  {sync.pushed} pushed · {sync.skipped} skipped · {sync.failed} failed
                </span>
                <span style={{ ...label, flex: '0 0 150px', textAlign: 'right' }}>{new Date(sync.startedAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ flex: '1 1 380px', minWidth: 0 }}>
          <WebhookTester />
        </div>
      </div>
    </div>
  );
}
