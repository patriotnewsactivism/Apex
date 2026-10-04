/**
 * Where a researched lead may be saved.
 *
 * BuildMyBot's outbound runs in the United States only. Campaign territory is
 * US states (packages/background-jobs/src/us-geo.ts), the outbound caller ID
 * is a US number, and the send windows and compliance rules APEX enforces are
 * US rules. A lead outside the US cannot be worked, so saveResearchedLead and
 * saveResearchedLeadsBatch refuse it with OUT_OF_SCOPE_GEOGRAPHY instead of
 * storing it. Before this check, a research pass could wander abroad and its
 * rows looked the same as every other lead.
 *
 * The rule needs positive evidence that the lead is in the US. A city is in
 * scope when it:
 *   - names a US state or territory: "Lima, OH", "Austin TX", "Brooklyn,
 *     New York 11201", "San Juan, Puerto Rico";
 *   - is a state on its own: "Texas";
 *   - is one of the well-known US cities in US_CITY_NAMES: "Austin".
 *
 * Anything else is refused with a request to give the city as "City, ST".
 * A bare name is ambiguous: Lima is a city in Ohio and the capital of Peru.
 * A missing city is refused too, otherwise leaving it out would get any lead
 * past the check.
 *
 * A contact phone with a country code other than +1 is outside scope, whatever
 * the city says.
 *
 * Known limits: the check reads what the producer wrote. A wrong state, or a
 * foreign region whose abbreviation is also a US state's ("Perth, WA" in
 * Australia, "Chennai, TN" in India), passes. The phone check catches those
 * when the lead carries its real number.
 *
 * There is no input that turns this off. An operator who wants leads outside
 * the US changes this file in a reviewed commit.
 */

export const OUT_OF_SCOPE_GEOGRAPHY = 'OUT_OF_SCOPE_GEOGRAPHY' as const;

export type LeadGeographyRefusalReason =
  | 'missing_location'
  | 'outside_us'
  | 'unrecognized_location'
  | 'non_us_phone';

export type LeadGeographyVerdict =
  | { inScope: true }
  | {
      inScope: false;
      code: typeof OUT_OF_SCOPE_GEOGRAPHY;
      reason: LeadGeographyRefusalReason;
      /** One sentence the agent can act on. Starts with the code. */
      message: string;
    };

/** 50 states and DC, normalized (lowercase, no punctuation). */
const STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina',
  'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island',
  'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
  'district of columbia',
];

const STATE_CODES = [
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky',
  'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd',
  'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc',
];

/** Territories are US jurisdiction, so they count. AS and MP are left out as
 *  codes because "as" is an English word; their names still count. */
const TERRITORY_NAMES = [
  'puerto rico', 'guam', 'us virgin islands', 'virgin islands', 'american samoa',
  'northern mariana islands', 'northern marianas',
];
const TERRITORY_CODES = ['pr', 'gu', 'vi'];

const US_REGIONS = new Set([...STATE_NAMES, ...STATE_CODES, ...TERRITORY_NAMES, ...TERRITORY_CODES]);

/** Trailing country markers that add nothing once a state is present. */
const US_COUNTRY = new Set(['usa', 'us', 'united states', 'united states of america']);

/**
 * Well-known US cities that are in scope without a state: the cities APEX's
 * own campaigns target (us-geo.ts) and the largest US cities by population.
 * Names shared with a non-US city of similar or larger size are left off and
 * need a state: Birmingham, Manchester, San Jose, Santa Ana, Santa Fe, Salem,
 * Richmond, St. Petersburg, Aberdeen, Burlington, Bangor, Dover.
 */
