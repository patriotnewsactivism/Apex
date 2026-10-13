/**
 * Decision-maker extraction for the lead pipeline.
 *
 * Why this module exists: the pipeline's contact search was built to find an
 * email and a phone, and the decision maker was whatever fell out of that. The
 * old code took the first non-navigation line of the extracted page text and
 * stored it as `decisionMakerName`. That is not a person — it is frequently a
 * tagline, an address fragment or a cookie notice — and a wrong human attached
 * to a lead is worse than an empty field, because a calling campaign will dial
 * them and read the wrong name out loud.
 *
 * The operator's requirement is the opposite of what the pipeline did: he needs
 * *decision maker names*, owner preferred but any decision maker acceptable, and
 * preferably a direct number, so a calling campaign can be opened against a real
 * person rather than a switchboard. So this module does two things the old
 * heuristic did not:
 *
 *   1. finds an explicit NAME ↔ TITLE association in the text, and
 *   2. refuses anything that is not plausibly a person's name.
 *
 * It never guesses. No association found means `null`, and the caller records
 * the lead as still needing research — which is honest, and is what makes the
 * difference between a list that can be dialed and a list that cannot.
 *
 * Pure and dependency-free on purpose: the campaign runner, the website
 * identity check and any future importer can all use it, and it is unit-testable
 * without a network, a database or an LLM.
 */

/** Titles that mean the holder can decide. Ordered most-authoritative first. */
export const DECISION_MAKER_TITLES: ReadonlyArray<string> = [
  'owner',
  'co-owner',
  'proprietor',
  'founder',
  'co-founder',
  'president',
  'ceo',
  'chief executive officer',
  'chief executive',
  'managing partner',
  'managing member',
  'managing director',
  'principal',
  'partner',
  'general manager',
  'operations manager',
  'office manager',
  'practice manager',
  'store manager',
  'branch manager',
  'manager',
  'director',
];

/** Words that must never appear in an extracted name — titles, business words, page furniture. */
const NAME_STOPWORDS = new Set([
  'owner', 'owners', 'co', 'founder', 'founders', 'president', 'vice', 'ceo', 'cfo', 'coo', 'cto',
  'chief', 'executive', 'officer', 'managing', 'member', 'director', 'manager', 'partner', 'principal',
  'general', 'operations', 'office', 'practice', 'store', 'branch', 'sales', 'service', 'services',
  'company', 'inc', 'llc', 'ltd', 'corp', 'corporation', 'group', 'team', 'staff', 'our', 'the',
  'contact', 'about', 'home', 'welcome', 'meet', 'leadership', 'management', 'careers', 'privacy',
  'terms', 'rights', 'reserved', 'copyright', 'email', 'phone', 'call', 'today', 'click', 'here',
  'read', 'more', 'learn', 'get', 'free', 'quote', 'estimate', 'schedule', 'book', 'appointment',
  'hours', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'monday–friday', 'am', 'pm',
  // Trade and marketing nouns. A tagline or a product line read as a person name
  // ("Solid Wood", "Quality Roofing") is the failure this list exists to stop:
  // a campaign that dials a stranger and reads a product name out loud is worse
  // than a lead with no name, so these are rejected even when one could, in
  // principle, be a surname.
  'solid', 'quality', 'premier', 'elite', 'affordable', 'reliable', 'trusted', 'professional',
  'wood', 'fence', 'fencing', 'roofing', 'roof', 'plumbing', 'heating', 'cooling', 'hvac', 'air',
  'electric', 'electrical', 'construction', 'remodeling', 'painting', 'flooring', 'concrete',
  'landscaping', 'lawn', 'cleaning', 'janitorial', 'pest', 'towing', 'auto', 'automotive',
  'tire', 'tires', 'dental', 'dentistry', 'medical', 'clinic', 'health', 'insurance', 'realty',
  'real', 'estate', 'salon', 'barber', 'nails', 'spa', 'massage', 'fitness', 'gym', 'bakery',
  'restaurant', 'cafe', 'catering', 'bail', 'bonds', 'locksmith', 'storage', 'moving', 'movers',
  'supply', 'equipment', 'rental', 'solutions', 'systems', 'specialists', 'experts', 'pros',
]);

const MONTHS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);

