/**
 * Person/title extraction and role-aware selection for the decision-maker ladder.
 */
import { jsonLdNodes, nodeTypes, stripNonVisible, stripTags, decodeEntities } from './html.js';
import { hostOf, sameRegistrableDomain } from './domain.js';
import { classifyTitle, loadTitlePolicy, type AuthorityTier, type TitleClassification, type TitlePolicy } from './title-authority.js';

export const DECISION_MAKER_ROLES = ['owner_executive', 'marketing', 'editorial', 'sales'] as const;
export type DecisionMakerRole = typeof DECISION_MAKER_ROLES[number];

export type ExtractionMethod =
  | 'structured_scrape'
  | 'json_ld_person'
  | 'microdata_person'
  | 'team_page_text'
  | 'masthead_text'
  | 'site_search'
  | 'web_search'
  | 'hunter_domain_search'
  // Name-finder queue: a name the company itself gave us.
  | 'email_reply'
  | 'phone_call'
  | 'operator_entry';

export interface PersonRecord {
  name: string;
  title: string;
  sourceUrl: string;
  method: ExtractionMethod;
  /** 0..1 confidence in the person+title pairing from this method alone. */
  methodConfidence: number;
  email?: string | null;
  seenAt: string;
}

/** Ordered: index 0 is the most preferred title for that role. */
export const ROLE_TITLE_PRIORITY: Record<DecisionMakerRole, RegExp[]> = {
  owner_executive: [
    /\b(?:co-?)?owner\b/i,
    /\b(?:co-?)?founder\b/i,
    /\bceo\b|\bchief executive\b/i,
    /^(?!.*\bvice\b).*\bpresident\b/i,
    /\bmanaging (?:partner|member|director)\b|\bprincipal\b/i,
    /\bpublisher\b/i,
    /\bgeneral manager\b|\bgm\b/i,
    /\bexecutive director\b/i,
    /\bcoo\b|\bchief operating\b/i,
    /^(?!.*\b(?:associate|paralegal)\b).*\bpartner\b/i,
  ],
  marketing: [
    /\bcmo\b|\bchief marketing\b/i,
    /\b(?:vp|vice president)\b.*\bmarketing\b/i,
    /\bmarketing director\b|\bdirector of marketing\b|\bhead of marketing\b/i,
    /\bmarketing manager\b|\bmarketing lead\b/i,
    /\b(?:digital|brand|growth|content) (?:director|manager|lead)\b/i,
    /\bcommunications director\b|\bdirector of communications\b/i,
  ],
  editorial: [
    /\beditor[- ]in[- ]chief\b/i,
    /\bexecutive editor\b/i,
    /\bnews director\b/i,
    /\bmanaging editor\b/i,
    /\bstation manager\b|\bprogram(?:ming)? director\b/i,
    /^(?!.*\b(?:copy|photo|video|assistant|associate|sports|web)\b).*\beditor\b/i,
    /\b(?:metro|city|news|assignment) editor\b|\bassistant managing editor\b/i,
    /\bpublisher\b/i,
  ],
  sales: [
    /\bcro\b|\bchief revenue\b/i,
    /\b(?:vp|vice president)\b.*\b(?:sales|advertising|revenue)\b/i,
    /\b(?:sales|advertising|ad sales) director\b|\bdirector of (?:sales|advertising|business development)\b/i,
    /\b(?:sales|advertising|ad sales) manager\b|\bbusiness development (?:manager|director|lead)\b/i,
    /\baccount executive\b|\bmedia consultant\b|\badvertising consultant\b/i,
  ],
};

const ANY_TITLE = /\b(?:owner|co-?owner|founder|co-?founder|president|ceo|cfo|coo|cmo|cro|cto|chief [a-z]+ officer|vice president|vp|director|general manager|manager|partner|principal|publisher|editor|editor[- ]in[- ]chief|news director|station manager|program director|head of [a-z]+|executive|account executive|attorney|dds|dmd|broker)\b/i;

