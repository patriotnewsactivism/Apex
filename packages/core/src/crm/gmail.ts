/**
 * Read-only Gmail sync. Disabled unless APEX_CRM_GMAIL_SYNC=true.
 * Scope is gmail.readonly only. This module never sends mail.
 */
import { eq } from 'drizzle-orm';
import { crmOauthTokens, db, decrypt, encrypt } from '@workspace/db';
import { artifactAttachmentStorage } from './attachments.js';
import { ingestInboundEmail } from './inbound.js';
import { GMAIL_READONLY_SCOPE, gmailSyncEnabled } from './pure.js';

const GMAIL_LIST = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

export function gmailAuthUrl(state: string): string | null {
  if (!gmailSyncEnabled()) return null;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const redirect = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !redirect) return null;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('scope', GMAIL_READONLY_SCOPE);
  url.searchParams.set('state', state);
  return url.toString();
}

function assertReadonlyScope(scope: string): void {
  const parts = scope.split(/\s+/).filter(Boolean);
  if (parts.some((part) => part !== GMAIL_READONLY_SCOPE && !part.endsWith('/auth/gmail.readonly'))) {
    throw new Error('Gmail sync accepts the gmail.readonly scope only.');
  }
}

export async function saveGmailReadonlyToken(input: {
  accountEmail: string;
  refreshToken: string;
  accessToken?: string | null;
  scope?: string | null;
}): Promise<void> {
  if (!gmailSyncEnabled()) throw new Error('Gmail sync is disabled. Set APEX_CRM_GMAIL_SYNC=true to store a token.');
  const scope = input.scope?.trim() || GMAIL_READONLY_SCOPE;
  assertReadonlyScope(scope);
  const key = process.env.APEX_ENCRYPTION_KEY;
  if (!key) throw new Error('APEX_ENCRYPTION_KEY is required to store Gmail tokens.');
  const encryptedToken = await encrypt({
    refreshToken: input.refreshToken,
    accessToken: input.accessToken ?? null,
    scope,
  }, key);
  await db.insert(crmOauthTokens).values({
    provider: 'google',
    accountEmail: input.accountEmail.toLowerCase(),
    encryptedToken,
    scope,
  }).onConflictDoUpdate({
    target: [crmOauthTokens.provider, crmOauthTokens.accountEmail],
    set: { encryptedToken, scope, updatedAt: new Date() },
  });
}

interface GmailList {
  messages?: Array<{ id: string }>;
}

interface GmailMessage {
  id: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{ mimeType?: string; body?: { data?: string; size?: number }; filename?: string }>;
  };
}

function header(message: GmailMessage, name: string): string | null {
  const found = message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase());
  return found?.value ?? null;
}

function decodeBody(data: string | undefined): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** Poll Gmail for mail to or from known contacts. No-op unless the setting is on. */
export async function syncGmailReadonly(): Promise<{ enabled: boolean; logged: number }> {
  if (!gmailSyncEnabled()) return { enabled: false, logged: 0 };
  const key = process.env.APEX_ENCRYPTION_KEY;
  if (!key) return { enabled: true, logged: 0 };
  const rows = await db.select().from(crmOauthTokens).where(eq(crmOauthTokens.provider, 'google'));
  let logged = 0;
  for (const row of rows) {
    assertReadonlyScope(row.scope);
    const token = await decrypt(row.encryptedToken, key);
    const accessToken = typeof token.accessToken === 'string' ? token.accessToken : '';
    if (!accessToken) continue;
    const listRes = await fetch(`${GMAIL_LIST}?maxResults=20&q=${encodeURIComponent('newer_than:2d')}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) continue;
    const list = await listRes.json() as GmailList;
    for (const item of list.messages ?? []) {
      const messageRes = await fetch(`${GMAIL_LIST}/${encodeURIComponent(item.id)}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!messageRes.ok) continue;
      const message = await messageRes.json() as GmailMessage;
      const from = header(message, 'From') ?? '';
      const to = header(message, 'To') ?? '';
      const result = await ingestInboundEmail({
        from,
        to: to.split(',').map((part) => part.trim()).filter(Boolean),
        subject: header(message, 'Subject'),
        text: decodeBody(message.payload?.body?.data) || decodeBody(message.payload?.parts?.find((part) => part.mimeType === 'text/plain')?.body?.data),
        html: decodeBody(message.payload?.parts?.find((part) => part.mimeType === 'text/html')?.body?.data),
        messageId: header(message, 'Message-ID'),
        inReplyTo: header(message, 'In-Reply-To'),
        references: header(message, 'References'),
        providerMessageId: `gmail:${message.id}`,
      }, { storage: artifactAttachmentStorage() });
      if (result.matched || result.unmatchedId) logged += 1;
    }
  }
  return { enabled: true, logged };
}
