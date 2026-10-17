/**
 * CRM marketing-integrations guard. Pure only: it proves the connector registry,
 * credential validation/masking, subscriber mapping, the per-provider HTTP
 * request shapes and webhook normalisation on crafted inputs, then source-checks
 * the wiring (encrypted storage, operator gating, migration, dashboard). It
 * never touches Postgres.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKETING_CONNECTORS,
  MARKETING_PROVIDERS,
  buildProbeRequest,
  buildSubscriberRequest,
  isMarketingProvider,
  marketingConnector,
  maskCredentials,
  normalizeWebhookEvent,
  requiredCredentialFields,
  toSubscriber,
  validateCredentials,
  type Subscriber,
} from '../packages/core/src/crm/integrations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.GITHUB_WORKSPACE ?? path.resolve(here, '..');

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

const subscriber: Subscriber = {
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  company: 'Analytical Engines',
  phone: '+13125550100',
  tags: ['newsletter', 'vip'],
};

function pureChecks(): void {
  // ── Registry ──────────────────────────────────────────────────────────────
  assert.equal(MARKETING_PROVIDERS.length, 4, 'four marketing providers are known');
  assert.deepEqual([...MARKETING_PROVIDERS].sort(), ['activecampaign', 'hubspot', 'klaviyo', 'mailchimp']);
  for (const provider of MARKETING_PROVIDERS) {
    const connector = marketingConnector(provider);
    assert.ok(connector, `${provider} has a connector`);
    assert.ok(connector!.fields.length > 0, `${provider} declares credential fields`);
    assert.ok(connector!.capabilities.includes('audience_sync'), `${provider} can sync an audience`);
    assert.ok(connector!.fields.some((field) => field.secret), `${provider} marks at least one field secret`);
  }
  assert.equal(marketingConnector('salesforce'), null, 'an unknown provider has no connector');
  assert.equal(isMarketingProvider('mailchimp'), true);
  assert.equal(isMarketingProvider('salesforce'), false);
  assert.deepEqual(requiredCredentialFields('mailchimp'), ['apiKey', 'serverPrefix', 'listId']);
  assert.deepEqual(requiredCredentialFields('hubspot'), ['apiKey']);

  // ── Credential validation ─────────────────────────────────────────────────
  const incomplete = validateCredentials('mailchimp', { apiKey: 'k' });
  assert.equal(incomplete.ok, false, 'a missing required field fails validation');
  assert.deepEqual(incomplete.ok === false ? incomplete.missing : [], ['serverPrefix', 'listId']);
  const complete = validateCredentials('mailchimp', { apiKey: ' k ', serverPrefix: 'us2', listId: 'abc' });
  assert.equal(complete.ok, true, 'a complete credential passes');
  assert.equal(complete.ok === true ? complete.credentials.apiKey : '', 'k', 'credentials are trimmed');

  // ── Masking never leaks a secret ──────────────────────────────────────────
  const masked = maskCredentials('mailchimp', { apiKey: 'super-secret-key', serverPrefix: 'us1', listId: 'abc' });
  assert.equal(JSON.stringify(masked).includes('super-secret-key'), false, 'a secret value never leaves masking');
  const apiKeyField = masked.find((field) => field.key === 'apiKey');
  assert.equal(apiKeyField?.set, true, 'a set secret is reported as set');
  const listField = masked.find((field) => field.key === 'listId');
  assert.equal(listField?.set, true, 'a set non-secret is reported as set');

  // ── Subscriber mapping ────────────────────────────────────────────────────
  assert.equal(toSubscriber({ email: null, firstName: null, lastName: null, organizationName: null, phoneE164: null, tags: null }), null, 'a contact with no email is not pushable');
  assert.equal(toSubscriber({ email: 'not-an-email', firstName: null, lastName: null, organizationName: null, phoneE164: null, tags: null }), null, 'a malformed email is not pushable');
  const mapped = toSubscriber({ email: ' ADA@Example.com ', firstName: 'Ada', lastName: null, organizationName: 'X', phoneE164: null, tags: ['a', '', 'b'] });
  assert.equal(mapped?.email, 'ada@example.com', 'the email is normalised');
  assert.deepEqual(mapped?.tags, ['a', 'b'], 'empty tags are dropped');

  // ── Per-provider request shapes ───────────────────────────────────────────
  const mailchimp = buildSubscriberRequest('mailchimp', { apiKey: 'k', serverPrefix: 'us9', listId: 'list1' }, {}, subscriber);
  assert.equal(mailchimp.method, 'POST');
  assert.ok(mailchimp.url.startsWith('https://us9.api.mailchimp.com/3.0/lists/list1/members'), 'Mailchimp URL uses the server + list');
  assert.ok(mailchimp.headers.Authorization?.startsWith('Basic '), 'Mailchimp uses basic auth');
  assert.ok(mailchimp.body?.includes('email_address'), 'Mailchimp body carries the member');

  const klaviyo = buildSubscriberRequest('klaviyo', { apiKey: 'pk_1' }, {}, subscriber);
  assert.equal(klaviyo.url, 'https://a.klaviyo.com/api/profiles/');
  assert.equal(klaviyo.headers.Authorization, 'Klaviyo-API-Key pk_1');
  assert.ok(klaviyo.headers.revision, 'Klaviyo pins an API revision');

  const activecampaign = buildSubscriberRequest('activecampaign', { apiKey: 'tok', account: 'acme' }, {}, subscriber);
  assert.ok(activecampaign.url.startsWith('https://acme.api-us1.com/api/3/contact/sync'), 'Active Campaign URL uses the account');
  assert.equal(activecampaign.headers['Api-Token'], 'tok');

  const hubspot = buildSubscriberRequest('hubspot', { apiKey: 'pat-1' }, {}, subscriber);
  assert.equal(hubspot.url, 'https://api.hubapi.com/crm/v3/objects/contacts');
  assert.equal(hubspot.headers.Authorization, 'Bearer pat-1');
  assert.ok(hubspot.body?.includes('properties'), 'HubSpot body uses the properties envelope');

  // The audience from configuration wins over the credential's list id.
  const withAudience = buildSubscriberRequest('mailchimp', { apiKey: 'k', serverPrefix: 'us1', listId: 'fromcred' }, { audience: 'fromconfig' }, subscriber);
  assert.ok(withAudience.url.includes('fromconfig'), 'the stored audience overrides the credential list id');

  // ── Probe shapes ──────────────────────────────────────────────────────────
  for (const provider of MARKETING_PROVIDERS) {
    const probe = buildProbeRequest(provider, { apiKey: 'k', serverPrefix: 'us1', account: 'acme' }, {});
    assert.equal(probe.method, 'GET', `${provider} probe is a read`);
    assert.ok(probe.url.startsWith('https://'), `${provider} probe is https`);
  }

  // ── Webhook normalisation ─────────────────────────────────────────────────
  const unsub = normalizeWebhookEvent('mailchimp', { type: 'unsubscribe', data: { email: 'A@B.com' } });
  assert.equal(unsub?.kind, 'unsubscribe');
  assert.equal(unsub?.email, 'a@b.com', 'the webhook email is normalised');
  const bounce = normalizeWebhookEvent('klaviyo', { type: 'bounce', data: { email: 'x@y.com' } });
  assert.equal(bounce?.kind, 'bounce');
  const sub = normalizeWebhookEvent('hubspot', { event_type: 'contact.creation', email: 'c@d.com' });
  assert.equal(sub?.kind, 'subscribe');
  const other = normalizeWebhookEvent('activecampaign', { type: 'contact.updated' });
  assert.equal(other?.kind, 'other', 'an unrecognised event is kept, not dropped');
  assert.equal(normalizeWebhookEvent('mailchimp', null), null, 'a null body is refused');
  assert.equal(normalizeWebhookEvent('mailchimp', 'nope'), null, 'a non-object body is refused');
}

function sourceChecks(): void {
  const integrations = read('packages/core/src/crm/integrations.ts');
  // Credentials are encrypted at rest and never logged.
  assert.ok(integrations.includes('encrypt('), 'credentials are encrypted before storage');
  assert.ok(integrations.includes('decrypt('), 'credentials are decrypted only to build a request');
  assert.ok(integrations.includes('APEX_ENCRYPTION_KEY'), 'encryption needs the apex key');
  // This module must never send email or SMS: it is not on the send safeguard.
  assert.equal(/sendEmail|sendSms|commitSendRecord|commitSmsMessage|assertSendAllowed/.test(integrations), false, 'integrations never send a message');
  // Every audience push is recorded, success or failure.
  assert.ok(integrations.includes('recordSync'), 'every sync run is recorded');

  const index = read('packages/core/src/crm/index.ts');
  assert.ok(index.includes("'./integrations.js'"), 'integrations is exported from the barrel');

  const routes = read('packages/api-server/src/routes/crm.ts');
  for (const route of ["'/integrations'", "'/integrations/syncs'", "'/integrations/:provider'", "'/integrations/:provider/test'", "'/integrations/:provider/sync'", "'/integrations/:provider/webhook'"]) {
    assert.ok(routes.includes(`router.${route.startsWith("'/integrations'") || route.startsWith("'/integrations/syncs'") ? 'get' : 'post'}(${route}`) || routes.includes(`router.delete(${route}`) || routes.includes(`router.post(${route}`), `the ${route} route exists`);
  }
  // The privileged integration actions must ask for the operator dashboard session.
  for (const route of ["'/integrations/:provider/sync'", "'/integrations/:provider/webhook'"]) {
    const at = routes.indexOf(`router.post(${route}`);
    assert.ok(at > 0, `route ${route} exists`);
    const body = routes.slice(at, at + 2600);
    const end = body.indexOf('\n  router.');
    const handler = end > 0 ? body.slice(0, end) : body;
    assert.ok(handler.includes('requireOperatorSession'), `${route} requires the operator dashboard session`);
  }
  // Saving and deleting a credential are privileged too.
  const saveAt = routes.indexOf("router.post('/integrations/:provider'");
  assert.ok(saveAt > 0 && routes.slice(saveAt, saveAt + 1200).includes('requireOperatorSession'), 'saving a credential is operator-gated');
  const deleteAt = routes.indexOf("router.delete('/integrations/:provider'");
  assert.ok(deleteAt > 0 && routes.slice(deleteAt, deleteAt + 800).includes('requireOperatorSession'), 'deleting a credential is operator-gated');

  // The sync log table is schema-backed and applied by a registered migration.
  const schema = read('lib/db/src/schema-revenue-ops.ts');
  assert.ok(schema.includes("pgTable('crm_marketing_syncs'"), 'the sync log has a table');
  const migration = read('lib/db/drizzle/20261013_crm_phase3.sql');
  assert.equal(/DROP\s+(TABLE|COLUMN)/i.test(migration), false, 'the phase 3 migration is additive');
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS crm_marketing_syncs'), 'the migration creates the sync log');
  assert.ok(read('lib/db/src/crm-migration.ts').includes('20261013_crm_phase3.sql'), 'the phase 3 migration is applied at boot');

  const api = read('packages/dashboard/src/lib/api.ts');
  assert.ok(api.includes('integrations:'), 'the dashboard client exposes integrations');
  const panel = read('packages/dashboard/src/components/CrmIntegrationsPanel.tsx');
  assert.ok(panel.includes('export function CrmIntegrationsPanel'), 'the integrations panel is exported');
  assert.ok(panel.includes('api.crm.integrations.list'), 'the panel lists connections');
  const app = read('packages/dashboard/src/App.tsx');
  assert.ok(app.includes('CrmIntegrationsPanel'), 'the panel is registered in the app');
  assert.ok(app.includes("id: 'integrations'"), 'the integrations nav item exists');
}

pureChecks();
sourceChecks();
console.log('CRM integrations checks passed');