const NAME_STOPWORDS = new Set([
  'about', 'our', 'team', 'staff', 'news', 'home', 'read', 'more', 'email', 'phone', 'call', 'contact', 'the', 'inc', 'llc',
  'street', 'avenue', 'suite', 'road', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'privacy', 'policy', 'terms', 'service', 'services', 'meet', 'leadership', 'management', 'board', 'directors', 'office',
  'company', 'group', 'department', 'sales', 'marketing', 'advertising', 'editorial', 'newsroom', 'click', 'here', 'view',
  'profile', 'bio', 'learn', 'welcome', 'new', 'hampshire', 'north', 'south', 'east', 'west', 'county', 'city', 'state',
  'united', 'states', 'america', 'copyright', 'all', 'rights', 'reserved', 'subscribe', 'login', 'sign', 'search', 'menu',
  'manager', 'director', 'editor', 'president', 'owner', 'founder', 'publisher', 'chief', 'officer', 'executive', 'senior',
  'general', 'vice', 'partner', 'principal', 'account', 'digital', 'audience', 'media', 'content', 'local', 'national',
  'breaking', 'latest', 'top', 'stories', 'weather', 'sports', 'opinion', 'business', 'health', 'education', 'events',
  // Section/department words: a name ending in one is a name/title split error (KCUR "Luke X. Martin Culture").
  'culture', 'arts', 'politics', 'food', 'music', 'features', 'metro', 'science', 'tech', 'technology', 'entertainment',
  'lifestyle', 'travel', 'faith', 'style', 'books', 'film', 'investigations', 'investigative', 'photo', 'video', 'social',
  'engagement', 'community', 'government', 'environment', 'climate', 'statehouse', 'courts', 'crime', 'staff', 'writer',
  'reporter', 'producer', 'anchor', 'host', 'associate', 'assistant', 'coordinator', 'intern',
]);

export function looksLikePersonName(value: string): boolean {
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 5 || name.length > 50) return false;
  const tokens = name.split(' ');
  if (tokens.length < 2 || tokens.length > 4) return false;
  return tokens.every((t, i) => {
    if (NAME_STOPWORDS.has(t.toLowerCase().replace(/[.,]/g, ''))) return false;
    if (/^[A-Z]\.$/.test(t) && i > 0 && i < tokens.length - 1) return true; // middle initial
    if (/^(?:Jr\.?|Sr\.?|II|III|IV)$/.test(t) && i === tokens.length - 1) return true;
    return /^[A-Z][a-z'’]+(?:-[A-Z][a-z'’]+)?$/.test(t) || /^(?:Mc|Mac|O')[A-Z][a-z]+$/.test(t);
  });
}

/** Strip "Read Bio", degree prefixes and stray punctuation from a scraped title. */
export function cleanTitle(value: string): string {
  return value
    .replace(/\b(?:read (?:full )?bio|view (?:full )?profile|learn more|email me|contact)\b.*$/i, '')
    .replace(/^(?:(?:MBA|PhD|JD|MD|DDS|DMD|PT|CPA|RN|Esq)\.?,?\s*)+/, '')
    .replace(/^[\s,:|–—-]+|[\s,:|–—-]+$/g, '')
    .trim();
}

function normalizeOrg(value: string): string {
  return value.toLowerCase().replace(/\b(?:the|inc|llc|co|corp|company|news|media)\b/g, '').replace(/[^a-z0-9]+/g, '');
}

/**
 * A title that names an organisation ("President & CEO, Granite VNA",
 * "Director of Sales at Acme") must name THIS company or domain. Rejects
 * people quoted in articles on a news site's pages.
 */
export function affiliationOk(title: string, org: { companyName?: string | null; domain?: string | null } = {}): boolean {
  const m = title.match(/(?:,\s*|\s+(?:at|of|for|with)\s+)((?:the\s+)?[A-Z][\w&'.-]*(?:\s+[A-Z&][\w&'.-]*)*)\s*$/);
  if (!m) return true;
  const named = m[1]!;
  // "Director of Marketing", "Head of Sales": the trailing words are a function, not an org.
  if (/^(?:the\s+)?(?:marketing|sales|advertising|operations|communications|business development|news|content|programming|engineering|finance|technology|development|the board|the company|digital|audience|revenue|strategy|editorial)$/i.test(named)) return true;
  if (!org.companyName && !org.domain) return true;
  const n = normalizeOrg(named);
  if (!n) return true;
  const company = normalizeOrg(org.companyName ?? '');
  const domainLabel = (org.domain ?? '').toLowerCase().replace(/^www\./, '').split('.')[0]!.replace(/[^a-z0-9]/g, '');
  return Boolean((company && (company.includes(n) || n.includes(company))) || (domainLabel && (domainLabel.includes(n) || n.includes(domainLabel))));
}

export function looksLikeTitle(value: string): boolean {
  const t = value.trim();
  return t.length >= 2 && t.length <= 90 && ANY_TITLE.test(t) && !/@|https?:|\d{3}[\s.-]\d{3}/.test(t);
}