const US_CITY_NAMES = new Set([
  // us-geo.ts campaign cities
  'montgomery', 'huntsville', 'anchorage', 'fairbanks', 'juneau', 'phoenix', 'tucson', 'mesa',
  'little rock', 'fayetteville', 'fort smith', 'los angeles', 'san diego', 'san francisco',
  'denver', 'colorado springs', 'aurora', 'hartford', 'bridgeport', 'new haven', 'wilmington',
  'newark', 'miami', 'orlando', 'tampa', 'atlanta', 'savannah', 'augusta', 'honolulu', 'hilo',
  'kailua kona', 'boise', 'meridian', 'idaho falls', 'chicago', 'naperville', 'indianapolis',
  'fort wayne', 'evansville', 'des moines', 'cedar rapids', 'davenport', 'wichita',
  'overland park', 'kansas city', 'louisville', 'lexington', 'bowling green', 'new orleans',
  'baton rouge', 'shreveport', 'portland', 'lewiston', 'baltimore', 'annapolis', 'rockville',
  'boston', 'worcester', 'springfield', 'detroit', 'grand rapids', 'ann arbor', 'minneapolis',
  'saint paul', 'st paul', 'rochester', 'jackson', 'gulfport', 'hattiesburg', 'st louis',
  'saint louis', 'billings', 'missoula', 'bozeman', 'omaha', 'lincoln', 'bellevue', 'las vegas',
  'reno', 'henderson', 'nashua', 'concord', 'jersey city', 'trenton', 'albuquerque', 'las cruces',
  'new york', 'new york city', 'nyc', 'buffalo', 'charlotte', 'raleigh', 'durham', 'fargo',
  'bismarck', 'grand forks', 'columbus', 'cleveland', 'cincinnati', 'oklahoma city', 'tulsa',
  'norman', 'eugene', 'philadelphia', 'pittsburgh', 'allentown', 'providence', 'warwick',
  'cranston', 'charleston', 'columbia', 'greenville', 'sioux falls', 'rapid city', 'nashville',
  'memphis', 'knoxville', 'houston', 'dallas', 'austin', 'salt lake city', 'provo', 'ogden',
  'south burlington', 'montpelier', 'virginia beach', 'norfolk', 'seattle', 'spokane', 'tacoma',
  'huntington', 'morgantown', 'milwaukee', 'madison', 'green bay', 'cheyenne', 'casper', 'laramie',
  // other large US cities
  'san antonio', 'jacksonville', 'fort worth', 'el paso', 'fresno', 'sacramento', 'long beach',
  'oakland', 'bakersfield', 'arlington', 'anaheim', 'stockton', 'corpus christi', 'riverside',
  'irvine', 'greensboro', 'plano', 'chandler', 'chula vista', 'toledo', 'gilbert',
  'north las vegas', 'lubbock', 'irving', 'laredo', 'winston salem', 'chesapeake', 'glendale',
  'garland', 'scottsdale', 'fremont', 'santa clarita', 'hialeah', 'san bernardino', 'modesto',
  'yonkers', 'moreno valley', 'fontana', 'frisco', 'mckinney',
  // New York City boroughs, which directories give as the city
  'brooklyn', 'queens', 'bronx', 'the bronx', 'manhattan', 'staten island',
]);

/** Places that say outright the lead is outside the US. Only used to word the
 *  refusal: anything that is not positively US is refused either way. */
const NON_US_PLACES = new Set([
  'canada', 'mexico', 'peru', 'colombia', 'chile', 'argentina', 'brazil', 'ecuador', 'bolivia',
  'venezuela', 'uruguay', 'paraguay', 'guatemala', 'honduras', 'el salvador', 'nicaragua',
  'costa rica', 'panama', 'cuba', 'dominican republic', 'jamaica', 'bahamas', 'haiti',
  'united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales', 'northern ireland',
  'ireland', 'france', 'germany', 'spain', 'portugal', 'italy', 'netherlands', 'belgium',
  'switzerland', 'austria', 'sweden', 'norway', 'denmark', 'finland', 'poland', 'greece',
  'turkey', 'russia', 'ukraine', 'israel', 'uae', 'united arab emirates', 'saudi arabia', 'qatar',
  'egypt', 'nigeria', 'kenya', 'south africa', 'ghana', 'morocco', 'india', 'pakistan',
  'bangladesh', 'sri lanka', 'nepal', 'china', 'hong kong', 'taiwan', 'japan', 'south korea',
  'korea', 'philippines', 'vietnam', 'thailand', 'malaysia', 'singapore', 'indonesia',
  'australia', 'new zealand',
  // Canadian provinces and territories
  'ontario', 'quebec', 'british columbia', 'alberta', 'manitoba', 'saskatchewan', 'nova scotia',
  'new brunswick', 'newfoundland', 'newfoundland and labrador', 'prince edward island', 'yukon',
  'northwest territories', 'nunavut', 'on', 'qc', 'bc', 'ab', 'mb', 'sk', 'ns', 'nb', 'nl', 'pe',
  'yt', 'nt', 'nu',
]);

