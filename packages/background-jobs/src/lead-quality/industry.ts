/**
 * Industry fit classification, per-industry copy, and location sanity.
 *
 * Why this exists (production read, Oct 3 2026, 2:31–2:40 PM CT): the newest
 * 500 leads were ALL labelled industry "us News" yet included hospitals,
 * .gov sites, universities, marketing and law firms and casinos. The old
 * `industryAffinity` split the industry into tokens >= 4 chars ("news") and
 * passed any page whose decoded HTML — scripts, CSS and "newsletter" signup
 * widgets included — contained the token. Every lead then got the same
 * missed-calls fit reason, and outreach copy was not tied to the verified
 * site's location (CNN placed in Reno with an angle about Atlanta).
 */
import {
  headings,
  jsonLdNodes,
  jsonLdPostalAddress,
  metaContent,
  nodeTypes,
  pageTitle,
  visibleText,
  type SiteAddress,
} from './html.js';
import { normalizeUsState, US_STATE_NAMES } from './nanp.js';
import { parseCityState } from './contact-validation.js';

export const INDUSTRY_CLASSIFIER_VERSION = '2026-10-03-v1';

export type NegativeCategory =
  | 'government'
  | 'education'
  | 'healthcare'
  | 'legal'
  | 'marketing_agency'
  | 'casino'
  | 'directory'
  | 'platform';

export type IndustryProfileId =
  | 'news_media'
  | 'roofing'
  | 'bail_bonds'
  | 'locksmith'
  | 'hvac'
  | 'plumbing'
  | 'dental'
  | 'medspa'
  | 'legal'
  | 'generic';

interface NegativeRule {
  category: NegativeCategory;
  host?: RegExp;
  jsonLd?: RegExp;
  /** Matched against title + meta description + og:site_name + first h1 only. */
  prominent?: RegExp;
}

