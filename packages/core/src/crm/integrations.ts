/**
 * CRM marketing-tool integrations.
 *
 * The CRM already knew how to talk to a person (contacts, timeline, email
 * automation) and how to store a credential (the encrypted provider_connections
 * table), but there was no connector that carried a CRM audience out to the
 * marketing tool a client actually uses. This module adds that: a small registry
 * of Mailchimp / Klaviyo / Active Campaign / HubSpot connectors, an encrypted
 * credential store on top of provider_connections, an audience push whose HTTP
 * layer is injectable (so it can be proven without a network), and webhook
 * normalisation so a provider unsubscribe lands as a CRM opt-out.
 *
 * Nothing here sends email or SMS, so it does not go through the send
 * safeguard; the only outbound is an audience sync the operator explicitly
 * triggers, and every run is recorded in crm_marketing_syncs.
 */
import { and, desc, eq } from 'drizzle-orm';
import { crmMarketingSyncs, db, decrypt, encrypt, providerConnections } from '@workspace/db';
import { CRM_ORGANIZATION_ID } from './pure.js';

export const MARKETING_CONNECTION_TYPE = 'marketing';

export class CrmIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrmIntegrationError';
  }
}

// ─── Connector registry ─────────────────────────────────────────────────────

export type MarketingProvider = 'mailchimp' | 'klaviyo' | 'activecampaign' | 'hubspot';

export const MARKETING_PROVIDERS: readonly MarketingProvider[] = ['mailchimp', 'klaviyo', 'activecampaign', 'hubspot'];

export function isMarketingProvider(value: unknown): value is MarketingProvider {
  return typeof value === 'string' && (MARKETING_PROVIDERS as readonly string[]).includes(value);
}

export type MarketingCapability = 'audience_sync' | 'campaign_push' | 'webhook_ingest';

export interface ConnectorField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
}

export interface MarketingConnector {
  id: MarketingProvider;
  name: string;
  description: string;
  docsUrl: string;
  category: 'marketing';
  capabilities: MarketingCapability[];
  fields: ConnectorField[];
  /** The credential field that names the audience/list to push into. */
  audienceField: string;
}

export const MARKETING_CONNECTORS: MarketingConnector[] = [
  {
    id: 'mailchimp',
    name: 'Mailchimp',
    description: 'Push CRM contacts into a Mailchimp audience and mirror unsubscribes back.',
    docsUrl: 'https://mailchimp.com/developer/marketing/api/list-members/',
    category: 'marketing',
    capabilities: ['audience_sync', 'webhook_ingest'],
    audienceField: 'listId',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, required: true, placeholder: 'xxxxxxxx-us1' },
      { key: 'serverPrefix', label: 'Server prefix', secret: false, required: true, placeholder: 'us1' },
      { key: 'listId', label: 'Audience (list) id', secret: false, required: true, placeholder: 'a1b2c3d4e5' },
    ],
  },
  {
    id: 'klaviyo',
    name: 'Klaviyo',
    description: 'Create or update Klaviyo profiles from the CRM contact book.',
    docsUrl: 'https://developers.klaviyo.com/en/reference/create_profile',
    category: 'marketing',
    capabilities: ['audience_sync', 'webhook_ingest'],
    audienceField: 'listId',
    fields: [
      { key: 'apiKey', label: 'Private API key', secret: true, required: true, placeholder: 'pk_...' },
      { key: 'listId', label: 'List id', secret: false, required: false, placeholder: 'Rk...' },
    ],
  },
  {
    id: 'activecampaign',
    name: 'Active Campaign',
    description: 'Sync contacts into Active Campaign via the contact sync endpoint.',
    docsUrl: 'https://developers.activecampaign.com/reference/sync-a-contacts-data',
    category: 'marketing',
    capabilities: ['audience_sync', 'webhook_ingest'],
    audienceField: 'listId',
    fields: [
      { key: 'apiKey', label: 'API token', secret: true, required: true },
      { key: 'account', label: 'Account name', secret: false, required: true, placeholder: 'youraccount' },
      { key: 'listId', label: 'List id', secret: false, required: false },
    ],
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'Upsert CRM contacts as HubSpot contacts.',
    docsUrl: 'https://developers.hubspot.com/docs/api/crm/contacts',
    category: 'marketing',
    capabilities: ['audience_sync', 'webhook_ingest'],
    audienceField: 'listId',
    fields: [
      { key: 'apiKey', label: 'Private app token', secret: true, required: true, placeholder: 'pat-...' },
      { key: 'listId', label: 'List id', secret: false, required: false },
    ],
  },
];