/** Lowercase, strip accents and punctuation, collapse spaces. Commas stay:
 *  they separate the city from its state. */
function normalizePlace(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/[^a-z0-9,]+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drop a trailing ZIP (78701 or 78701-1234, already split by normalizePlace). */
function stripZip(part: string): string {
  return part.replace(/\s*\b\d{5}(?: \d{4})?$/, '').trim();
}

/** Drop a trailing "usa" / "united states" from a single comma part. */
function stripTrailingCountry(part: string): string {
  for (const country of US_COUNTRY) {
    if (part === country) return '';
    if (part.endsWith(` ${country}`)) return part.slice(0, -country.length - 1).trim();
  }
  return part;
}

/** True when the last one, two or three words of `part` are a US state or
 *  territory and at least one word comes before them ("lima oh", "austin
 *  texas", "albany new york"). */
function endsWithUsRegion(part: string): boolean {
  const words = part.split(' ');
  for (const take of [3, 2, 1]) {
    if (words.length <= take) continue;
    if (US_REGIONS.has(words.slice(-take).join(' '))) return true;
  }
  return false;
}

function mentionsNonUsPlace(parts: string[]): boolean {
  return parts.some((part) => {
    if (NON_US_PLACES.has(part)) return true;
    const words = part.split(' ');
    for (const take of [3, 2, 1]) {
      if (words.length > take && NON_US_PLACES.has(words.slice(-take).join(' '))) return true;
    }
    return false;
  });
}

/** +51, +44 or 0044 in front of a number means the business is listed
 *  outside the North American numbering plan. A number without a country
 *  code says nothing either way. */
function hasNonUsCountryCode(phone: string | null | undefined): boolean {
  const compact = (phone ?? '').replace(/[\s().-]/g, '');
  return /^\+(?!1)\d/.test(compact) || /^00(?!1)\d/.test(compact);
}

function refuse(reason: LeadGeographyRefusalReason, message: string): LeadGeographyVerdict {
  return { inScope: false, code: OUT_OF_SCOPE_GEOGRAPHY, reason, message: `${OUT_OF_SCOPE_GEOGRAPHY}: ${message}` };
}

const FORMAT_HINT = "Leads must be in the United States. If this business is in the US, give the city as 'City, ST' (for example 'Austin, TX').";

export function checkLeadGeography(lead: { city?: string | null; contactPhone?: string | null }): LeadGeographyVerdict {
  const raw = (lead.city ?? '').trim();
  if (!raw) return refuse('missing_location', `no city given. ${FORMAT_HINT}`);

  const parts = normalizePlace(raw)
    .split(',')
    .map((part) => stripTrailingCountry(stripZip(part)))
    .filter(Boolean);
  if (parts.length === 0) return refuse('unrecognized_location', `'${raw}' does not name a city. ${FORMAT_HINT}`);

  const last = parts[parts.length - 1];
  const inScope =
    US_REGIONS.has(last) ||
    (parts.length === 1 && (endsWithUsRegion(last) || US_CITY_NAMES.has(last)));

  if (!inScope) {
    return mentionsNonUsPlace(parts)
      ? refuse('outside_us', `'${raw}' is outside the United States. Only US leads can be saved.`)
      : refuse('unrecognized_location', `'${raw}' is not a recognizable US location. ${FORMAT_HINT}`);
  }

  if (hasNonUsCountryCode(lead.contactPhone)) {
    return refuse(
      'non_us_phone',
      `the contact phone '${String(lead.contactPhone).trim()}' has a country code other than +1, so this business is listed outside the United States.`,
    );
  }
  return { inScope: true };
}