const NEGATIVE_RULES: NegativeRule[] = [
  {
    category: 'government',
    host: /\.gov$|\.gov\.[a-z]{2}$|\.mil$|^(?:www\.)?ci\.|\.ci\.[a-z.]+\.us$|\.(?:state|co|city|town|k12)\.[a-z]{2}\.us$|(?:^|\.)civicplus\.com$|(?:^|\.)granicus\.com$|(?:^|\.)municode\.com$/,
    jsonLd: /GovernmentOrganization|GovernmentOffice|GovernmentBuilding|PoliceStation|FireStation|CityHall|Courthouse/,
    prominent: /\b(?:city of|county of|town of|village of|township of|department of|state of [a-z ]+ (?:official|government)|official (?:web ?site|site) of|police department|sheriff'?s office|fire department|national guard|board of education|banking department|secretary of state)\b/,
  },
  {
    category: 'education',
    host: /\.edu$|\.edu\.[a-z]{2}$|\.k12\.|(?:^|\.)sau\d+\.org$|schools?\.(?:org|net|us)$/,
    jsonLd: /CollegeOrUniversity|EducationalOrganization|HighSchool|MiddleSchool|ElementarySchool|School\b/,
    prominent: /\b(?:university|college|school district|public schools|community college|admissions|undergraduate|graduate school)\b/,
  },
  {
    category: 'healthcare',
    jsonLd: /Hospital|MedicalOrganization|MedicalClinic|Physician|Pharmacy|DiagnosticLab/,
    prominent: /\b(?:hospital|health system|medical center|healthcare|health care|urgent care|physicians? group|patient portal|behavioral health|health services)\b/,
  },
  {
    category: 'legal',
    jsonLd: /LegalService|Attorney|Notary/,
    prominent: /\b(?:law firm|law offices?|attorneys? at law|attorneys?|lawyers?|personal injury|llp)\b/,
  },
  {
    category: 'marketing_agency',
    prominent: /\b(?:seo|search engine optimi[sz]ation|digital marketing|marketing agency|web design|website design|advertising agency|branding agency|creative agency|public relations firm|pr agency|lead generation|growth agency|social media marketing)\b/,
  },
  {
    category: 'casino',
    jsonLd: /Casino/,
    prominent: /\b(?:casino|sportsbook|slot machines?|poker room|resort (?:&|and) casino)\b/,
  },
  {
    category: 'directory',
    host: /(?:^|\.)(?:yelp|yellowpages|opendi|manta|bbb|mapquest|tripadvisor|angi|homeadvisor|thumbtack|nextdoor|chamberofcommerce|cylex|hotfrog|superpages|citysearch|merchantcircle|clubrunner|bestof[a-z]*|expertise|threebestrated|birdeye|zoominfo|discern|securityinfo)\.[a-z.]+$/,
    prominent: /\b(?:(?:best|top) \d+ |business directory|find a business|listings? near you)\b/,
  },
  {
    category: 'platform',
    host: /(?:^|\.)(?:youtube|facebook|linkedin|instagram|twitter|x|tiktok|wikipedia|reddit|medium|pinterest|google|apple|amazon|shiply)\.com$|(?:^|\.)ivy\.fm$/,
  },
];

interface PositiveRule { re: RegExp; weight: number; where: 'prominent' | 'body' | 'jsonld' }

interface IndustryProfile {
  id: IndustryProfileId;
  label: string;
  match: RegExp;
  positives: PositiveRule[];
  /** Negative categories that ARE this industry (a law firm is not negative for "legal"). */
  allow: NegativeCategory[];
  minScore: number;
  /** Strict profiles treat "not enough signal" as a mismatch instead of "uncertain". */
  strict: boolean;
}

const CALL_SIGN = /\b[KW][A-Z]{2,3}(?:-(?:TV|FM|AM|DT|LP|LD|CD|HD\d?))\b/;
const CALL_SIGN_IN_CONTEXT = /\b[KW][A-Z]{3}\b(?=[^.]{0,40}\b(?:tv|radio|news|fm|am|channel|\d{1,3}(?:\.\d)?)\b)/i;

const PROFILES: IndustryProfile[] = [
  {
    id: 'news_media',
    label: 'news and media',
    match: /\bnews|newspaper|journalis|broadcast|radio|television|\btv\b|magazine|publisher|publishing|\bmedia outlet/,
    allow: [],
    minScore: 4,
    strict: true,
    positives: [
      { re: /NewsMediaOrganization|NewsArticle|ReportageNewsArticle|AnalysisNewsArticle|BroadcastService|RadioStation|TelevisionStation|TelevisionChannel|RadioChannel|Newspaper|Periodical|PublicationIssue/, weight: 4, where: 'jsonld' },
      { re: /\b(?:news|newspaper|newsroom|gazette|tribune|herald|radio|public radio|television|broadcast(?:ing)?|magazine|daily|weekly)\b/i, weight: 2, where: 'prominent' },
      { re: CALL_SIGN, weight: 3, where: 'prominent' },
      { re: CALL_SIGN_IN_CONTEXT, weight: 2, where: 'prominent' },
      { re: /\bnewsroom\b/i, weight: 1, where: 'body' },
      { re: /\bmasthead\b/i, weight: 2, where: 'body' },
      { re: /\beditor[- ]in[- ]chief\b|\bmanaging editor\b|\bnews director\b|\bexecutive editor\b|\bcity editor\b/i, weight: 2, where: 'body' },
      { re: /\b(?:submit a|send us a|news) tips?\b/i, weight: 1, where: 'body' },
      { re: /\bbreaking news\b|\blocal news\b|\btop stories\b|\blatest headlines\b/i, weight: 1, where: 'body' },
      { re: /\bobituaries\b|\be-edition\b|\bletters to the editor\b|\bopinion\b.*\bsports\b/i, weight: 1, where: 'body' },
      { re: /\bwatch live\b|\blisten live\b|\bon air\b|\bnewscasts?\b|\bmeteorologists?\b/i, weight: 1, where: 'body' },
      { re: /\b(?:abc|nbc|cbs|fox|pbs|npr|cw|univision|telemundo) (?:affiliate|member station)\b/i, weight: 2, where: 'body' },
    ],
  },
  {
    id: 'roofing', label: 'roofing', match: /roof/, allow: [], minScore: 3, strict: false,
    positives: [
      { re: /RoofingContractor/, weight: 4, where: 'jsonld' },
      { re: /\broof(?:ing|er|ers| repair| replacement)?\b/i, weight: 3, where: 'prominent' },
      { re: /\broof(?:ing|er|ers| repair| replacement)?\b/i, weight: 1, where: 'body' },
      { re: /\bshingles?\b|\bstorm damage\b|\bgutters?\b/i, weight: 1, where: 'body' },
    ],
  },
  {
    id: 'bail_bonds', label: 'bail bonds', match: /bail/, allow: [], minScore: 3, strict: false,
    positives: [
      { re: /\bbail\b|\bbondsm[ae]n\b/i, weight: 3, where: 'prominent' },
      { re: /\bbail\b|\bbondsm[ae]n\b|\bsurety\b/i, weight: 1, where: 'body' },
    ],
  },
  {
    id: 'locksmith', label: 'locksmith', match: /locksmith/, allow: [], minScore: 3, strict: false,
    positives: [
      { re: /Locksmith/, weight: 4, where: 'jsonld' },
      { re: /\blocksmiths?\b|\block ?outs?\b/i, weight: 3, where: 'prominent' },
      { re: /\blocksmiths?\b|lock repair|\block ?outs?\b|rekey/i, weight: 1, where: 'body' },
    ],
  },
  {
    id: 'hvac', label: 'HVAC', match: /hvac|heating|air condition|cooling/, allow: [], minScore: 3, strict: false,
    positives: [
      { re: /HVACBusiness/, weight: 4, where: 'jsonld' },
      { re: /\bhvac\b|air condition|heating|furnace|\bac repair\b/i, weight: 3, where: 'prominent' },
      { re: /\bhvac\b|air condition|heating|furnace|heat pump/i, weight: 1, where: 'body' },
    ],
  },
  {
    id: 'plumbing', label: 'plumbing', match: /plumb/, allow: [], minScore: 3, strict: false,
    positives: [
      { re: /Plumber/, weight: 4, where: 'jsonld' },
      { re: /\bplumb(?:er|ers|ing)\b|water heater|drain/i, weight: 3, where: 'prominent' },
      { re: /\bplumb(?:er|ers|ing)\b|water heater|drain|sewer/i, weight: 1, where: 'body' },
    ],
  },
  {
    id: 'dental', label: 'dental', match: /dental|dentist/, allow: ['healthcare'], minScore: 3, strict: false,
    positives: [
      { re: /Dentist/, weight: 4, where: 'jsonld' },
      { re: /\bdent(?:al|ist|ists|istry)\b|orthodont/i, weight: 3, where: 'prominent' },
      { re: /\bdent(?:al|ist|ists|istry)\b|orthodont|implants?\b/i, weight: 1, where: 'body' },
    ],
  },
  {
    id: 'medspa', label: 'med spa', match: /medspa|med spa|medical spa|aesthetic/, allow: ['healthcare'], minScore: 3, strict: false,
    positives: [
      { re: /\bmed(?:ical)? ?spa\b|botox|aesthetic|laser hair/i, weight: 3, where: 'prominent' },
      { re: /\bmed(?:ical)? ?spa\b|botox|aesthetic|laser hair|filler/i, weight: 1, where: 'body' },
    ],
  },
  {
    id: 'legal', label: 'legal', match: /legal|\blaw\b|attorney|lawyer/, allow: ['legal'], minScore: 3, strict: false,
    positives: [
      { re: /LegalService|Attorney/, weight: 4, where: 'jsonld' },
      { re: /\blaw\b|lawyers?|attorneys?|legal/i, weight: 3, where: 'prominent' },
      { re: /\blaw\b|lawyers?|attorneys?|legal/i, weight: 1, where: 'body' },
    ],
  },
];

export function industryProfileFor(industry: string | null | undefined): IndustryProfile | null {
  const normalized = (industry ?? '').toLowerCase().replace(/[_/]+/g, ' ');
  if (!normalized.trim()) return null;
  return PROFILES.find((p) => p.match.test(normalized)) ?? null;
}

export function industryProfileId(industry: string | null | undefined): IndustryProfileId {
  return industryProfileFor(industry)?.id ?? 'generic';
}

export interface IndustryFitInput {
  industry: string | null | undefined;
  url: string | null | undefined;
  html: string;
}

export interface IndustryFit {
  version: string;
  profile: IndustryProfileId;
  verdict: 'match' | 'mismatch' | 'uncertain';
  score: number;
  positiveSignals: string[];
  negativeCategory: NegativeCategory | null;
  negativeEvidence: string | null;
  reason: string;
}

function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try { return new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

export function classifyIndustryFit(input: IndustryFitInput): IndustryFit {
  const profile = industryProfileFor(input.industry);
  const host = hostOf(input.url);
  const html = input.html ?? '';
  const types = jsonLdNodes(html).flatMap(nodeTypes).join(' ');
  const prominent = [
    pageTitle(html),
    metaContent(html, 'description') ?? '',
    metaContent(html, 'og:site_name') ?? '',
    metaContent(html, 'og:title') ?? '',
    ...headings(html, 12),
  ].join(' \n ').toLowerCase();
  const body = visibleText(html, 60_000).toLowerCase();
  // Negatives only look at the page's self-description (title, meta, first
  // h1), never at story headlines: a TV station's homepage headline about a
  // hospital must not turn the station into a hospital.
  const identity = [
    pageTitle(html),
    metaContent(html, 'description') ?? '',
    metaContent(html, 'og:site_name') ?? '',
    headings(html, 1).join(' '),
  ].join(' \n ').toLowerCase();

  // Negative categories first: hard evidence (host, JSON-LD) or prominent text.
  let negativeCategory: NegativeCategory | null = null;
  let negativeEvidence: string | null = null;
  let negativeStrong = false;
  for (const rule of NEGATIVE_RULES) {
    if (profile?.allow.includes(rule.category)) continue;
    if (rule.host?.test(host)) { negativeCategory = rule.category; negativeEvidence = `host:${host}`; negativeStrong = true; break; }
    const jsonLdHit = rule.jsonLd ? types.match(rule.jsonLd) : null;
    if (jsonLdHit) { negativeCategory = rule.category; negativeEvidence = `json-ld:${jsonLdHit[0]}`; negativeStrong = true; break; }
    const prominentHit = rule.prominent ? identity.match(rule.prominent) : null;
    if (prominentHit && !negativeCategory) { negativeCategory = rule.category; negativeEvidence = `text:${prominentHit[0]}`; }
  }

  const positiveSignals: string[] = [];
  let score = 0;
  if (profile) {
    for (const rule of profile.positives) {
      const hay = rule.where === 'jsonld' ? types : rule.where === 'prominent' ? prominent : body;
      const hit = hay.match(rule.re);
      if (hit) { score += rule.weight; positiveSignals.push(`${rule.where}:${hit[0].slice(0, 40)}`); }
    }
  } else {
    const tokens = (input.industry ?? '').toLowerCase().split(/[\s,/_-]+/)
      .filter((t) => t.length >= 4 && !['business', 'businesses', 'company', 'companies', 'service', 'services', 'emergency', 'local'].includes(t));
    if (tokens.length === 0) score = 3;
    for (const token of tokens) {
      const re = new RegExp(`\\b${token.replace(/[^a-z0-9]/g, '')}`, 'i');
      if (re.test(prominent)) { score += 3; positiveSignals.push(`prominent:${token}`); }
      const count = body.match(new RegExp(`\\b${token.replace(/[^a-z0-9]/g, '')}`, 'gi'))?.length ?? 0;
      if (count >= 2) { score += Math.min(2, count - 1); positiveSignals.push(`body:${token}x${count}`); }
    }
  }
  const minScore = profile?.minScore ?? 3;
  const hasJsonLdPositive = positiveSignals.some((s) => s.startsWith('jsonld:'));
  const base = {
    version: INDUSTRY_CLASSIFIER_VERSION,
    profile: profile?.id ?? ('generic' as const),
    score,
    positiveSignals,
    negativeCategory,
    negativeEvidence,
  };

  if (negativeCategory && negativeStrong) {
    return { ...base, verdict: 'mismatch', reason: `negative_category:${negativeCategory}` };
  }
  if (negativeCategory) {
    // Prominent-text negatives can be outweighed only by very strong evidence
    // (e.g. a TV station whose headline mentions a hospital story).
    if (hasJsonLdPositive && score >= minScore + 2) return { ...base, verdict: 'match', reason: 'positive_signals_outweigh_text_negative' };
    return { ...base, verdict: 'mismatch', reason: `negative_category:${negativeCategory}` };
  }
  if (score >= minScore) return { ...base, verdict: 'match', reason: 'industry_signals_present' };
  if (score === 0 || profile?.strict) {
    return { ...base, verdict: 'mismatch', reason: score === 0 ? 'no_industry_signals' : 'insufficient_industry_signals' };
  }
  return { ...base, verdict: 'uncertain', reason: 'weak_industry_signals' };
}

// ─── Location ──────────────────────────────────────────────────────────────

export interface LeadLocation {
  city: string | null;       // "Atlanta, GA"
  state: string | null;      // "GA"
  source: 'site_json_ld' | 'lead_search_city' | 'none';
  originalCity: string | null;
  siteAddress: SiteAddress | null;
  conflicts: string[];
  /** The verified site's state (or country) differs from the state the lead
   *  was searched in. Such a lead is kept out of contact-ready: the company is
   *  real but it is not a local lead for that shard (CNN in a Reno shard). */
  geoMismatch: boolean;
}

export function deriveLeadLocation(input: { leadCity: string | null | undefined; html?: string | null; siteAddress?: SiteAddress | null }): LeadLocation {
  const lead = parseCityState(input.leadCity);
  const site = input.siteAddress ?? (input.html ? jsonLdPostalAddress(input.html) : null);
  const conflicts: string[] = [];
  const country = site?.country?.trim().toLowerCase() ?? '';
  const siteIsUs = !country || /^(?:us|usa|united states(?: of america)?)$/.test(country);
  const siteState = site?.region ? normalizeUsState(site.region) : null;
  if (site && !siteIsUs) conflicts.push(`non_us_site_address:${site.country}`);
  const geoMismatch = Boolean((site && !siteIsUs) || (siteState && lead.state && siteState !== lead.state));
  if (siteState && lead.state && siteState !== lead.state) conflicts.push(`site_state_${siteState}_vs_lead_state_${lead.state}`);
  else if (siteState && lead.state && site?.locality && lead.city && site.locality.toLowerCase() !== lead.city.toLowerCase()) {
    conflicts.push(`site_city_${site.locality}_vs_lead_city_${lead.city}`);
  }
  if (site?.locality && siteState && siteIsUs) {
    return { city: `${site.locality}, ${siteState}`, state: siteState, source: 'site_json_ld', originalCity: lead.raw, siteAddress: site, conflicts, geoMismatch };
  }
  return {
    city: lead.raw,
    state: lead.state,
    source: lead.raw ? 'lead_search_city' : 'none',
    originalCity: lead.raw,
    siteAddress: site,
    conflicts,
    geoMismatch,
  };
}

const MAJOR_CITY_STATE: Record<string, string> = {
  'new york': 'NY', 'los angeles': 'CA', chicago: 'IL', houston: 'TX', phoenix: 'AZ', philadelphia: 'PA',
  'san antonio': 'TX', 'san diego': 'CA', dallas: 'TX', austin: 'TX', jacksonville: 'FL', 'san jose': 'CA',
  'fort worth': 'TX', columbus: 'OH', charlotte: 'NC', indianapolis: 'IN', 'san francisco': 'CA', seattle: 'WA',
  denver: 'CO', nashville: 'TN', 'oklahoma city': 'OK', boston: 'MA', 'el paso': 'TX', portland: 'OR',
  'las vegas': 'NV', detroit: 'MI', memphis: 'TN', louisville: 'KY', baltimore: 'MD', milwaukee: 'WI',
  albuquerque: 'NM', tucson: 'AZ', fresno: 'CA', sacramento: 'CA', atlanta: 'GA', miami: 'FL', tampa: 'FL',
  orlando: 'FL', 'new orleans': 'LA', minneapolis: 'MN', cleveland: 'OH', pittsburgh: 'PA', cincinnati: 'OH',
  'kansas city': 'MO', 'st. louis': 'MO', 'salt lake city': 'UT', raleigh: 'NC', omaha: 'NE', reno: 'NV',
  boise: 'ID', honolulu: 'HI', anchorage: 'AK', birmingham: 'AL', richmond: 'VA', buffalo: 'NY',
};

/** Places named in outreach copy that contradict the lead's location. */
export function copyLocationConflicts(text: string | null | undefined, location: { state: string | null; city?: string | null }): string[] {
  if (!text || !location.state) return [];
  const conflicts = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z.'-]+(?: [A-Z][a-zA-Z.'-]+){0,2}),\s*([A-Z]{2})\b/g)) {
    const st = normalizeUsState(m[2]!);
    if (st && st !== location.state) conflicts.add(`${m[1]}, ${st}`);
  }
  const lower = text.toLowerCase();
  const ownCity = (location.city ?? '').split(',')[0]!.trim().toLowerCase();
  for (const [city, st] of Object.entries(MAJOR_CITY_STATE)) {
    if (st === location.state || city === ownCity) continue;
    if (new RegExp(`\\b${city.replace('.', '\\.')}\\b`).test(lower)) conflicts.add(`${city} (${st})`);
  }
  for (const [abbr, name] of Object.entries(US_STATE_NAMES)) {
    if (abbr === location.state || name.length < 5) continue;
    if (new RegExp(`\\b${name.toLowerCase()}\\b`).test(lower) && !(abbr === 'WA' && /washington,? d\.?c/.test(lower))) conflicts.add(name);
  }
  return [...conflicts];
}

