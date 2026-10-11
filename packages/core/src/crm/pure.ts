/**
 * Pure CRM rules. No database imports, so guards can run without Postgres.
 */
import crypto from 'node:crypto';

export const CRM_ORGANIZATION_ID = 'apex';
export const CRM_DISPLAY_TIMEZONE = 'America/Chicago';
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const OPERATOR_ACTOR = 'Matthew';

const OPT_OUT_EXACT = /^(stop|stopall|unsubscribe|cancel|end|quit|remove me)[.!\s]*$/i;
const OPT_OUT_PHRASE = /\b(unsubscribe|remove me)\b/i;

export function isOptOutMessage(text: string | null | undefined): { matched: boolean; phrase: string | null } {
  const raw = (text ?? '').trim();
  if (!raw) return { matched: false, phrase: null };
  if (OPT_OUT_EXACT.test(raw)) return { matched: true, phrase: raw.replace(/[.!\s]+$/g, '').toLowerCase() };
  const phrase = raw.match(OPT_OUT_PHRASE);
  if (phrase?.[1]) return { matched: true, phrase: phrase[1].toLowerCase() };
  return { matched: false, phrase: null };
}

export function codeCheckBody(passed: boolean): 'pass' | 'fail' {
  return passed ? 'pass' : 'fail';
}

/** Confirmation and code-check timeline text never includes the code. */
export function codeCheckTimelineText(passed: boolean, code: string | null | undefined): 'pass' | 'fail' {
  void code;
  return codeCheckBody(passed);
}

export function newReplyToken(bytes: Buffer = crypto.randomBytes(9)): string {
  return bytes.toString('base64url');
}

export function replyDomain(): string | null {
  const domain = process.env.APEX_REPLY_DOMAIN?.trim().toLowerCase() ?? '';
  return domain.length > 0 ? domain : null;
}

export function replyToAddress(token: string, domain: string | null = replyDomain()): string | null {
  if (!domain) return null;
  return `r+${token}@${domain}`;
}

export function bccCaptureEnabled(): boolean {
  return process.env.APEX_CRM_BCC_CAPTURE === 'true';
}

export function gmailSyncEnabled(): boolean {
  return process.env.APEX_CRM_GMAIL_SYNC === 'true';
}

export function bccCaptureAddress(domain: string | null = replyDomain()): string | null {
  if (!domain || !bccCaptureEnabled()) return null;
  return `bcc@${domain}`;
}

export function parseReplyToken(address: string | null | undefined): string | null {
  if (!address) return null;
  const match = address.match(/r\+([a-zA-Z0-9_-]+)@/i);
  return match?.[1] ?? null;
}

export function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8) return `+${digits}`;
  return null;
}

export function extractEmailAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const bracket = raw.match(/<([^>]+)>/);
  const value = (bracket?.[1] ?? raw).trim().toLowerCase();
  if (!value.includes('@')) return null;
  return value;
}

export function extractEmailAddresses(raw: string | string[] | null | undefined): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const out: string[] = [];
  for (const part of parts) {
    const email = extractEmailAddress(part);
    if (email) out.push(email);
  }
  return out;
}

