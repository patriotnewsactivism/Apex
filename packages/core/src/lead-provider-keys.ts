// ─── Directory provider key gating ────────────────────────────────────────────
//
// searchBusinessDirectory can use Yelp Fusion and Google Places (New) when
// their keys are configured. On 2026-10-06 the YELP_API_KEY applied from
// Settings was 12 characters long. A Fusion key is a 128-character token, so
// Yelp answered every campaign search with HTTP 400 VALIDATION_ERROR. That
// error echoes the Authorization header back ("instance": "Bearer <value>"),
// and the runner copied it into logs and campaign_segments.last_error.
//
// Rules here:
//   • Check each key once per distinct value (Settings can change process.env
//     at runtime, so a corrected key is picked up without a restart).
//   • A missing or malformed key disables the provider. It's reported as
//     "<ENV> treated as not set", which the capacity classifier reads as
//     unconfigured: it never pauses campaigns and is never charged to a
//     segment as an outage.
//   • One warning per provider per key value. Never the key itself, only its
//     length and, if the value is long enough, the last 4 characters.
//   • An auth-type rejection at runtime (401/403, or a 400 that names the key
//     or the Authorization header) disables the provider for the life of the
//     process, or until the key value changes.

import { createHash } from 'crypto';

export type DirectoryProvider = 'yelp' | 'google';

export const DIRECTORY_PROVIDER_ENV: Record<DirectoryProvider, string> = {
  yelp: 'YELP_API_KEY',
  google: 'GOOGLE_PLACES_API_KEY',
};

export interface ProviderKeyCheck {
  /** The key to send, already trimmed/normalised; null when disabled. */
  key: string | null;
  /** Why the provider is disabled; null when the key is usable. */
  reason: string | null;
  /** "…abcd" for values of 16+ characters, otherwise a length-only hint. */
  masked: string | null;
}

/** Last four characters for a value long enough that four characters do not
 *  give much of it away; otherwise length only. Never the whole value. */
export function maskProviderKey(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length >= 16 ? `…${value.slice(-4)}` : `${value.length} chars, too short to show any`;
}