// ─── Per-industry copy ─────────────────────────────────────────────────────

const FIT_REASON: Record<IndustryProfileId, (c: string, where: string) => string> = {
  news_media: (c, w) => `${c} is a ${w} news outlet: reader tip lines, advertiser and sponsorship inquiries, and subscriber calls arrive around the clock, and slow replies to ad-sales leads are lost revenue an AI receptionist can capture.`,
  roofing: (c, w) => `${c} is a ${w} roofer: storm-driven call spikes and estimate requests that go to voicemail are jobs lost to whichever competitor answers first.`,
  bail_bonds: (c, w) => `${c} handles bail in ${w}: calls come from jails and families at 2 AM, and the first bondsman who answers usually gets the client.`,
  locksmith: (c, w) => `${c} is a ${w} locksmith: lockout calls are urgent and mobile techs often cannot pick up, so missed calls go straight to the next listing.`,
  hvac: (c, w) => `${c} is a ${w} HVAC contractor: no-heat and no-AC emergencies arrive after hours and during peak season, when the office line is overloaded.`,
  plumbing: (c, w) => `${c} is a ${w} plumber: leaks and backups are emergencies, and callers hang up and dial the next plumber when nobody answers.`,
  dental: (c, w) => `${c} is a ${w} dental practice: new-patient calls during procedures and after hours go unanswered, and each one is a lifetime patient value.`,
  medspa: (c, w) => `${c} is a ${w} med spa: consult requests come in evenings and weekends from social ads, and slow replies cool high-intent leads.`,
  legal: (c, w) => `${c} is a ${w} law practice: potential clients call several firms after an incident, and the first firm to complete intake usually signs the case.`,
  generic: (c, w) => `${c} serves ${w}: inbound calls and web inquiries that are not answered quickly are likely lost revenue that automated response can recover.`,
};