export function headerMessageIds(header: string | null | undefined): string[] {
  if (!header) return [];
  const ids = header.match(/<[^>]+>/g);
  if (ids && ids.length > 0) return ids.map((id) => id.trim());
  return header.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

export interface InboundMatchIndex {
  tokens: Map<string, string>;
  messageIds: Map<string, string>;
  emails: Map<string, string>;
}

export interface InboundMatchInput {
  recipients: string[];
  fromEmail: string | null;
  inReplyTo: string | null;
  references: string | null;
}

export type InboundMatch =
  | { matched: true; contactId: string; basis: 'token' | 'headers' | 'sender' }
  | { matched: false };

/** Reply token, then In-Reply-To/References against a stored Message-ID, then sender. */
export function matchInboundEmail(input: InboundMatchInput, index: InboundMatchIndex): InboundMatch {
  for (const recipient of input.recipients) {
    const token = parseReplyToken(recipient);
    if (!token) continue;
    const contactId = index.tokens.get(token);
    if (contactId) return { matched: true, contactId, basis: 'token' };
  }
  const headerIds = [
    ...headerMessageIds(input.inReplyTo),
    ...headerMessageIds(input.references),
  ];
  for (const id of headerIds) {
    const contactId = index.messageIds.get(id) ?? index.messageIds.get(id.toLowerCase());
    if (contactId) return { matched: true, contactId, basis: 'headers' };
  }
  if (input.fromEmail) {
    const contactId = index.emails.get(input.fromEmail.toLowerCase());
    if (contactId) return { matched: true, contactId, basis: 'sender' };
  }
  return { matched: false };
}

export function isBccCaptureRecipient(recipients: string[], domain: string | null = replyDomain()): boolean {
  if (!bccCaptureEnabled() || !domain) return false;
  const target = `bcc@${domain}`;
  return recipients.some((address) => extractEmailAddress(address) === target);
}

export interface DoNotContactState {
  doNotContact: boolean;
  reason: string | null;
  setBy: string | null;
}

export function sendBlockedByDoNotContact(state: DoNotContactState | null): boolean {
  return Boolean(state?.doNotContact);
}

export class SendBlockedError extends Error {
  readonly code = 'do_not_contact';
  constructor(message: string) {
    super(message);
    this.name = 'SendBlockedError';
  }
}

export function assertDoNotContactClear(state: DoNotContactState | null): void {
  if (!sendBlockedByDoNotContact(state)) return;
  throw new SendBlockedError(
    `Do-not-contact is set (${state?.reason ?? 'unspecified'}, by ${state?.setBy ?? 'unknown'}). Send blocked.`,
  );
}

export function clearDoNotContactAllowed(actor: string): boolean {
  return actor === OPERATOR_ACTOR;
}

/**
 * Where a person stands with you: prospect (researched, never contacted), lead
 * (contacted, no reply yet), qualified (they answered and it fits), client
 * (paying), churned (was a client, is not any more).
 */
export const CONTACT_LIFECYCLE_STAGES = ['prospect', 'lead', 'qualified', 'client', 'churned'] as const;
export type ContactLifecycleStage = (typeof CONTACT_LIFECYCLE_STAGES)[number];

export function isContactLifecycleStage(value: unknown): value is ContactLifecycleStage {
  return typeof value === 'string' && (CONTACT_LIFECYCLE_STAGES as readonly string[]).includes(value);
}

/**
 * Who may move a client status or lift a recorded opt-out. Same rule as
 * clearing do-not-contact and merging: the operator alone. Agents hold the
 * admin token, so the actor is never taken from an agent tool.
 */
export function lifecycleStageChangeAllowed(actor: string): boolean {
  return actor === OPERATOR_ACTOR;
}

/** The calendar date (YYYY-MM-DD) it is right now in the display timezone. */
export function chicagoDateKey(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CRM_DISPLAY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Minutes east of UTC for the display timezone at that instant. */
export function chicagoOffsetMinutes(date: Date = new Date()): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: CRM_DISPLAY_TIMEZONE,
    timeZoneName: 'shortOffset',
  }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-6';
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!match) return -360;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

/**
 * The UTC instants that bound "today" in the display timezone, plus the local
 * date key. The offset is taken at the instant asked about, so the bounds stay
 * right across a daylight-saving change other than on the change itself.
 */
export function chicagoDayBounds(now: Date = new Date()): { start: Date; end: Date; date: string } {
  const date = chicagoDateKey(now);
  const [year, month, day] = date.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day) - chicagoOffsetMinutes(now) * 60_000);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000), date };
}

export function mergeAllowed(explicit: boolean, actor: string): { ok: true } | { ok: false; error: string } {
  if (!explicit) return { ok: false, error: 'Merge only happens when the operator explicitly confirms it.' };
  if (actor !== OPERATOR_ACTOR) return { ok: false, error: 'Only Matthew can merge contacts.' };
  return { ok: true };
}

export function formatChicago(iso: string | Date): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CRM_DISPLAY_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

