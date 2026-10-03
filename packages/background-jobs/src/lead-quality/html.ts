/**
 * Small dependency-free HTML helpers shared by the industry classifier and the
 * decision-maker ladder. The old pipeline decoded the WHOLE document (scripts,
 * styles and JSON blobs included) as "visible text", which is how
 * `z-index:2147483647` became a phone number and how a "newsletter" string in
 * a CMS bundle made a hospital pass as a news outlet.
 */

export function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&ndash;|&mdash;|&#8211;|&#8212;/gi, '–')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d{2,5});/g, (_, n) => { const c = Number(n); return c > 31 && c < 65536 ? String.fromCharCode(c) : ' '; });
}

export function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Remove elements whose text is never shown to a reader. */
export function stripNonVisible(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|object)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ');
}

export function visibleText(html: string, max = 150_000): string {
  return stripTags(stripNonVisible(html.slice(0, max * 3))).slice(0, max);
}

export function pageTitle(html: string): string {
  return stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
}

export function metaContent(html: string, key: string): string | null {
  const safeKey = key.replace(/[^a-z0-9:_-]/gi, '');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${safeKey}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${safeKey}["'][^>]*>`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return stripTags(match[1]);
  }
  return null;
}

export function headings(html: string, max = 30): string[] {
  const out: string[] = [];
  for (const m of stripNonVisible(html).matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
    const t = stripTags(m[1] ?? '');
    if (t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Every parsed JSON-LD node, flattened through arrays and @graph. */
export function jsonLdNodes(html: string): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [];
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || nodes.length > 400) return;
    if (Array.isArray(value)) { for (const v of value) visit(v, depth + 1); return; }
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    if (row['@type']) nodes.push(row);
    for (const [k, v] of Object.entries(row)) {
      if (k === '@context') continue;
      if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  for (const script of scripts) {
    const body = script.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try { visit(JSON.parse(body), 0); } catch { /* malformed third-party JSON-LD */ }
  }
  return nodes;
}

export function nodeTypes(node: Record<string, unknown>): string[] {
  const raw = node['@type'];
  return (Array.isArray(raw) ? raw : [raw]).map((t) => String(t ?? '')).filter(Boolean);
}

export function jsonLdTypes(html: string): string[] {
  return [...new Set(jsonLdNodes(html).flatMap(nodeTypes))];
}

export interface SiteAddress { locality: string | null; region: string | null; country: string | null; source: 'json-ld' }

/** The organisation's own PostalAddress, preferring Organization/LocalBusiness nodes. */
export function jsonLdPostalAddress(html: string): SiteAddress | null {
  const nodes = jsonLdNodes(html);
  const orgFirst = [
    ...nodes.filter((n) => /organization|business|corporation|station|newspaper|store|service/i.test(nodeTypes(n).join(' '))),
    ...nodes,
  ];
  for (const node of orgFirst) {
    const addr = (node.address ?? (nodeTypes(node).includes('PostalAddress') ? node : null)) as unknown;
    const list = Array.isArray(addr) ? addr : [addr];
    for (const a of list) {
      if (!a || typeof a !== 'object') continue;
      const row = a as Record<string, unknown>;
      const locality = typeof row.addressLocality === 'string' ? stripTags(row.addressLocality) : null;
      const region = typeof row.addressRegion === 'string' ? stripTags(row.addressRegion) : null;
      const countryRaw = row.addressCountry;
      const country = typeof countryRaw === 'string'
        ? countryRaw
        : countryRaw && typeof countryRaw === 'object' && typeof (countryRaw as Record<string, unknown>).name === 'string'
          ? String((countryRaw as Record<string, unknown>).name)
          : null;
      if (locality || region) return { locality, region, country, source: 'json-ld' };
    }
  }
  return null;
}

/** Same-origin links whose href or anchor text matches `pattern`. */
export function sameOriginLinks(html: string, base: string, pattern: RegExp, limit = 12): string[] {
  let baseUrl: URL;
  try { baseUrl = new URL(base); } catch { return []; }
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1]?.trim();
    const text = stripTags(m[2] ?? '');
    if (!href || !(pattern.test(href) || pattern.test(text))) continue;
    try {
      const url = new URL(href, baseUrl);
      const sameSite = url.hostname.replace(/^www\./, '') === baseUrl.hostname.replace(/^www\./, '');
      if (!sameSite || !/^https?:$/.test(url.protocol)) continue;
      url.hash = '';
      out.push(url.toString());
    } catch { /* bad href */ }
    if (out.length >= limit * 2) break;
  }
  return [...new Set(out)].slice(0, limit);
}