export function marketingConnector(id: string): MarketingConnector | null {
  return MARKETING_CONNECTORS.find((connector) => connector.id === id) ?? null;
}

export function requiredCredentialFields(id: MarketingProvider): string[] {
  const connector = marketingConnector(id);
  if (!connector) return [];
  return connector.fields.filter((field) => field.required).map((field) => field.key);
}

// ─── Credential validation + masking ────────────────────────────────────────

export type CredentialValidation =
  | { ok: true; credentials: Record<string, string> }
  | { ok: false; missing: string[] };

/** Trim every credential and require the connector's mandatory fields. */
export function validateCredentials(id: MarketingProvider, input: Record<string, unknown>): CredentialValidation {
  const connector = marketingConnector(id);
  if (!connector) return { ok: false, missing: [] };
  const credentials: Record<string, string> = {};
  for (const field of connector.fields) {
    const raw = input[field.key];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value) credentials[field.key] = value;
  }
  const missing = connector.fields.filter((field) => field.required && !credentials[field.key]).map((field) => field.key);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, credentials };
}

export interface MaskedField {
  key: string;
  label: string;
  secret: boolean;
  set: boolean;
}

/**
 * The only shape credentials ever leave this module in. A secret's value is
 * never returned — only whether it is set — so a settings screen can render the
 * form without the API ever echoing a key back.
 */
export function maskCredentials(id: MarketingProvider, credentials: Record<string, unknown>): MaskedField[] {
  const connector = marketingConnector(id);
  if (!connector) return [];
  return connector.fields.map((field) => ({
    key: field.key,
    label: field.label,
    secret: field.secret,
    set: typeof credentials[field.key] === 'string' && (credentials[field.key] as string).length > 0,
  }));
}

// ─── Subscriber mapping ─────────────────────────────────────────────────────

export interface CrmContactLike {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
  phoneE164: string | null;
  tags: string[] | null;
}

export interface Subscriber {
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  phone: string | null;
  tags: string[];
}

/** A contact is pushable only when it has a usable email. */
export function toSubscriber(contact: CrmContactLike): Subscriber | null {
  const email = (contact.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  return {
    email,
    firstName: contact.firstName?.trim() || null,
    lastName: contact.lastName?.trim() || null,
    company: contact.organizationName?.trim() || null,
    phone: contact.phoneE164?.trim() || null,
    tags: Array.isArray(contact.tags) ? contact.tags.filter((tag) => typeof tag === 'string' && tag.length > 0) : [],
  };
}

// ─── HTTP request builders (pure) ───────────────────────────────────────────

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  headers: Record<string, string>;
  body?: string;
}

function credential(credentials: Record<string, string>, key: string): string {
  return credentials[key] ?? '';
}

/**
 * The provider-specific request that creates or updates one subscriber. Kept
 * pure and exported so a guard can assert the URL, auth header and body shape
 * for every connector without a network.
 */
