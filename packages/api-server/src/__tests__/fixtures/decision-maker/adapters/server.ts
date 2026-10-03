import { html, type LeadCase } from '../cases.js';

const host = (u: string) => new URL(u).hostname.toLowerCase().replace(/^www\./, '');
const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** Serve fixture HTML for the lead's own host; everything else 404s. */
export function fixturePage(c: LeadCase, url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (host(u.toString()) !== host(c.lead.website)) return null;
  for (const p of c.pagePatterns ?? []) if (p.pattern.test(`${u.pathname}${u.search}`)) return html(p.file);
  const wanted = trimSlash(u.pathname);
  for (const [path, file] of Object.entries(c.pages)) {
    if (trimSlash(new URL(path, c.lead.website).pathname) === wanted && !u.search) return html(file);
  }
  return null;
}

/** Temporarily replace global fetch with the fixture server. */
export async function withFixtureFetch<T>(c: LeadCase, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = fixturePage(c, url);
    const res = body == null ? new Response('not found', { status: 404 }) : new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}