function cleanText(value: string): string {
  return decodeEntities(value).replace(/\s+/g, ' ').trim();
}

/** JSON-LD Person nodes with a jobTitle, plus Organization.founder. */
export function peopleFromJsonLd(html: string, sourceUrl: string, now: string): PersonRecord[] {
  const out: PersonRecord[] = [];
  for (const node of jsonLdNodes(html)) {
    const types = nodeTypes(node).join(' ');
    if (/\bPerson\b/.test(types)) {
      const name = typeof node.name === 'string' ? cleanText(node.name) : '';
      const rawTitle = Array.isArray(node.jobTitle) ? node.jobTitle[0] : node.jobTitle;
      const title = typeof rawTitle === 'string' ? cleanText(rawTitle) : '';
      if (name && title && looksLikePersonName(name)) {
        out.push({ name, title, sourceUrl, method: 'json_ld_person', methodConfidence: 0.9, seenAt: now });
      }
    }
    const founders = node.founder ? (Array.isArray(node.founder) ? node.founder : [node.founder]) : [];
    for (const f of founders) {
      const name = typeof f === 'string' ? cleanText(f) : f && typeof f === 'object' && typeof (f as Record<string, unknown>).name === 'string' ? cleanText(String((f as Record<string, unknown>).name)) : '';
      if (name && looksLikePersonName(name)) out.push({ name, title: 'Founder', sourceUrl, method: 'json_ld_person', methodConfidence: 0.85, seenAt: now });
    }
  }
  return out;
}

/** schema.org/Person microdata blocks. */
export function peopleFromMicrodata(html: string, sourceUrl: string, now: string): PersonRecord[] {
  const out: PersonRecord[] = [];
  const re = /itemtype=["']https?:\/\/schema\.org\/Person["']/gi;
  for (const m of html.matchAll(re)) {
    const chunk = html.slice(m.index ?? 0, (m.index ?? 0) + 2500);
    const prop = (p: string) => {
      const hit = chunk.match(new RegExp(`itemprop=["']${p}["'][^>]*?(?:content=["']([^"']+)["'][^>]*>|>([\\s\\S]*?)<\\/)`, 'i'));
      return hit ? cleanText(stripTags(hit[1] ?? hit[2] ?? '')) : '';
    };
    const name = prop('name');
    const title = prop('jobTitle');
    if (name && title && looksLikePersonName(name)) out.push({ name, title, sourceUrl, method: 'microdata_person', methodConfidence: 0.85, seenAt: now });
  }
  return out;
}

/** Visible text broken into lines at block boundaries. */
export function textLines(html: string): string[] {
  const blocked = stripNonVisible(html)
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|td|th|tr|dt|dd|section|article|header|footer|figcaption|span|strong|b|em|a)>/gi, '\n');
  return stripTagsKeepLines(blocked)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0 && l.length < 160);
}

function stripTagsKeepLines(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ' '));
}

/** Heuristic name/title pairs from team, staff and masthead pages. */
export interface OrgContext { companyName?: string | null; domain?: string | null }

