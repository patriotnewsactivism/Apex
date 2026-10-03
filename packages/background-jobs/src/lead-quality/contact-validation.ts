/**
 * Contact validation for researched leads.
 *
 * Evidence (production read, Oct 3 2026, 8,263 verified leads): 175 "emails"
 * were image filenames such as `site-nav-logo@2x.png` (the Gannett nav sprite,
 * matched by the generic email regex), 943 phones failed basic NANP structure,
 * 170 were sentinel values (e.g. +12147483647 = INT32_MAX scraped out of an
 * inline `z-index:2147483647` style, +13333333333), and 1,051 had an area code
 * from a different state than the lead's city.
 *
 * Phones are always stored as E.164 *strings* (`+1NXXNXXXXXX`). Nothing here
 * parses a phone into a JS number or an int column.
 */
import { promises as dnsPromises } from 'node:dns';
import { lookupAreaCode, normalizeUsState, stateMatchesRegion, type NanpRegion } from './nanp.js';

export const CONTACT_VALIDATION_VERSION = '2026-10-03-v1';

// ─── Email ──────────────────────────────────────────────────────────────────

const ASSET_EXTENSIONS = /\.(?:png|jpe?g|gif|svg|webp|avif|bmp|ico|tiff?|css|js|mjs|map|json|woff2?|ttf|eot|otf|mp4|webm|mp3|pdf)$/i;
const RETINA_SUFFIX = /@[1-4](?:\.\d)?x(?:[._-]|$)/i;
const PLACEHOLDER_DOMAINS = /(?:^|\.)(?:example\.(?:com|org|net)|domain\.com|yourdomain\.com|email\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|cloudflare\.com|godaddy\.com|test\.com)$/i;
const PLACEHOLDER_LOCALS = /^(?:noreply|no-reply|donotreply|do-not-reply|example|test|user|name|email|your-?email|yourname|first\.?last|john\.?doe|jane\.?doe)$/i;

export type EmailStatus = 'valid' | 'invalid_format' | 'asset_filename' | 'placeholder' | 'masked' | 'no_mail_host' | 'dns_error';

export interface EmailValidation {
  value: string | null;
  original: string | null;
  status: EmailStatus;
  reason: string | null;
  mx: { checked: boolean; host: string | null; via: 'mx' | 'a' | null; cached: boolean } | null;
}

export function isAssetFilenameEmail(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (ASSET_EXTENSIONS.test(v)) return true;
  const local = v.split('@')[0] ?? '';
  // `logo@2x.png` style: the "domain" is actually a density suffix.
  if (/^[1-4](?:\.\d)?x\./.test(v.split('@')[1] ?? '')) return true;
  return RETINA_SUFFIX.test(`@${v.split('@')[1] ?? ''}`) && /logo|icon|sprite|image|img|banner|nav/.test(local);
}

export function cleanEmailCandidate(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim();
  try { v = decodeURIComponent(v); } catch { /* keep raw */ }
  v = v.replace(/^(?:mailto|malito|mailt0):/i, '').replace(/^\s+/, '').split('?')[0]!.trim().toLowerCase();
  return v || null;
}

export function checkEmailFormat(value: string | null | undefined): Omit<EmailValidation, 'mx'> {
  const original = value ?? null;
  const email = cleanEmailCandidate(value);
  if (!email) return { value: null, original, status: 'invalid_format', reason: 'empty' };
  if (/\*/.test(email)) return { value: null, original, status: 'masked', reason: 'masked_by_provider' };
  if (isAssetFilenameEmail(email)) return { value: null, original, status: 'asset_filename', reason: 'looks_like_image_or_asset_filename' };
  // Pragmatic RFC 5322 subset: ASCII local part, dotted domain, alpha TLD.
  const ok = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(email);
  if (!ok || email.includes('..') || email.startsWith('.') || email.split('@')[0]!.endsWith('.')) {
    return { value: null, original, status: 'invalid_format', reason: 'bad_format' };
  }
  const [local, domain] = email.split('@') as [string, string];
  if (PLACEHOLDER_DOMAINS.test(domain) || PLACEHOLDER_LOCALS.test(local)) {
    return { value: null, original, status: 'placeholder', reason: 'placeholder_or_system_address' };
  }
  return { value: email, original, status: 'valid', reason: null };
}

