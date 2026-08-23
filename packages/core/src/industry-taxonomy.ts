// ─── Industry taxonomy ────────────────────────────────────────────────────────
//
// On 2026-08-22 the 4,722 rows in researched_leads carried 819 distinct
// industry strings. "Real Estate", "Real Estate Brokerage", "Real Estate
// Agents" and "real estate agency" were four separate buckets, which makes
// every industry filter, every per-industry count, and every campaign segment
// mean something slightly different from what it says.
//
// Directory providers are the reason: Yelp returns comma-joined category
// titles ("Heating & Air Conditioning/HVAC, Plumbing"), Google Places returns
// its own `types` vocabulary ("real_estate_agency, point_of_interest"), and
// OSM returns whatever the mapper typed. Normalizing on write is the only
// point where all three converge.
//
// Deliberately small and ICP-shaped rather than an exhaustive ontology: these
// are the segments BuildMyBot actually sells into (see BUSINESS_PROFILE.md).
// Anything unrecognized is title-cased and passed through rather than dropped
// — a lead outside the taxonomy is still a lead, and silently discarding its
// industry would be worse than an imperfect label.

/**
 * The industries BuildMyBot actually sells into, verbatim from
 * BUSINESS_PROFILE.md's ICP section:
 *
 *   Home Services: HVAC, Roofing, Plumbing, Solar installation
 *   Legal:         Personal Injury, DUI Defense, Family Law
 *   Medical/Esthetics: MedSpa, Plastic Surgery, Dental Implants
 *   Real Estate brokerages
 *
 * Deliberately narrower than CANONICAL_INDUSTRIES. The taxonomy recognizes
 * plenty of industries that are NOT the ICP (Auto Repair, Fitness,
 * Veterinary...), and normalizing them is still worth doing — a lead outside
 * the ICP is data, not garbage. But "which of these do we actually pitch?" is
 * a separate question from "what is this business?", and conflating the two is
 * how off-ICP companies end up in an outreach queue.
 *
 * BUSINESS_PROFILE.md also names what to avoid: restaurants, generic retail,
 * large corporations.
 */
export const ICP_INDUSTRIES: readonly string[] = [
  'HVAC',
  'Roofing',
  'Plumbing',
  'Solar',
  'Legal',
  'MedSpa',
  'Dental',
  'Real Estate',
];

/** True when a raw industry string normalizes onto the sellable ICP. */
export function isIcpIndustry(raw: string | null | undefined): boolean {
  const normalized = normalizeIndustry(raw);
  return normalized !== undefined && ICP_INDUSTRIES.includes(normalized);
}

/** Canonical industry names. One per real ICP segment. */
export const CANONICAL_INDUSTRIES = [
  'HVAC',
  'Plumbing',
  'Roofing',
  'Electrical',
  'Solar',
  'Pest Control',
  'Landscaping',
  'Garage Door',
  'Legal',
  'Dental',
  'MedSpa',
  'Chiropractic',
  'Veterinary',
  'Real Estate',
  'Property Management',
  'Insurance',
  'Auto Repair',
  'Fitness',
  'Home Services',
] as const;

export type CanonicalIndustry = (typeof CANONICAL_INDUSTRIES)[number];

// Matched against the lowercased, separator-normalized input; first hit wins,
// so order encodes specificity: 'property management' is tested before 'real
// estate', and landscaping before legal so "lawn care" is claimed before the
// bare "law" pattern can see it.
//
// Most entries are STEMS anchored only at the start (\b + stem, no trailing
// \b). A trailing \b was the original bug: \bdentist\b cannot match
// "Dentists" and \blandscap\b cannot match "landscaping", so 39 dentist
// leads and every landscaping spelling fell through to the passthrough branch
// and fragmented into exactly the separate buckets this file exists to merge.
// Short words that are prefixes of unrelated words keep the trailing \b —
// 'law' must not match 'lawn', 'roof' is safe but 'vet' would not be.
const PATTERNS: Array<[RegExp, CanonicalIndustry]> = [
  [/\b(hvac|heating|air condition|furnace)/, 'HVAC'],
  [/\b(plumb|drain cleaning|rooter|septic)/, 'Plumbing'],
  [/\b(roof)/, 'Roofing'],
  [/\b(electric)/, 'Electrical'],
  [/\b(solar|photovoltaic)/, 'Solar'],
  [/\b(pest|exterminat|termite|wildlife control)/, 'Pest Control'],
  // Before Legal: "lawn care" must not be claimed by the bare 'law' pattern.
  [/\b(landscap|lawn|tree service|irrigation)/, 'Landscaping'],
  [/\b(garage door|overhead door)/, 'Garage Door'],
  [/\b(chiropract)/, 'Chiropractic'],
  [/\b(veterinar|animal hospital|vet clinic)/, 'Veterinary'],
  [/\b(dental|dentist|dentis|orthodont|endodont|periodont|oral surg)/, 'Dental'],
  [/\b(medspa|med spa|medical spa|aesthetic|botox|dermatolog|plastic surg|cosmetic surg)/, 'MedSpa'],
  // Legal covers every practice-area spelling; the practice area itself lives
  // in fitReason, not here, so the segment stays countable. 'law' and 'dui'
  // keep a trailing \b — bare 'law' would otherwise swallow 'lawn'.
  [/\b(law\b|lawyer|attorney|legal|personal injury|dui\b|litigat)/, 'Legal'],
  [/\b(property manage)/, 'Property Management'],
  [/\b(real estate|realtor|realty|brokerage|broker)/, 'Real Estate'],
  [/\b(insurance|insurer)/, 'Insurance'],
  [/\b(auto repair|automotive|mechanic|collision|body shop|tire shop)/, 'Auto Repair'],
  [/\b(gym\b|fitness|pilates|crossfit|yoga|personal train)/, 'Fitness'],
  // Broadest last: only reached when nothing more specific matched.
  [/\b(contractor|home service|home improvement|handyman|remodel|restoration|cleaning|construction|home builder)/, 'Home Services'],
];

/**
 * Map a raw provider-supplied industry string onto the canonical taxonomy.
 *
 * Returns the canonical name when one matches, otherwise a tidied version of
 * the input (title-cased, first comma-separated part, length-bounded). Never
 * returns an empty string for non-empty input, and never throws.
 */
export function normalizeIndustry(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim();
  if (!cleaned) return undefined;

  // Underscores and slashes must become spaces BEFORE matching. Google Places
  // returns `real_estate_agency` and Yelp returns
  // `Heating & Air Conditioning/HVAC` — and in JS `_` is a word character, so
  // \b(real estate)\b can never match `real_estate_agency`. Every Google
  // Places category would have fallen through to the passthrough branch and
  // re-created the exact fragmentation this file exists to fix.
  const haystack = cleaned.toLowerCase().replace(/[_/]+/g, ' ');
  for (const [pattern, canonical] of PATTERNS) {
    if (pattern.test(haystack)) return canonical;
  }

  // Unrecognized: keep the most specific-looking part and tidy it, rather than
  // storing "point_of_interest, establishment" or a 200-char category dump.
  const firstPart = cleaned.split(',')[0].replace(/[_/]+/g, ' ').replace(/\s+/g, ' ').trim();
  const tidied = firstPart
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
    .slice(0, 60)
    .trim();
  return tidied || undefined;
}