const OUTREACH_ANGLE: Record<IndustryProfileId, (c: string, where: string) => string> = {
  news_media: (c, w) => `Show ${c} how an always-on assistant can answer reader tips, route advertiser inquiries, and follow up on ad-sales leads in ${w} without adding newsroom staff.`,
  roofing: (c, w) => `Show ${c} how to answer every storm-season estimate request in ${w} before competitors call back.`,
  bail_bonds: (c, w) => `Show ${c} how to answer every overnight jail call in ${w} and capture the client before another bondsman does.`,
  locksmith: (c, w) => `Show ${c} how to catch lockout calls in ${w} while techs are on a job.`,
  hvac: (c, w) => `Show ${c} how to capture after-hours no-heat and no-AC calls in ${w} and book them automatically.`,
  plumbing: (c, w) => `Show ${c} how to answer emergency plumbing calls in ${w} when the crew is under a sink.`,
  dental: (c, w) => `Show ${c} how to book new-patient calls in ${w} that come in during procedures or after hours.`,
  medspa: (c, w) => `Show ${c} how to reply instantly to evening consult requests in ${w} from social ads.`,
  legal: (c, w) => `Show ${c} how to complete intake for ${w} callers before they reach the next firm.`,
  generic: (c, w) => `Show ${c} how to respond to every inbound lead in ${w} before competitors do.`,
};

