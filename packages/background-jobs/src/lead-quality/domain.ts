/** Hostname helpers shared by dedupe and decision-maker verification. */

const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'com.br', 'co.jp', 'co.in', 'com.mx', 'co.za',
]);

export function hostOf(url: string | null | undefined): string | null {
  const raw = (url ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * eTLD+1: "edition.cnn.com" → "cnn.com", "news.bbc.co.uk" → "bbc.co.uk".
 * US locality domains ("ci.concord.nh.us") are kept whole. Tradeoff: franchise
 * subdomains on a shared platform ("nashua.franchise.com") collapse to one.
 */
export function registrableDomain(url: string | null | undefined): string | null {
  const host = hostOf(url);
  if (!host) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  if (/\.[a-z]{2}\.us$/.test(host)) return host;
  const lastTwo = parts.slice(-2).join('.');
  return MULTI_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

export function sameRegistrableDomain(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = registrableDomain(a);
  return Boolean(left) && left === registrableDomain(b);
}