export interface MailHostResolver {
  resolveMx(domain: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolve4(domain: string): Promise<string[]>;
}

const defaultResolver: MailHostResolver = {
  resolveMx: (d) => dnsPromises.resolveMx(d),
  resolve4: (d) => dnsPromises.resolve4(d),
};

interface MxCacheEntry { host: string | null; via: 'mx' | 'a' | null; transient: boolean; expiresAt: number }
const MX_CACHE = new Map<string, MxCacheEntry>();
const MX_CACHE_MAX = 5000;
const MX_TTL_MS = 24 * 60 * 60 * 1000;
const MX_TRANSIENT_TTL_MS = 10 * 60 * 1000;

export function clearMxCache(): void { MX_CACHE.clear(); }

/** MX lookup with an in-process cache; falls back to an A record (RFC 5321 §5.1 implicit MX). */
export async function lookupMailHost(
  domain: string,
  resolver: MailHostResolver = defaultResolver,
  now: number = Date.now(),
): Promise<{ host: string | null; via: 'mx' | 'a' | null; cached: boolean; transient: boolean }> {
  const key = domain.toLowerCase();
  const hit = MX_CACHE.get(key);
  if (hit && hit.expiresAt > now) return { host: hit.host, via: hit.via, cached: true, transient: hit.transient };

  let entry: MxCacheEntry;
  try {
    const mx = (await resolver.resolveMx(key)).filter((r) => r.exchange && r.exchange !== '.');
    if (mx.length > 0) {
      const best = [...mx].sort((a, b) => a.priority - b.priority)[0]!;
      entry = { host: best.exchange, via: 'mx', transient: false, expiresAt: now + MX_TTL_MS };
    } else {
      entry = await aFallback(key, resolver, now);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ENOTIMP') {
      entry = await aFallback(key, resolver, now);
    } else {
      entry = { host: null, via: null, transient: true, expiresAt: now + MX_TRANSIENT_TTL_MS };
    }
  }
  if (MX_CACHE.size >= MX_CACHE_MAX) {
    const first = MX_CACHE.keys().next().value;
    if (first) MX_CACHE.delete(first);
  }
  MX_CACHE.set(key, entry);
  return { host: entry.host, via: entry.via, cached: false, transient: entry.transient };
}

async function aFallback(domain: string, resolver: MailHostResolver, now: number): Promise<MxCacheEntry> {
  try {
    const a = await resolver.resolve4(domain);
    if (a.length > 0) return { host: domain, via: 'a', transient: false, expiresAt: now + MX_TTL_MS };
    return { host: null, via: null, transient: false, expiresAt: now + MX_TTL_MS };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return { host: null, via: null, transient: false, expiresAt: now + MX_TTL_MS };
    return { host: null, via: null, transient: true, expiresAt: now + MX_TRANSIENT_TTL_MS };
  }
}

export async function validateEmail(
  value: string | null | undefined,
  options: { checkMx?: boolean; resolver?: MailHostResolver } = {},
): Promise<EmailValidation> {
  const format = checkEmailFormat(value);
  if (format.status !== 'valid' || !format.value) return { ...format, mx: null };
  if (options.checkMx === false) return { ...format, mx: { checked: false, host: null, via: null, cached: false } };
  const domain = format.value.split('@')[1]!;
  const mail = await lookupMailHost(domain, options.resolver);
  if (mail.host) return { ...format, mx: { checked: true, host: mail.host, via: mail.via, cached: mail.cached } };
  if (mail.transient) {
    // DNS hiccup: keep the address but mark it so the readiness gate can retry later.
    return { ...format, status: 'dns_error', reason: 'dns_lookup_failed_transient', mx: { checked: true, host: null, via: null, cached: mail.cached } };
  }
  return { value: null, original: format.original, status: 'no_mail_host', reason: 'domain_has_no_mx_or_a_record', mx: { checked: true, host: null, via: null, cached: mail.cached } };
}

// ─── Phone ──────────────────────────────────────────────────────────────────

export type PhoneStatus = 'valid' | 'invalid_format' | 'invalid_nanp' | 'sentinel' | 'international';

export interface PhoneValidation {
  e164: string | null;
  original: string | null;
  status: PhoneStatus;
  reason: string | null;
  areaCode: string | null;
  region: NanpRegion | null;
}

const SENTINEL_NATIONAL = new Set([
  '2147483647', // INT32_MAX (z-index / int overflow artefacts)
  '4294967295', // UINT32_MAX
  '2147483648',
  '1234567890',
  '0123456789',
  '0000000000',
  '9876543210',
]);

export function isSentinelNational(national: string): boolean {
  if (SENTINEL_NATIONAL.has(national)) return true;
  if (/^(\d)\1{9}$/.test(national)) return true; // 3333333333
  if (/^(\d)\1{8}\d$/.test(national)) return true; // 6666666667
  if (/^\d(\d)\1{8}$/.test(national)) return true; // 9444444444 (+19444444444)
  // 7 identical subscriber digits (944-444-4444) are fake EXCEPT on toll-free
  // lines, where vanity numbers like 800-444-4444 or 888-880-8888 are real.
  if (/^\d{3}(\d)\1{6}$/.test(national) && !/^8(?:00|33|44|55|66|77|88)/.test(national)) return true;
  if (/^\d{3}5550(1\d\d)$/.test(national)) return true; // 555-01XX fictional
  return false;
}

/**
 * Normalise a phone string to E.164. NANP numbers are structurally validated
 * (NPA and NXX must start 2-9, no N11, no N9X reserved NPA). Non-NANP numbers
 * with an explicit `+` are kept as E.164 but marked `international`.
 */
export function normalizePhoneE164(value: string | number | null | undefined): PhoneValidation {
  const original = value == null ? null : String(value);
  const fail = (status: PhoneStatus, reason: string): PhoneValidation => ({ e164: null, original, status, reason, areaCode: null, region: null });
  if (!original) return fail('invalid_format', 'empty');
  // Numbers that arrive as JS numbers lose leading '+' and may have been
  // clamped; treat anything non-string as suspect but still check it.
  const raw = original.trim().replace(/^tel:/i, '').split(/[;,?]|(?:\s*(?:x|ext\.?|extension)\s*\d+$)/i)[0] ?? '';
  const explicitPlus = raw.trim().startsWith('+');
  const digits = raw.replace(/\D/g, '');
  let national: string | null = null;
  if (digits.length === 10 && !explicitPlus) national = digits;
  else if (digits.length === 11 && digits.startsWith('1')) national = digits.slice(1);
  else if (explicitPlus && digits.length >= 8 && digits.length <= 15 && !digits.startsWith('1')) {
    return { e164: `+${digits}`, original, status: 'international', reason: 'non_nanp_country_code', areaCode: null, region: null };
  } else if (digits.length === 10 && explicitPlus) {
    return fail('invalid_format', 'plus_without_country_code');
  } else {
    return fail('invalid_format', `unexpected_digit_count_${digits.length}`);
  }

  const npa = national.slice(0, 3);
  const nxx = national.slice(3, 6);
  if (isSentinelNational(national)) return { ...fail('sentinel', 'placeholder_or_overflow_value'), areaCode: npa };
  if (!/^[2-9]/.test(npa) || !/^[2-9]/.test(nxx)) return { ...fail('invalid_nanp', 'area_code_or_exchange_starts_with_0_or_1'), areaCode: npa };
  if (/^[2-9]11$/.test(npa) || /^[2-9]11$/.test(nxx)) return { ...fail('invalid_nanp', 'n11_service_code'), areaCode: npa };
  if (/^[2-9]9\d$/.test(npa) || npa === '555' || /^37\d$|^96\d$/.test(npa)) return { ...fail('invalid_nanp', 'reserved_area_code'), areaCode: npa };
  return { e164: `+1${national}`, original, status: 'valid', reason: null, areaCode: npa, region: lookupAreaCode(npa) };
}

// ─── Geography ──────────────────────────────────────────────────────────────

export interface CityState { city: string | null; state: string | null; raw: string | null }

/** Parse "Dallas, TX" / "Dallas, Texas" / "Dallas TX" / "Dallas, TX 75201". */
export function parseCityState(value: string | null | undefined): CityState {
  const raw = value?.trim() || null;
  if (!raw) return { city: null, state: null, raw };
  const cleaned = raw.replace(/\b\d{5}(?:-\d{4})?\b/, '').replace(/,?\s*(?:USA|United States)$/i, '').trim().replace(/,$/, '');
  const comma = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
  if (comma.length >= 2) {
    const state = normalizeUsState(comma[comma.length - 1]!);
    return { city: comma.slice(0, -1).join(', ') || null, state, raw };
  }
  const m = cleaned.match(/^(.*?)[\s]+([A-Za-z]{2})$/);
  if (m && normalizeUsState(m[2]!)) return { city: m[1]!.trim() || null, state: normalizeUsState(m[2]!), raw };
  return { city: cleaned || null, state: null, raw };
}

export type ContactFlag =
  | 'email_rejected'
  | 'phone_rejected'
  | 'area_code_state_mismatch'
  | 'unknown_area_code'
  | 'toll_free_number'
  | 'non_us_number'
  | 'city_missing_state'
  | 'city_unparseable'
  | 'dns_transient';

export interface ContactValidationResult {
  version: string;
  checkedAt: string;
  email: EmailValidation | null;
  phone: PhoneValidation | null;
  leadState: string | null;
  flags: ContactFlag[];
  /** True when at least one deliverable channel survived validation. */
  validated: boolean;
  /** True when a transient error (DNS) means this should be re-checked later. */
  retryable: boolean;
}

export function areaCodeFlags(phone: PhoneValidation | null, leadState: string | null): ContactFlag[] {
  if (!phone?.e164 || phone.status !== 'valid') {
    return phone?.status === 'international' ? ['non_us_number'] : [];
  }
  if (!phone.region) return ['unknown_area_code'];
  if (phone.region.kind === 'toll_free') return ['toll_free_number'];
  if (phone.region.kind === 'canada' || phone.region.kind === 'caribbean' || phone.region.kind === 'premium') {
    return leadState ? ['non_us_number', 'area_code_state_mismatch'] : ['non_us_number'];
  }
  if (leadState && !stateMatchesRegion(leadState, phone.region)) return ['area_code_state_mismatch'];
  return [];
}

export async function validateLeadContacts(input: {
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  checkMx?: boolean;
  resolver?: MailHostResolver;
  now?: Date;
}): Promise<ContactValidationResult> {
  const flags: ContactFlag[] = [];
  const geo = parseCityState(input.city);
  if (geo.raw && !geo.state) flags.push(geo.city ? 'city_missing_state' : 'city_unparseable');

  const email = input.email ? await validateEmail(input.email, { checkMx: input.checkMx, resolver: input.resolver }) : null;
  if (email && email.status !== 'valid' && email.status !== 'dns_error') flags.push('email_rejected');
  if (email?.status === 'dns_error') flags.push('dns_transient');

  const phone = input.phone ? normalizePhoneE164(input.phone) : null;
  if (phone && phone.status !== 'valid' && phone.status !== 'international') flags.push('phone_rejected');
  flags.push(...areaCodeFlags(phone, geo.state));

  const emailOk = email?.status === 'valid';
  // A US-market lead whose only phone is foreign or in another state is not
  // reachable-as-described; the number is kept but does not validate the lead.
  const phoneOk = phone?.status === 'valid' && !flags.includes('area_code_state_mismatch');
  return {
    version: CONTACT_VALIDATION_VERSION,
    checkedAt: (input.now ?? new Date()).toISOString(),
    email,
    phone,
    leadState: geo.state,
    flags: [...new Set(flags)],
    validated: Boolean(emailOk || phoneOk),
    retryable: email?.status === 'dns_error',
  };
}