const CALL_OPENER: Record<IndustryProfileId, (c: string, where: string) => string> = {
  news_media: (c, w) => `Hi, this is Don's team. We work with news outlets around ${w} on handling reader tips and advertiser inquiries after hours, and wanted to compare notes with ${c}.`,
  generic: (c, w) => `Hi, this is Don's team. We found ${c} while mapping businesses in ${w}, and wanted to compare notes on missed calls and after-hours lead capture.`,
  roofing: (c, w) => `Hi, this is Don's team. We work with roofers in ${w} on catching storm-season calls, and wanted to compare notes with ${c}.`,
  bail_bonds: (c, w) => `Hi, this is Don's team. We help bail agencies in ${w} answer overnight calls, and wanted to compare notes with ${c}.`,
  locksmith: (c, w) => `Hi, this is Don's team. We help locksmiths in ${w} catch lockout calls while techs are busy, and wanted to compare notes with ${c}.`,
  hvac: (c, w) => `Hi, this is Don's team. We help HVAC shops in ${w} catch after-hours emergency calls, and wanted to compare notes with ${c}.`,
  plumbing: (c, w) => `Hi, this is Don's team. We help plumbers in ${w} answer emergency calls, and wanted to compare notes with ${c}.`,
  dental: (c, w) => `Hi, this is Don's team. We help dental offices in ${w} book new-patient calls they miss, and wanted to compare notes with ${c}.`,
  medspa: (c, w) => `Hi, this is Don's team. We help med spas in ${w} reply to consult requests faster, and wanted to compare notes with ${c}.`,
  legal: (c, w) => `Hi, this is Don's team. We help law practices in ${w} finish intake on after-hours calls, and wanted to compare notes with ${c}.`,
};