export function buildSubscriberRequest(
  provider: MarketingProvider,
  credentials: Record<string, string>,
  configuration: Record<string, unknown>,
  subscriber: Subscriber,
): HttpRequest {
  const audience = typeof configuration.audience === 'string' ? configuration.audience : credential(credentials, 'listId');
  switch (provider) {
    case 'mailchimp': {
      const server = credential(credentials, 'serverPrefix') || 'us1';
      const listId = audience || credential(credentials, 'listId');
      const auth = Buffer.from(`anystring:${credential(credentials, 'apiKey')}`).toString('base64');
      return {
        url: `https://${server}.api.mailchimp.com/3.0/lists/${encodeURIComponent(listId)}/members`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
        body: JSON.stringify({
          email_address: subscriber.email,
          status_if_new: 'subscribed',
          merge_fields: { FNAME: subscriber.firstName ?? '', LNAME: subscriber.lastName ?? '' },
          tags: subscriber.tags,
        }),
      };
    }
    case 'klaviyo': {
      return {
        url: 'https://a.klaviyo.com/api/profiles/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Klaviyo-API-Key ${credential(credentials, 'apiKey')}`,
          revision: '2024-10-15',
        },
        body: JSON.stringify({
          data: {
            type: 'profile',
            attributes: {
              email: subscriber.email,
              first_name: subscriber.firstName,
              last_name: subscriber.lastName,
              organization: subscriber.company,
              phone_number: subscriber.phone,
            },
          },
        }),
      };
    }
    case 'activecampaign': {
      const account = credential(credentials, 'account') || 'account';
      return {
        url: `https://${account}.api-us1.com/api/3/contact/sync`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Api-Token': credential(credentials, 'apiKey') },
        body: JSON.stringify({
          contact: {
            email: subscriber.email,
            firstName: subscriber.firstName ?? '',
            lastName: subscriber.lastName ?? '',
            phone: subscriber.phone ?? '',
            fieldValues: subscriber.tags.map((tag) => ({ field: 'tags', value: tag })),
          },
        }),
      };
    }
    case 'hubspot': {
      return {
        url: 'https://api.hubapi.com/crm/v3/objects/contacts',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential(credentials, 'apiKey')}` },
        body: JSON.stringify({
          properties: {
            email: subscriber.email,
            firstname: subscriber.firstName ?? '',
            lastname: subscriber.lastName ?? '',
            company: subscriber.company ?? '',
            phone: subscriber.phone ?? '',
          },
        }),
      };
    }
  }
}

/** A cheap read used by the "test connection" button. */
export function buildProbeRequest(
  provider: MarketingProvider,
  credentials: Record<string, string>,
  configuration: Record<string, unknown>,
): HttpRequest {
  switch (provider) {
    case 'mailchimp': {
      const server = credential(credentials, 'serverPrefix') || 'us1';
      const auth = Buffer.from(`anystring:${credential(credentials, 'apiKey')}`).toString('base64');
      return { url: `https://${server}.api.mailchimp.com/3.0/ping`, method: 'GET', headers: { Authorization: `Basic ${auth}` } };
    }
    case 'klaviyo':
      return {
        url: 'https://a.klaviyo.com/api/accounts/',
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Klaviyo-API-Key ${credential(credentials, 'apiKey')}`, revision: '2024-10-15' },
      };
    case 'activecampaign': {
      const account = credential(credentials, 'account') || 'account';
      return {
        url: `https://${account}.api-us1.com/api/3/contacts?limit=1`,
        method: 'GET',
        headers: { 'Api-Token': credential(credentials, 'apiKey') },
      };
    }
    case 'hubspot':
      return {
        url: 'https://api.hubapi.com/crm/v3/objects/contacts?limit=1',
        method: 'GET',
        headers: { Authorization: `Bearer ${credential(credentials, 'apiKey')}` },
      };
  }
}

// ─── Webhook normalisation (pure) ───────────────────────────────────────────

export type WebhookKind = 'subscribe' | 'unsubscribe' | 'bounce' | 'other';

export interface NormalizedWebhookEvent {
  provider: MarketingProvider;
  kind: WebhookKind;
  email: string | null;
  eventType: string;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  }
  return null;
}

/**
 * Map a provider webhook body to one CRM-relevant event. Only an unsubscribe or
 * a bounce is actionable (it becomes a do-not-contact); everything else is
 * recorded as "other" so nothing is silently dropped.
 */
