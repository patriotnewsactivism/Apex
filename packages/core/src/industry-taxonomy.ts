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

// Matched as whole-word substrings against the lowercased input, first hit
// wins, so order encodes specificity: 'personal injury' must be tested before
// a bare 'law', and 'property management' before 'real estate'.
const PATTERNS: Array<[RegExp, CanonicalIndustry]> = [
  [/\b(hvac|heating|air condition|furnace|hvac contractor)\b/, 'HVAC'],
  [/\b(plumb|plumber|drain|rooter|septic)\b/, 'Plumbing'],
  [/\b(roof|roofer|roofing)\b/, 'Roofing'],
  [/\b(electric|electrician)\b/, 'Electrical'],
  [/\b(solar|photovoltaic)\b/, 'Solar'],
  [/\b(pest|exterminat|termite|wildlife control)\b/, 'Pest Control'],
  [/\b(landscap|lawn care|tree service|irrigation)\b/, 'Landscaping'],
  [/\b(garage door|overhead door)\b/, 'Garage Door'],
  [/\b(chiropract)\b/, 'Chiropractic'],
  [/\b(veterinar|animal hospital|vet clinic)\b/, 'Veterinary'],
  [/\b(dental|dentist|orthodont|endodont|periodont|oral surg)\b/, 'Dental'],
  [/\b(medspa|med spa|medical spa|aesthetic|botox|dermatolog|plastic surg|cosmetic surg)\b/, 'MedSpa'],
  // Legal covers every practice-area spelling; the practice area itself lives
  // in fitReason, not here, so the segment stays countable.
  [/\b(law|lawyer|attorney|legal|personal injury|dui|family law|estate planning|litigat)\b/, 'Legal'],
  [/\b(property management|property manager)\b/, 'Property Management'],
  [/\b(real estate|realtor|realty|brokerage|broker)\b/, 'Real Estate'],
  [/\b(insurance|insurer)\b/, 'Insurance'],
  [/\b(auto repair|automotive|mechanic|collision|body shop|tire)\b/, 'Auto Repair'],
  [/\b(gym|fitness|pilates|crossfit|yoga|personal train)\b/, 'Fitness'],
  // Broadest last: only reached when nothing more specific matched.
  [/\b(contractor|home service|handyman|remodel|restoration|cleaning)\b/, 'Home Services'],
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
  const firstPart = cleaned.split(',')[0].replace(/_/g, ' ').trim();
  const tidied = firstPart
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
    .slice(0, 60)
    .trim();
  return tidied || undefined;
}