const EMAIL_SUBJECT: Record<IndustryProfileId, (c: string) => string> = {
  news_media: (c) => `${c}: reader tips and ad inquiries after hours`,
  roofing: (c) => `${c} storm-season call coverage`,
  bail_bonds: (c) => `${c} overnight call coverage`,
  locksmith: (c) => `${c} lockout call coverage`,
  hvac: (c) => `${c} after-hours emergency calls`,
  plumbing: (c) => `${c} emergency call coverage`,
  dental: (c) => `${c} new-patient call coverage`,
  medspa: (c) => `${c} consult request response time`,
  legal: (c) => `${c} after-hours intake`,
  generic: (c) => `${c} speed-to-lead coverage`,
};

function where(city: string | null | undefined): string {
  return city?.trim() || 'your market';
}

export function industryFitReason(industry: string | null | undefined, city: string | null | undefined, companyName: string): string {
  return FIT_REASON[industryProfileId(industry)](companyName, where(city));
}

export function industryOutreachAngle(companyName: string, industry: string | null | undefined, city: string | null | undefined): string {
  return OUTREACH_ANGLE[industryProfileId(industry)](companyName, where(city));
}

export function industryCallOpener(companyName: string, industry: string | null | undefined, city: string | null | undefined): string {
  return CALL_OPENER[industryProfileId(industry)](companyName, where(city));
}

export function industryEmailSubject(companyName: string, industry: string | null | undefined): string {
  return EMAIL_SUBJECT[industryProfileId(industry)](companyName);
}