export function peopleFromText(html: string, sourceUrl: string, method: 'team_page_text' | 'masthead_text' | 'site_search', now: string, org: OrgContext = {}): PersonRecord[] {
  const lines = textLines(html).slice(0, 4000);
  const out: PersonRecord[] = [];
  const conf = method === 'site_search' ? 0.6 : 0.75;
  const push = (name: string, title: string, c = conf) => {
    const n = name.trim().replace(/[,:|–—-]+$/, '').trim();
    const t = cleanTitle(title);
    if (looksLikePersonName(n) && looksLikeTitle(t) && affiliationOk(t, org)) out.push({ name: n, title: t, sourceUrl, method, methodConfidence: c, seenAt: now });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // "Jane Doe, Managing Editor" / "Jane Doe – Owner" / "Jane Doe | Publisher"
    const inline = line.match(/^([A-Z][A-Za-z.'’ -]{3,48}?)\s*(?:,|–|—|\||-{1,2}|:)\s*(.{2,90})$/);
    if (inline && looksLikePersonName(inline[1]!) && looksLikeTitle(inline[2]!)) { push(inline[1]!, inline[2]!); continue; }
    // "Managing Editor: Jane Doe"
    const titleFirst = line.match(/^(.{2,60}?)\s*(?:,|:|–|—|\|)\s*([A-Z][A-Za-z.'’ -]{3,48})$/);
    if (titleFirst && looksLikeTitle(titleFirst[1]!) && looksLikePersonName(titleFirst[2]!)) { push(titleFirst[2]!, titleFirst[1]!); continue; }
    // Name on one line, title on the next (common card layout), or the reverse.
    const next = lines[i + 1];
    if (next && looksLikePersonName(line) && looksLikeTitle(next) && !looksLikePersonName(next)) { push(line, next, conf - 0.05); i++; continue; }
    if (next && looksLikeTitle(line) && !looksLikePersonName(line) && looksLikePersonName(next) && line.length <= 60) { push(next, line, conf - 0.1); i++; }
  }
  return out;
}

/** Results like "Jane Doe - Publisher - The Gazette | LinkedIn" or "Jane Doe, owner of Acme". */
export function peopleFromSearchResult(result: { title: string; snippet?: string; url: string }, companyName: string, now: string, domain?: string | null): PersonRecord[] {
  const out: PersonRecord[] = [];
  const company = companyName.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  let onDomain = false;
  try { onDomain = Boolean(domain) && new URL(result.url).hostname.replace(/^www\./, '').endsWith(String(domain)); } catch { /* bad url */ }
  // Accept only results on the company's own domain or whose text names the company.
  const mentionsCompany = (text: string) => onDomain || (Boolean(company) && text.toLowerCase().replace(/[^a-z0-9 ]/g, '').includes(company.split(' ').slice(0, 2).join(' ')));
  const title = cleanText(result.title);
  const parts = title.split(/\s+[-–—|]\s+/);
  if (parts.length >= 2 && looksLikePersonName(parts[0]!) && looksLikeTitle(parts[1]!) && mentionsCompany(title + ' ' + (result.snippet ?? ''))) {
    out.push({ name: parts[0]!, title: parts[1]!, sourceUrl: result.url, method: 'web_search', methodConfidence: onDomain ? 0.6 : 0.55, seenAt: now });
  }
  const snippet = cleanText(result.snippet ?? '');
  for (const m of snippet.matchAll(/([A-Z][a-z'’]+(?: [A-Z]\.)?(?: [A-Z][a-z'’-]+){1,2}),\s*(?:the\s+)?([a-zA-Z -]{3,50}?)\s+(?:of|at)\s+([A-Z][^.,;]{2,60})/g)) {
    if (looksLikePersonName(m[1]!) && looksLikeTitle(m[2]!) && mentionsCompany(m[3]!)) {
      out.push({ name: m[1]!, title: m[2]!.trim(), sourceUrl: result.url, method: 'web_search', methodConfidence: 0.45, seenAt: now });
    }
  }
  return out;
}

export function extractPeopleFromPage(html: string, sourceUrl: string, kind: 'homepage' | 'team' | 'masthead' | 'site_search', now: string, org: OrgContext = {}): PersonRecord[] {
  const people = [...peopleFromJsonLd(html, sourceUrl, now), ...peopleFromMicrodata(html, sourceUrl, now)]
    .map((p) => ({ ...p, title: cleanTitle(p.title) || p.title }))
    .filter((p) => affiliationOk(p.title, org));
  // Homepage prose is never mined: news homepages are full of quoted outsiders.
  if (kind !== 'homepage') {
    people.push(...peopleFromText(html, sourceUrl, kind === 'masthead' ? 'masthead_text' : kind === 'site_search' ? 'site_search' : 'team_page_text', now, org));
  }
  return dedupePeople(people);
}

export function dedupePeople(people: PersonRecord[]): PersonRecord[] {
  const byKey = new Map<string, PersonRecord>();
  for (const p of people) {
    const key = `${p.name.toLowerCase()}|${p.title.toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev || p.methodConfidence > prev.methodConfidence) byKey.set(key, p);
  }
  return [...byKey.values()];
}

// ─── Verification + selection ─────────────────────────────────────────────

/** Kind of page a person was read from. Only roster pages may supply prose-extracted names. */
export type SourcePageKind = 'roster' | 'homepage' | 'article' | 'other';

// Strong signals that a page is content, not a roster; they win even when the
// path also says "leadership" (NHBR /events-awards/leadership-unscripted-event/).
const CONTENT_PATH = /\/(?:\d{4}\/\d{1,2}|article|articles|story|stories|blog|blogs|posts?|events?|calendar|search|tags?|category|categories|press-releases?|podcasts?|episodes?|videos?|obituar(?:y|ies)|sponsored|rankings?|best-[a-z-]+|awards?|author|authors|watch|channel|c|user)(?:[/\-_.?#]|$)|[?&](?:s|q|query|search|v)=|\/@/i;
const ROSTER_PATH = /\/(?:about|about-us|team|our-team|the-team|staff|staff-directory|leadership|our-leadership|people|our-people|management|masthead|contact|contact-us|who-we-are|meet-the-team|meet-us|meet|bios?|directory|company|executives|officers|personnel|our-staff|newsroom|station-staff|owners?)(?:[/\-_.?#]|$)/i;
// Weaker content sections; a roster segment beats them ("/news/staff").
const SECTION_PATH = /\/(?:news|press|opinion|lists?|shows?|programs?|features?|columns?|contributors?)(?:[/\-_.?#]|$)/i;

export function sourcePageKind(url: string): SourcePageKind {
  let path = '/';
  try { const u = new URL(url); path = `${u.pathname}${u.search}`; } catch { return 'other'; }
  if (CONTENT_PATH.test(path)) return 'article';
  if (path === '/' || path === '') return 'homepage';
  if (ROSTER_PATH.test(path)) return 'roster';
  if (SECTION_PATH.test(path)) return 'article';
  return 'other';
}

export interface VerifyContext {
  companyName?: string | null;
  domain?: string | null;
  now?: Date;
  policy?: TitlePolicy;
  /** People older than this are not "current". Default 365 days (APEX_DM_MAX_AGE_DAYS). */
  maxAgeDays?: number;
  /** Minimum confidence after corroboration. Default 0.6 (APEX_DM_MIN_CONFIDENCE). */
  minConfidence?: number;
}

export interface CandidateVerification {
  verified: boolean;
  reasons: string[];
  title: TitleClassification;
  confidence: number;
  sourceKind: SourcePageKind;
  onDomain: boolean;
  corroboratedBy: string[];
}

function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function minConfidenceFromEnv(): number {
  return Math.min(0.95, envNumber('APEX_DM_MIN_CONFIDENCE', 0.6));
}

/** Default threshold; the live value is minConfidenceFromEnv(). */
export const FOUND_MIN_CONFIDENCE = 0.6;

function normName(name: string): string {
  return name.toLowerCase().replace(/\b[a-z]\.\s*/g, '').replace(/[^a-z]+/g, ' ').trim();
}

/** Hosts that are never first-party for a lead: social, aggregators, directories, video. */
const THIRD_PARTY_HOST = /(?:^|\.)(?:linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|tiktok\.com|zoominfo\.com|rocketreach\.co|apollo\.io|crunchbase\.com|bloomberg\.com|yelp\.com|bbb\.org|manta\.com|opendi\.us|yellowpages\.com|signalhire\.com|contactout\.com|muckrack\.com|theorg\.com)$/i;

/**
 * The verification bar (unchanged in strength by the wider title allowlist):
 * a valid person name, a qualifying authority title, affiliation with THIS
 * company, and a recorded source URL that is either on the company's own
 * registrable domain and a roster page (not an article, event, ranking or
 * search page, not a sister site) — or an off-domain web/Hunter result
 * corroborated by a first-party record or a second independent non-aggregator
 * host — seen recently, at or above the confidence threshold.
 */
export function verifyCandidate(person: PersonRecord, all: PersonRecord[], ctx: VerifyContext): CandidateVerification {
  const policy = ctx.policy ?? loadTitlePolicy();
  const reasons: string[] = [];
  const title = classifyTitle(person.title, policy);
  const sourceKind = person.sourceUrl ? sourcePageKind(person.sourceUrl) : 'other';
  const onDomain = Boolean(ctx.domain) && sameRegistrableDomain(person.sourceUrl, ctx.domain);
  const direct = person.method === 'email_reply' || person.method === 'phone_call' || person.method === 'operator_entry';

  if (!looksLikePersonName(person.name)) reasons.push('name_invalid');
  if (!title.qualifies) reasons.push(title.deniedBy ? `title_denied:${title.deniedBy}` : title.tier ? 'title_below_min_tier' : 'title_not_authority');
  if (!affiliationOk(person.title, ctx)) reasons.push('affiliation_other_org');
  if (!person.sourceUrl) reasons.push('source_url_missing');

  const now = ctx.now ?? new Date();
  const ageDays = (now.getTime() - Date.parse(person.seenAt)) / 86_400_000;
  const maxAge = ctx.maxAgeDays ?? envNumber('APEX_DM_MAX_AGE_DAYS', 365);
  if (!Number.isFinite(ageDays) || ageDays > maxAge) reasons.push('stale');

  // Corroboration: same person with a qualifying title from a different,
  // non-aggregator host, or from a first-party roster page.
  const key = normName(person.name);
  const host = hostOf(person.sourceUrl);
  const corroboratedBy = [...new Set(all
    .filter((o) => o !== person && normName(o.name) === key && o.sourceUrl && hostOf(o.sourceUrl) !== host
      && classifyTitle(o.title, policy).qualifies && affiliationOk(o.title, ctx)
      && (sameRegistrableDomain(o.sourceUrl, ctx.domain) || !THIRD_PARTY_HOST.test(hostOf(o.sourceUrl) ?? '')))
    .map((o) => o.sourceUrl))];

  if (direct) {
    // The company named the person to us (email reply / call); title rules still apply.
  } else if (onDomain) {
    if (sourceKind === 'article') reasons.push('source_article_or_search_page');
    else if ((person.method === 'team_page_text' || person.method === 'masthead_text' || person.method === 'site_search') && sourceKind !== 'roster') reasons.push('source_not_roster_page');
  } else if ((person.method === 'web_search' || person.method === 'hunter_domain_search') && corroboratedBy.length > 0) {
    // Off-domain but confirmed by an independent source.
  } else {
    reasons.push(ctx.domain ? 'source_off_domain_uncorroborated' : 'source_domain_unknown');
  }

  const confidence = Math.min(0.95, Math.round((person.methodConfidence + (corroboratedBy.length > 0 ? 0.1 : 0)) * 100) / 100);
  if (confidence < (ctx.minConfidence ?? minConfidenceFromEnv())) reasons.push('below_confidence');

  return { verified: reasons.length === 0, reasons, title, confidence, sourceKind, onDomain, corroboratedBy };
}

export interface RoleSelection {
  person: PersonRecord;
  rank: number;
  confidence: number;
  tier: AuthorityTier;
  verification: CandidateVerification;
}

/** Role preference index (lower = preferred); -1 when the title is not one of the role's titles. */
export function titleRank(title: string, role: DecisionMakerRole): number {
  const list = ROLE_TITLE_PRIORITY[role];
  for (let i = 0; i < list.length; i++) if (list[i]!.test(title)) return i;
  return -1;
}

function sortKey(sel: { rank: number; tier: number; confidence: number }): number[] {
  // Role titles first, in the role's own order (editorial: editor-in-chief before
  // publisher); anyone else with authority after them, by tier.
  return sel.rank >= 0 ? [0, sel.rank, -sel.confidence] : [1, sel.tier, -sel.confidence];
}

function better(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/**
 * Best VERIFIED decision maker for a role. Any qualifying authority title
 * counts (owner, VP, director, managing editor, …); the role only sets the
 * preference order. Conditional titles (office manager) count only when no
 * non-conditional verified person exists.
 */
export function selectForRole(people: PersonRecord[], role: DecisionMakerRole, ctx: VerifyContext = {}): RoleSelection | null {
  const verified: RoleSelection[] = [];
  for (const person of people) {
    const verification = verifyCandidate(person, people, ctx);
    if (!verification.verified || !verification.title.tier) continue;
    verified.push({ person, rank: titleRank(person.title, role), confidence: verification.confidence, tier: verification.title.tier, verification });
  }
  const pool = verified.some((v) => !v.verification.title.conditional) ? verified.filter((v) => !v.verification.title.conditional) : verified;
  let best: RoleSelection | null = null;
  for (const sel of pool) if (!best || better(sortKey(sel), sortKey(best))) best = sel;
  return best;
}

export interface BelowBarCandidate {
  name: string;
  title: string;
  sourceUrl: string;
  method: ExtractionMethod;
  confidence: number;
  reasons: string[];
}

/** The most plausible person that did NOT clear the bar; recorded on needs-name leads. */
export function bestBelowBarCandidate(people: PersonRecord[], ctx: VerifyContext = {}): BelowBarCandidate | null {
  let best: { c: BelowBarCandidate; score: number } | null = null;
  for (const person of people) {
    const v = verifyCandidate(person, people, ctx);
    if (v.verified || v.reasons.includes('name_invalid')) continue;
    const score = (v.title.qualifies ? 2 : v.title.tier ? 1 : 0) + v.confidence - v.reasons.length * 0.2;
    if (!best || score > best.score) {
      best = { c: { name: person.name, title: person.title, sourceUrl: person.sourceUrl, method: person.method, confidence: v.confidence, reasons: v.reasons }, score };
    }
  }
  return best?.c ?? null;
}