export function normalizeWebhookEvent(provider: MarketingProvider, body: unknown): NormalizedWebhookEvent | null {
  if (body === null || typeof body !== 'object') return null;
  const record = Array.isArray(body) ? (body[0] as Record<string, unknown>) : (body as Record<string, unknown>);
  if (!record || typeof record !== 'object') return null;
  const data = (record.data as Record<string, unknown> | undefined) ?? {};
  const attributes = (data.attributes as Record<string, unknown> | undefined) ?? {};
  const eventType = firstString(record.type, record.event_type, record.event, record.subscriptionType) ?? 'unknown';
  const email = firstString(
    data.email,
    data.email_address,
    attributes.email,
    record.email,
    record.email_address,
    (record.contact as Record<string, unknown> | undefined)?.email,
  );
  let kind: WebhookKind = 'other';
  if (/unsub|remove|deactivat/.test(eventType)) kind = 'unsubscribe';
  else if (/bounce|cleaned|spam|complain/.test(eventType)) kind = 'bounce';
  else if (/subscrib|creat|add|insert|new/.test(eventType)) kind = 'subscribe';
  return { provider, kind, email, eventType };
}

// ─── Encrypted credential storage ───────────────────────────────────────────

function encryptionKey(): string {
  const key = process.env.APEX_ENCRYPTION_KEY;
  if (!key) throw new CrmIntegrationError('APEX_ENCRYPTION_KEY is not set; refusing to store marketing credentials in the clear.');
  return key;
}

async function encryptCredentials(credentials: Record<string, string>): Promise<Record<string, unknown>> {
  const ciphertext = await encrypt(credentials, encryptionKey());
  return { v: 1, ciphertext };
}