function stripWrapping(raw: string): string {
  let value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function describeShape(value: string): string {
  const parts = [`${value.length} characters`];
  if (/\s/.test(value)) parts.push('contains whitespace');
  if (/[^A-Za-z0-9_-]/.test(value.replace(/\s/g, ''))) parts.push('contains characters other than A-Z a-z 0-9 _ -');
  return parts.join(', ');
}

function formatCheckDisabled(): boolean {
  const flag = String(process.env.LEAD_PROVIDER_KEY_FORMAT_CHECK ?? 'on').trim().toLowerCase();
  return flag === 'off' || flag === 'false' || flag === '0' || flag === 'no';
}

/** Yelp Fusion keys are 128-character tokens (Yelp validates the header as
 *  `Bearer [A-Za-z0-9\-\_]{128}`). A pasted "Bearer " prefix is tolerated. */
export function validateYelpApiKey(raw: string | null | undefined): ProviderKeyCheck {
  if (!raw || !raw.trim()) return { key: null, reason: 'YELP_API_KEY not set', masked: null };
  const value = stripWrapping(raw).replace(/^bearer\s+/i, '');
  if (formatCheckDisabled() || /^[A-Za-z0-9_-]{128}$/.test(value)) {
    return { key: value, reason: null, masked: maskProviderKey(value) };
  }
  return {
    key: null,
    reason: `YELP_API_KEY is not a Yelp Fusion API key (expected a 128-character token of A-Z a-z 0-9 _ -; got ${describeShape(value)})`,
    masked: maskProviderKey(value),
  };
}

/** Google API keys are "AIza" followed by 35 URL-safe characters. */
export function validateGooglePlacesApiKey(raw: string | null | undefined): ProviderKeyCheck {
  if (!raw || !raw.trim()) return { key: null, reason: 'GOOGLE_PLACES_API_KEY not set', masked: null };
  const value = stripWrapping(raw);
  if (formatCheckDisabled() || /^AIza[0-9A-Za-z_-]{35}$/.test(value)) {
    return { key: value, reason: null, masked: maskProviderKey(value) };
  }
  return {
    key: null,
    reason: `GOOGLE_PLACES_API_KEY is not a Google API key (expected "AIza" + 35 characters; got ${describeShape(value)})`,
    masked: maskProviderKey(value),
  };
}

const VALIDATORS: Record<DirectoryProvider, (raw: string | null | undefined) => ProviderKeyCheck> = {
  yelp: validateYelpApiKey,
  google: validateGooglePlacesApiKey,
};

interface ProviderState {
  fingerprint: string;
  check: ProviderKeyCheck;
  /** Set when the provider rejected the key at runtime. */
  runtimeReason: string | null;
  warned: boolean;
}

const states = new Map<DirectoryProvider, ProviderState>();
type Logger = (message: string) => void;
let warn: Logger = (message) => console.warn(message);

/** Tests only: capture warnings and forget every cached decision. */
export function resetDirectoryProviderKeyState(logger?: Logger): void {
  states.clear();
  warn = logger ?? ((message) => console.warn(message));
}

function fingerprintOf(raw: string | undefined): string {
  return raw ? createHash('sha256').update(raw).digest('hex') : '';
}

function stateFor(provider: DirectoryProvider): ProviderState {
  const raw = process.env[DIRECTORY_PROVIDER_ENV[provider]];
  const fingerprint = fingerprintOf(raw);
  const current = states.get(provider);
  if (current && current.fingerprint === fingerprint) return current;
  const next: ProviderState = { fingerprint, check: VALIDATORS[provider](raw), runtimeReason: null, warned: false };
  states.set(provider, next);
  return next;
}

/** The exact warning line. Sentinel greps for "[lead-provider] yelp disabled". */
export function directoryProviderWarning(provider: DirectoryProvider, reason: string, masked: string | null): string {
  return `[lead-provider] ${provider} disabled: ${reason}${masked ? ` (key ${masked})` : ''}. Skipping ${provider} for directory search until the key changes; this is logged once.`;
}

function warnOnce(provider: DirectoryProvider, state: ProviderState): void {
  if (state.warned) return;
  state.warned = true;
  const reason = state.runtimeReason ?? state.check.reason;
  if (reason) warn(directoryProviderWarning(provider, reason, state.check.masked));
}

export interface DirectoryProviderKey {
  /** The key to use, or null when the provider must be skipped. */
  key: string | null;
  /** Diagnostic for a skipped provider, phrased so the capacity classifier
   *  treats it as unconfigured ("… not set"). Null when usable. */
  note: string | null;
}

export function resolveDirectoryProviderKey(provider: DirectoryProvider): DirectoryProviderKey {
  const state = stateFor(provider);
  const reason = state.runtimeReason ?? state.check.reason;
  if (!reason && state.check.key) return { key: state.check.key, note: null };
  warnOnce(provider, state);
  const env = DIRECTORY_PROVIDER_ENV[provider];
  const missing = reason === `${env} not set`;
  return {
    key: null,
    note: missing ? `${provider}: ${env} not set` : `${provider}: disabled, ${env} treated as not set: ${reason}`,
  };
}

export function directoryProviderUsable(provider: DirectoryProvider): boolean {
  return resolveDirectoryProviderKey(provider).key !== null;
}

/** True when the provider answered in a way that says the key itself is bad:
 *  it will fail the same way on every call, so it should be switched off. */
export function isDirectoryAuthFailure(provider: DirectoryProvider, status: number, body: string): boolean {
  if (status === 401) return true;
  if (provider === 'yelp') {
    if (status === 403) return true;
    return status === 400 && /TOKEN_INVALID|TOKEN_MISSING|UNAUTHORIZED_ACCESS_TOKEN|"field"\s*:\s*"Authorization"|\bAuthorization\b|Bearer|api[_ ]?key/i.test(body);
  }
  // Google Places: 400 INVALID_ARGUMENT "API key not valid", or 403 for a key
  // that is restricted / has the API disabled. A 403 for billing is also a
  // configuration problem that will not clear by itself mid-process.
  if (status === 403) return /API_KEY|api key|PERMISSION_DENIED|SERVICE_DISABLED|billing/i.test(body);
  return status === 400 && /API key not valid|API_KEY_INVALID|api key/i.test(body);
}

/** Remove the key (and any echoed "Bearer <token>") from a provider error
 *  body before it reaches logs, diagnostics or the database. */
export function redactProviderBody(body: string, key: string | null | undefined): string {
  let out = body;
  if (key) out = out.split(key).join('[redacted]');
  return out
    .replace(/Bearer\s+[^\s"',}\]]+/gi, 'Bearer [redacted]')
    .replace(/("instance"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
    .replace(/([?&]key=)[^&\s"]+/gi, '$1[redacted]');
}

/** Switch a provider off after an auth-type rejection. Returns the diagnostic
 *  note to report for this call. Logs once. */
export function disableDirectoryProvider(provider: DirectoryProvider, status: number, body: string): string {
  const state = stateFor(provider);
  const env = DIRECTORY_PROVIDER_ENV[provider];
  const detail = redactProviderBody(body, state.check.key).replace(/\s+/g, ' ').slice(0, 120);
  if (!state.runtimeReason) {
    state.runtimeReason = `${provider === 'yelp' ? 'Yelp' : 'Google Places'} rejected ${env} (HTTP ${status}${detail ? ` ${detail}` : ''})`;
    state.warned = false;
  }
  warnOnce(provider, state);
  return `${provider}: disabled, ${env} treated as not set: ${state.runtimeReason}`;
}
