// ─── US state / city lookups for lead-campaign targeting ──────────────────────
//
// createCampaign's territory is a flat industries x cities cross product, and
// typing "Dallas TX, Houston TX, Austin TX, ..." by hand does not scale past a
// handful of metros. This gives callers (the dashboard form and
// start_lead_campaign) a "by state" or "national" shorthand that expands to a
// concrete city list before it ever reaches createCampaign. The campaign
// runner supports national multi-industry searches as one consolidated
// campaign, bounded by a 5,000-segment safety ceiling; it stops early once the
// campaign's requested lead target has been reached.
//
// Three cities per state/DC, chosen for name-recognition and real business
// density rather than strict census rank, since these seed directory-search
// queries ("HVAC Springfield, IL") and an obscure suburb returns fewer usable
// results than a metro a directory actually indexes well.

export const US_STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
];

export const STATE_CITIES: Readonly<Record<string, string[]>> = {
  AL: ['Birmingham, AL', 'Montgomery, AL', 'Huntsville, AL'],
  AK: ['Anchorage, AK', 'Fairbanks, AK', 'Juneau, AK'],
  AZ: ['Phoenix, AZ', 'Tucson, AZ', 'Mesa, AZ'],
  AR: ['Little Rock, AR', 'Fayetteville, AR', 'Fort Smith, AR'],
  CA: ['Los Angeles, CA', 'San Diego, CA', 'San Francisco, CA'],
  CO: ['Denver, CO', 'Colorado Springs, CO', 'Aurora, CO'],
  CT: ['Hartford, CT', 'Bridgeport, CT', 'New Haven, CT'],
  DE: ['Wilmington, DE', 'Dover, DE', 'Newark, DE'],
  DC: ['Washington, DC'],
  FL: ['Miami, FL', 'Orlando, FL', 'Tampa, FL'],
  GA: ['Atlanta, GA', 'Savannah, GA', 'Augusta, GA'],
  HI: ['Honolulu, HI', 'Hilo, HI', 'Kailua-Kona, HI'],
  ID: ['Boise, ID', 'Meridian, ID', 'Idaho Falls, ID'],
  IL: ['Chicago, IL', 'Aurora, IL', 'Naperville, IL'],
  IN: ['Indianapolis, IN', 'Fort Wayne, IN', 'Evansville, IN'],
  IA: ['Des Moines, IA', 'Cedar Rapids, IA', 'Davenport, IA'],
  KS: ['Wichita, KS', 'Overland Park, KS', 'Kansas City, KS'],
  KY: ['Louisville, KY', 'Lexington, KY', 'Bowling Green, KY'],
  LA: ['New Orleans, LA', 'Baton Rouge, LA', 'Shreveport, LA'],
  ME: ['Portland, ME', 'Lewiston, ME', 'Bangor, ME'],
  MD: ['Baltimore, MD', 'Annapolis, MD', 'Rockville, MD'],
  MA: ['Boston, MA', 'Worcester, MA', 'Springfield, MA'],
  MI: ['Detroit, MI', 'Grand Rapids, MI', 'Ann Arbor, MI'],
  MN: ['Minneapolis, MN', 'Saint Paul, MN', 'Rochester, MN'],
  MS: ['Jackson, MS', 'Gulfport, MS', 'Hattiesburg, MS'],
  MO: ['Kansas City, MO', 'St. Louis, MO', 'Springfield, MO'],
  MT: ['Billings, MT', 'Missoula, MT', 'Bozeman, MT'],
  NE: ['Omaha, NE', 'Lincoln, NE', 'Bellevue, NE'],
  NV: ['Las Vegas, NV', 'Reno, NV', 'Henderson, NV'],
  NH: ['Manchester, NH', 'Nashua, NH', 'Concord, NH'],
  NJ: ['Newark, NJ', 'Jersey City, NJ', 'Trenton, NJ'],
  NM: ['Albuquerque, NM', 'Santa Fe, NM', 'Las Cruces, NM'],
  NY: ['New York, NY', 'Buffalo, NY', 'Rochester, NY'],
  NC: ['Charlotte, NC', 'Raleigh, NC', 'Durham, NC'],
  ND: ['Fargo, ND', 'Bismarck, ND', 'Grand Forks, ND'],
  OH: ['Columbus, OH', 'Cleveland, OH', 'Cincinnati, OH'],
  OK: ['Oklahoma City, OK', 'Tulsa, OK', 'Norman, OK'],
  OR: ['Portland, OR', 'Salem, OR', 'Eugene, OR'],
  PA: ['Philadelphia, PA', 'Pittsburgh, PA', 'Allentown, PA'],
  RI: ['Providence, RI', 'Warwick, RI', 'Cranston, RI'],
  SC: ['Charleston, SC', 'Columbia, SC', 'Greenville, SC'],
  SD: ['Sioux Falls, SD', 'Rapid City, SD', 'Aberdeen, SD'],
  TN: ['Nashville, TN', 'Memphis, TN', 'Knoxville, TN'],
  TX: ['Houston, TX', 'Dallas, TX', 'Austin, TX'],
  UT: ['Salt Lake City, UT', 'Provo, UT', 'Ogden, UT'],
  VT: ['Burlington, VT', 'South Burlington, VT', 'Montpelier, VT'],
  VA: ['Virginia Beach, VA', 'Richmond, VA', 'Norfolk, VA'],
  WA: ['Seattle, WA', 'Spokane, WA', 'Tacoma, WA'],
  WV: ['Charleston, WV', 'Huntington, WV', 'Morgantown, WV'],
  WI: ['Milwaukee, WI', 'Madison, WI', 'Green Bay, WI'],
  WY: ['Cheyenne, WY', 'Casper, WY', 'Laramie, WY'],
};

/** Expand state codes (and/or every state) to their city list, deduplicated
 *  and order-preserving. Unknown codes are dropped rather than throwing, so a
 *  typo'd code degrades to "fewer cities" instead of failing the whole call —
 *  callers that care can diff the input against US_STATES themselves. */
export function citiesForStates(stateCodes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of stateCodes) {
    const code = raw.trim().toUpperCase();
    for (const city of STATE_CITIES[code] ?? []) {
      if (!seen.has(city)) {
        seen.add(city);
        out.push(city);
      }
    }
  }
  return out;
}

export function allStateCodes(): string[] {
  return US_STATES.map((s) => s.code);
}
