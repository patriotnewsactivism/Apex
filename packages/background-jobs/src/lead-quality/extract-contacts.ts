/**
 * First-party contact extraction from a fetched page. Only reader-visible
 * text and explicit mailto:/tel: links are considered.
 */
import { stripNonVisible, visibleText } from './html.js';
import { checkEmailFormat, normalizePhoneE164 } from './contact-validation.js';

function normalizeBusinessEmail(value: string | null | undefined): string | null {
  const checked = checkEmailFormat(value);
  return checked.status === 'valid' ? checked.value : null;
}

function normalizeUsBusinessPhone(value: string | null | undefined): string | null {
  const checked = normalizePhoneE164(value);
  // E.164 string, never a number: NANP numbers must pass structure/sentinel
  // checks; explicit +CC international numbers are kept but flagged later.
  return checked.status === 'valid' || checked.status === 'international' ? checked.e164 : null;
}

export function publicContactsFromHtml(html: string): { email: string | null; phone: string | null } {
  // Only reader-visible text and explicit mailto:/tel: links. Decoding the
  // whole document turned `z-index:2147483647` into +12147483647 and
  // `site-nav-logo@2x.png` into an email address.
  const visible = visibleText(html, 200_000);
  const emails = [
    ...Array.from(html.matchAll(/href=["']mailto:([^"'?#\s>]+)/gi), (m) => m[1] ?? ''),
    ...Array.from(visible.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi), (m) => m[0] ?? ''),
  ];
  const telLinks = Array.from(stripNonVisible(html).matchAll(/href=["']tel:([^"'?#>]+)/gi), (m) => m[1] ?? '');
  const textPhones = Array.from(visible.matchAll(/(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]\d{4}\b/g), (m) => m[0] ?? '');
  const phones = [...telLinks, ...textPhones];
  const nanpFirst = phones.map((p) => normalizePhoneE164(p)).filter((p) => p.status === 'valid').map((p) => p.e164);
  return {
    email: emails.map(normalizeBusinessEmail).find((value): value is string => Boolean(value)) ?? null,
    phone: nanpFirst[0] ?? phones.map(normalizeUsBusinessPhone).find((value): value is string => Boolean(value)) ?? null,
  };
}