/** A person-name token: a capitalised word of letters, allowing O'Brien / Anne-Marie. */
const NAME_TOKEN = /^[A-Z][A-Za-z'’-]{1,}$/;

function isPlausibleNameToken(token: string): boolean {
  if (!NAME_TOKEN.test(token)) return false;
  const bare = token.replace(/[.'’-]/g, '').toLowerCase();
  if (bare.length < 2) return false;
  if (NAME_STOPWORDS.has(bare)) return false;
  if (MONTHS.has(bare)) return false;
  return true;
}

/**
 * A plausible person name: 2-3 capitalised tokens, none of them a title or
 * business word, with a surname of at least 3 characters.
 *
 * Two tokens is the common case ("Dana Whitfield"); three covers a middle
 * initial or a middle name ("Dana R. Whitfield", "Dana Rae Whitfield"). A
 * single token is never accepted — one capitalised word is a page heading far
 * more often than it is a person.
 */
/**
 * A single-letter initial ("Dana R. Whitfield"). Allowed in a non-final
 * position only — a one-letter surname is not a name.
 */
function isInitialToken(token: string): boolean {
  const bare = token.replace(/[.'’-]/g, '');
  return bare.length === 1 && /[A-Z]/.test(bare);
}

export function isPlausiblePersonName(candidate: string): boolean {
  const tokens = candidate
    .replace(/[,.;:]+$/, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/^[^\w'’-]+|[^\w'’-]+$/g, ''))
    .filter(Boolean);
  if (tokens.length < 2 || tokens.length > 3) return false;
  // The surname must be a real word of at least 3 characters.
  const surname = tokens[tokens.length - 1];
  if (!isPlausibleNameToken(surname)) return false;
  if (surname.replace(/[.'’-]/g, '').length < 3) return false;
  // Every earlier token must be a plausible name word or a middle initial.
  for (const token of tokens.slice(0, -1)) {
    if (!isPlausibleNameToken(token) && !isInitialToken(token)) return false;
  }
  return true;
}

/** Map a matched title back to its canonical form, or null when it is not a decision-maker title. */
export function canonicalDecisionMakerTitle(text: string): string | null {
  const normalized = text.toLowerCase().replace(/[.\s]+$/, '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  // Longest match wins so "general manager" does not degrade to "manager".
  const ordered = [...DECISION_MAKER_TITLES].sort((a, b) => b.length - a.length);
  for (const title of ordered) {
    const pattern = new RegExp(`(?:^|[^a-z])${title.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?:$|[^a-z])`, 'i');
    if (pattern.test(` ${normalized} `)) return title;
  }
  return null;
}

export interface DecisionMaker {
  name: string;
  /** Canonical title, or null when the text associated a name with a role we could not name. */
  title: string | null;
}

/** Rank so an owner outranks a manager when a page lists several people. */
function titleRank(title: string | null): number {
  if (!title) return DECISION_MAKER_TITLES.length;
  const index = DECISION_MAKER_TITLES.indexOf(title);
  return index === -1 ? DECISION_MAKER_TITLES.length : index;
}

/**
 * Find the most senior decision maker stated in the text.
 *
 * Recognises the two ways small-business sites actually write this:
 *
 *   "Dana Whitfield, Owner"        name then title
 *   "Owner: Dana Whitfield"        title then name
 *   "Dana Whitfield — Owner"       either separator
 *
 * Segments are scanned individually so a name and a title on unrelated lines
 * are never joined. Returns the highest-ranked title found, or null.
 */
export function extractDecisionMaker(text: string): DecisionMaker | null {
  if (!text) return null;

  const found: DecisionMaker[] = [];

  // Split on line/segment boundaries. Contact cards put the name and title in
  // one segment; anything else is a coincidence we must not join.
  //
  // The sentence-boundary split deliberately does NOT fire after a lone capital
  // letter, so a middle initial survives: "Dana R. Whitfield, President" is one
  // segment, not "Dana R." plus "Whitfield, President" — which would leave the
  // name unattached and lose the person entirely.
  const segments = text
    .split(/[\n\r;|•·]|(?<!\b[A-Z])[.!?]\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0 && s.length <= 160);

  for (const segment of segments) {
    // name then title:  "Dana Whitfield, Owner"
    const nameFirst = segment.match(
      /^([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’.-]*){1,2})\s*[,–—:-]\s*([A-Za-z][A-Za-z /-]{2,40})$/,
    );
    if (nameFirst) {
      const name = nameFirst[1].trim();
      const title = canonicalDecisionMakerTitle(nameFirst[2]);
      if (title && isPlausiblePersonName(name)) found.push({ name, title });
    }

    // title then name:  "Owner: Dana Whitfield"  /  "Owner – Dana Whitfield"
    const titleFirst = segment.match(
      /^([A-Za-z][A-Za-z /-]{2,40}?)\s*[,–—:-]\s*([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’.-]*){1,2})$/,
    );
    if (titleFirst) {
      const title = canonicalDecisionMakerTitle(titleFirst[1]);
      const name = titleFirst[2].trim();
      if (title && isPlausiblePersonName(name)) found.push({ name, title });
    }

    // "Owner Dana Whitfield" / "Meet the Owner Dana Whitfield"
    const inline = segment.match(
      /\b(?:owner|co-owner|proprietor|founder|co-founder|president|ceo|principal|partner|general manager|manager|director)\b[,:\s]+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’.-]*){1,2})/i,
    );
    if (inline) {
      const title = canonicalDecisionMakerTitle(inline[0].slice(0, inline[0].length - inline[1].length));
      const name = inline[1].trim();
      if (title && isPlausiblePersonName(name)) found.push({ name, title });
    }
  }

  // Adjacent-line association — the standard team-card layout, where the name
  // and the title are on consecutive lines with no separator at all:
  //
  //   Dana Whitfield
  //   Owner
  //
  // Only a segment that is *exactly* a title phrase counts as the second line,
  // so a name followed by prose is not joined.
  for (let i = 0; i < segments.length - 1; i++) {
    const line = segments[i];
    const next = segments[i + 1];
    if (isPlausiblePersonName(line)) {
      const title = next.length <= 40 ? canonicalDecisionMakerTitle(next) : null;
      if (title) found.push({ name: line.replace(/[,.;:]+$/, ''), title });
    }
    if (isPlausiblePersonName(next)) {
      const title = line.length <= 40 ? canonicalDecisionMakerTitle(line) : null;
      if (title) found.push({ name: next.replace(/[,.;:]+$/, ''), title });
    }
  }

  if (found.length === 0) return null;

  // Prefer the most senior title; break ties by the order the site listed them
  // (a site usually leads with the person who matters).
  const ranked = found
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => titleRank(a.candidate.title) - titleRank(b.candidate.title) || a.index - b.index);
  return ranked[0].candidate;
}