async function decryptCredentials(stored: Record<string, unknown> | null | undefined): Promise<Record<string, string>> {
  if (!stored) return {};
  const ciphertext = typeof stored.ciphertext === 'string' ? stored.ciphertext : null;
  if (!ciphertext) return {};
  const plain = await decrypt(ciphertext, encryptionKey());
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(plain)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export interface MarketingConnectionView {
  provider: MarketingProvider;
  name: string;
  status: string;
  externalAccountId: string | null;
  audience: string | null;
  fields: MaskedField[];
  capabilities: MarketingCapability[];
  createdAt: string;
  updatedAt: string;
}

export async function listMarketingConnections(): Promise<MarketingConnectionView[]> {
  const rows = await db
    .select()
    .from(providerConnections)
    .where(and(eq(providerConnections.organizationId, CRM_ORGANIZATION_ID), eq(providerConnections.type, MARKETING_CONNECTION_TYPE)));
  const views: MarketingConnectionView[] = [];
  for (const row of rows) {
    if (!isMarketingProvider(row.provider)) continue;
    let credentials: Record<string, string> = {};
    try {
      credentials = await decryptCredentials(row.encryptedCredentials);
    } catch {
      credentials = {};
    }
    const configuration = (row.configuration ?? {}) as Record<string, unknown>;
    views.push({
      provider: row.provider,
      name: row.name,
      status: row.status,
      externalAccountId: row.externalAccountId,
      audience: typeof configuration.audience === 'string' ? configuration.audience : null,
      fields: maskCredentials(row.provider, credentials),
      capabilities: marketingConnector(row.provider)?.capabilities ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  return views.sort((a, b) => a.provider.localeCompare(b.provider));
}

export interface SaveMarketingConnectionInput {
  provider: MarketingProvider;
  name?: string;
  credentials: Record<string, unknown>;
  audience?: string | null;
  externalAccountId?: string | null;
}

export async function saveMarketingConnection(input: SaveMarketingConnectionInput): Promise<{ provider: MarketingProvider; id: string }> {
  const connector = marketingConnector(input.provider);
  if (!connector) throw new CrmIntegrationError(`Unknown marketing provider "${input.provider}".`);
  const validation = validateCredentials(input.provider, input.credentials);
  if (!validation.ok) {
    throw new CrmIntegrationError(`Missing required credential field(s): ${validation.missing.join(', ')}.`);
  }
  const encryptedCredentials = await encryptCredentials(validation.credentials);
  const configuration: Record<string, unknown> = {};
  if (input.audience) configuration.audience = input.audience;
  const name = input.name?.trim() || connector.name;
  const [row] = await db
    .insert(providerConnections)
    .values({
      organizationId: CRM_ORGANIZATION_ID,
      provider: input.provider,
      type: MARKETING_CONNECTION_TYPE,
      name,
      encryptedCredentials,
      externalAccountId: input.externalAccountId ?? null,
      status: 'connected',
      configuration,
    })
    .onConflictDoUpdate({
      target: [providerConnections.organizationId, providerConnections.provider, providerConnections.type],
      set: {
        name,
        encryptedCredentials,
        externalAccountId: input.externalAccountId ?? null,
        status: 'connected',
        configuration,
        updatedAt: new Date(),
      },
    })
    .returning({ id: providerConnections.id });
  if (!row) throw new CrmIntegrationError('The connection could not be saved.');
  return { provider: input.provider, id: row.id };
}

export async function deleteMarketingConnection(provider: MarketingProvider): Promise<{ removed: boolean }> {
  const rows = await db
    .delete(providerConnections)
    .where(
      and(
        eq(providerConnections.organizationId, CRM_ORGANIZATION_ID),
        eq(providerConnections.provider, provider),
        eq(providerConnections.type, MARKETING_CONNECTION_TYPE),
      ),
    )
    .returning({ id: providerConnections.id });
  return { removed: rows.length > 0 };
}

async function loadConnection(provider: MarketingProvider): Promise<{ id: string; credentials: Record<string, string>; configuration: Record<string, unknown> } | null> {
  const [row] = await db
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.organizationId, CRM_ORGANIZATION_ID),
        eq(providerConnections.provider, provider),
        eq(providerConnections.type, MARKETING_CONNECTION_TYPE),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    credentials: await decryptCredentials(row.encryptedCredentials),
    configuration: (row.configuration ?? {}) as Record<string, unknown>,
  };
}

// ─── HTTP layer (injectable) ────────────────────────────────────────────────

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponseLike>;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

// ─── Test + sync ────────────────────────────────────────────────────────────

export interface ConnectionTestResult {
  provider: MarketingProvider;
  status: 'connected' | 'invalid_key' | 'degraded' | 'not_configured';
  detail: string;
  httpStatus: number | null;
}

export async function testMarketingConnection(provider: MarketingProvider, fetchImpl: FetchLike = defaultFetch): Promise<ConnectionTestResult> {
  const connection = await loadConnection(provider);
  if (!connection) return { provider, status: 'not_configured', detail: 'No credentials stored for this provider.', httpStatus: null };
  const request = buildProbeRequest(provider, connection.credentials, connection.configuration);
  try {
    const response = await fetchImpl(request.url, { method: request.method, headers: request.headers, body: request.body });
    if (response.ok) return { provider, status: 'connected', detail: 'The provider accepted the credential.', httpStatus: response.status };
    if (response.status === 401 || response.status === 403) return { provider, status: 'invalid_key', detail: 'The provider rejected the credential.', httpStatus: response.status };
    return { provider, status: 'degraded', detail: `The provider returned HTTP ${response.status}.`, httpStatus: response.status };
  } catch (error) {
    return { provider, status: 'degraded', detail: `The probe failed: ${error instanceof Error ? error.message : String(error)}`, httpStatus: null };
  }
}

export interface MarketingSyncResult {
  provider: MarketingProvider;
  status: 'ok' | 'partial' | 'error';
  pushed: number;
  skipped: number;
  failed: number;
  errors: string[];
  syncId: string;
}

export interface SyncAudienceInput {
  provider: MarketingProvider;
  actor: string;
  contacts: CrmContactLike[];
  fetchImpl?: FetchLike;
  /** Cap on how many subscribers one run will push. */
  limit?: number;
}

/**
 * Push an audience to the provider. A contact without an email is skipped (not
 * failed); a non-2xx response is failed. The run is recorded either way, so the
 * history is honest even when every call errors.
 */
export async function syncAudience(input: SyncAudienceInput): Promise<MarketingSyncResult> {
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  const connection = await loadConnection(input.provider);
  const startedAt = new Date();
  if (!connection) {
    const syncId = await recordSync({
      provider: input.provider,
      connectionId: null,
      status: 'error',
      pushed: 0,
      skipped: 0,
      failed: 0,
      error: 'No credentials stored for this provider.',
      actor: input.actor,
      startedAt,
      audience: null,
    });
    throw Object.assign(new CrmIntegrationError('No credentials stored for this provider.'), { syncId });
  }
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 2000);
  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const contact of input.contacts.slice(0, limit)) {
    const subscriber = toSubscriber(contact);
    if (!subscriber) {
      skipped += 1;
      continue;
    }
    const request = buildSubscriberRequest(input.provider, connection.credentials, connection.configuration, subscriber);
    try {
      const response = await fetchImpl(request.url, { method: request.method, headers: request.headers, body: request.body });
      if (response.ok) pushed += 1;
      else {
        failed += 1;
        if (errors.length < 10) errors.push(`${subscriber.email}: HTTP ${response.status}`);
      }
    } catch (error) {
      failed += 1;
      if (errors.length < 10) errors.push(`${subscriber.email}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const status: MarketingSyncResult['status'] = failed === 0 ? 'ok' : pushed > 0 ? 'partial' : 'error';
  const audience = typeof connection.configuration.audience === 'string' ? connection.configuration.audience : null;
  const syncId = await recordSync({
    provider: input.provider,
    connectionId: connection.id,
    status,
    pushed,
    skipped,
    failed,
    error: errors[0] ?? null,
    actor: input.actor,
    startedAt,
    audience,
    metadata: { errors },
  });
  return { provider: input.provider, status, pushed, skipped, failed, errors, syncId };
}

interface RecordSyncInput {
  provider: MarketingProvider;
  connectionId: string | null;
  status: 'ok' | 'partial' | 'error';
  pushed: number;
  skipped: number;
  failed: number;
  error: string | null;
  actor: string;
  startedAt: Date;
  audience: string | null;
  metadata?: Record<string, unknown>;
}

async function recordSync(input: RecordSyncInput): Promise<string> {
  const [row] = await db
    .insert(crmMarketingSyncs)
    .values({
      organizationId: CRM_ORGANIZATION_ID,
      provider: input.provider,
      connectionId: input.connectionId,
      direction: 'push',
      status: input.status,
      audience: input.audience,
      pushed: input.pushed,
      skipped: input.skipped,
      failed: input.failed,
      error: input.error,
      createdBy: input.actor,
      startedAt: input.startedAt,
      finishedAt: new Date(),
      metadata: input.metadata ?? {},
    })
    .returning({ id: crmMarketingSyncs.id });
  return row?.id ?? '';
}

export interface MarketingSyncRow {
  id: string;
  provider: string;
  status: string;
  audience: string | null;
  pushed: number;
  skipped: number;
  failed: number;
  error: string | null;
  createdBy: string;
  startedAt: string;
  finishedAt: string | null;
}

export async function listMarketingSyncs(provider?: MarketingProvider, limit = 50): Promise<MarketingSyncRow[]> {
  const clauses = [eq(crmMarketingSyncs.organizationId, CRM_ORGANIZATION_ID)];
  if (provider) clauses.push(eq(crmMarketingSyncs.provider, provider));
  const rows = await db
    .select()
    .from(crmMarketingSyncs)
    .where(and(...clauses))
    .orderBy(desc(crmMarketingSyncs.startedAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    status: row.status,
    audience: row.audience,
    pushed: row.pushed,
    skipped: row.skipped,
    failed: row.failed,
    error: row.error,
    createdBy: row.createdBy,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  }));
}