const HEADER_ALIASES: Record<string, string[]> = {
  name: ['outlet', 'name', 'outlet name', 'organization', 'org', 'publication'],
  tier: ['tier', 'rank', 'priority'],
  email: ['email', 'e-mail', 'contact email', 'primary email'],
  tipEmail: ['tip email', 'tips email', 'tip form', 'tips', 'tip channel', 'news tip'],
  phone: ['phone', 'telephone', 'tel', 'mobile'],
  website: ['website', 'url', 'site', 'web'],
  city: ['city', 'town'],
  state: ['state', 'st'],
  notes: ['notes', 'note', 'comments', 'comment'],
};

export interface NewsroomRow {
  name: string;
  tier: string | null;
  email: string | null;
  tipEmail: string | null;
  phone: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  notes: string | null;
  tags: string[];
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const char = src[i];
    if (inQuotes) {
      if (char === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(cell.trim());
      cell = '';
      continue;
    }
    if (char === '\n') {
      row.push(cell.trim());
      cell = '';
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      continue;
    }
    if (char !== '\r') cell += char;
  }
  row.push(cell.trim());
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

function headerKey(header: string): string | null {
  const normalized = header.trim().toLowerCase();
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(normalized)) return key;
  }
  return null;
}

export function tierTag(tier: string | null): string | null {
  if (!tier) return null;
  const letter = tier.trim().toUpperCase().replace(/^TIER[-\s]*/, '');
  if (letter === 'A' || letter === 'B' || letter === 'C') return `tier-${letter}`;
  return null;
}

export function parseNewsroomCsv(csv: string): NewsroomRow[] {
  const table = parseCsv(csv);
  if (table.length === 0) return [];
  const headers = table[0] ?? [];
  const keys = headers.map((header) => headerKey(header));
  const rows: NewsroomRow[] = [];
  for (const record of table.slice(1)) {
    const bag: Record<string, string> = {};
    keys.forEach((key, index) => {
      if (!key) return;
      const value = record[index] ?? '';
      if (value) bag[key] = value;
    });
    const name = bag.name?.trim() ?? '';
    if (!name) continue;
    const tier = bag.tier?.trim() || null;
    const tag = tierTag(tier);
    rows.push({
      name,
      tier,
      email: bag.email?.trim().toLowerCase() || null,
      tipEmail: bag.tipEmail?.trim().toLowerCase() || null,
      phone: bag.phone?.trim() || null,
      website: bag.website?.trim() || null,
      city: bag.city?.trim() || null,
      state: bag.state?.trim() || null,
      notes: bag.notes?.trim() || null,
      tags: ['newsroom', ...(tag ? [tag] : [])],
    });
  }
  return rows;
}

export function toCsv(headers: string[], rows: string[][]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return [headers.map(escape).join(','), ...rows.map((row) => row.map((value) => escape(value ?? '')).join(','))].join('\n');
}

export interface TelnyxSignatureInput {
  publicKeyBase64: string;
  signatureBase64: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
}

/** Telnyx ed25519 webhook signature. Public key is the raw 32-byte key, base64. */
export function verifyTelnyxWebhookSignature(input: TelnyxSignatureInput): boolean {
  if (!input.publicKeyBase64 || !input.signatureBase64 || !input.timestamp) return false;
  try {
    const rawKey = Buffer.from(input.publicKeyBase64, 'base64');
    if (rawKey.length !== 32) return false;
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const keyObject = crypto.createPublicKey({
      key: Buffer.concat([spkiPrefix, rawKey]),
      format: 'der',
      type: 'spki',
    });
    const signature = Buffer.from(input.signatureBase64, 'base64');
    const payload = Buffer.from(`${input.timestamp}|${input.rawBody}`);
    return crypto.verify(null, payload, keyObject, signature);
  } catch {
    return false;
  }
}

export function queryKeyFallbackEnabled(): boolean {
  return process.env.TELNYX_SMS_QUERY_KEY_FALLBACK === 'true';
}

/**
 * Inbound SMS auth. Signature is required. The legacy query-string key is
 * accepted only when TELNYX_SMS_QUERY_KEY_FALLBACK=true and no signature was sent.
 */
export function inboundSmsAuthorized(input: {
  signatureOk: boolean;
  signaturePresent: boolean;
  queryKeyOk: boolean;
}): boolean {
  if (input.signatureOk) return true;
  if (input.signaturePresent) return false;
  return queryKeyFallbackEnabled() && input.queryKeyOk;
}
