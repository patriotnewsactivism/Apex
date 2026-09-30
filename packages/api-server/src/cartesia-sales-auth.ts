import crypto from 'node:crypto';

const DERIVATION_CONTEXT = 'apex-cartesia-sales-auth-v1';

const CARTESIA_SALES_TOOL_BASE_NAMES = [
  'lookup_lead_info_v3',
  'capture_and_qualify_lead_v2',
  'check_calendar_availability_v2',
  'book_consultation_v2',
  'send_demo_link_v2',
  'send_requested_followup_email_v1',
  'record_call_outcome_v3',
] as const;

function derivedSecret(label: 'tool' | 'webhook'): string | undefined {
  const apiKey = process.env.CARTESIA_API_KEY?.trim();
  if (!apiKey) return undefined;
  return crypto
    .createHmac('sha256', apiKey)
    .update(`${DERIVATION_CONTEXT}:${label}`)
    .digest('base64url');
}

/**
 * Prefer an explicitly provisioned secret when one exists. Railway OAuth can
 * redact/remove values during migrations, so fall back to a deterministic HMAC
 * derived from the already-required Cartesia API credential. The derived value
 * is never logged or returned to an operator.
 */
export function cartesiaToolSecret(): string | undefined {
  return process.env.CARTESIA_TOOL_SECRET?.trim() || derivedSecret('tool');
}

export function cartesiaWebhookSecret(): string | undefined {
  return process.env.CARTESIA_WEBHOOK_SECRET?.trim() || derivedSecret('webhook');
}

export function cartesiaCredentialMode(): 'explicit' | 'derived' | 'missing' {
  if (process.env.CARTESIA_TOOL_SECRET?.trim() && process.env.CARTESIA_WEBHOOK_SECRET?.trim()) {
    return 'explicit';
  }
  return process.env.CARTESIA_API_KEY?.trim() ? 'derived' : 'missing';
}


/**
 * Cartesia webhook-tool authentication is write-only/immutable after creation.
 * Include a non-secret fingerprint of the effective bearer credential in each
 * canonical tool name. If Railway or the Cartesia API credential rotates, APEX
 * automatically creates a fresh authenticated tool generation and reattaches
 * the canonical agent instead of silently reusing stale credentials.
 */
export function cartesiaSalesToolNames(): readonly string[] {
  const secret = cartesiaToolSecret();
  const generation = secret
    ? crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8)
    : 'missing';
  return CARTESIA_SALES_TOOL_BASE_NAMES.map((name) => `${name}_${generation}`);
}

export function cartesiaSalesToolBaseNames(): readonly string[] {
  return CARTESIA_SALES_TOOL_BASE_NAMES;
}
