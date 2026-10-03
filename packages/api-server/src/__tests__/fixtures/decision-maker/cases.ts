/**
 * Bad-match fixtures built from the 2026-10-03 dry run (/workspace/apex-leads/
 * DRYRUN_RESULTS.md, LEAD_DM_LADDER_SPEC.md). HTML lives in ./html. Each lead
 * case carries the ground truth a human reviewer assigned: whether the lead
 * may auto-move to contact-ready, and if so which named person.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML_DIR = join(dirname(fileURLToPath(import.meta.url)), 'html');
export const html = (file: string): string => readFileSync(join(HTML_DIR, file), 'utf8');

export interface SearchResult { title: string; url: string; snippet: string }

export interface LeadCase {
  id: string;
  catches: string;
  lead: { companyName: string; website: string; industry: string; city: string; email: string | null; phone: string | null };
  /** URL → fixture file. Paths only ("/staff/") are resolved against the website. */
  pages: Record<string, string>;
  /** Served for any URL whose path+query matches (site search pages). */
  pagePatterns?: Array<{ pattern: RegExp; file: string }>;
  /** Returned by the fake web-search provider for every query. */
  search?: SearchResult[];
  /** Source URLs a human has confirmed (third-party but corroborated); none in this suite. */
  confirmedSources?: string[];
  expect: { contactReady: boolean; decisionMaker?: string; title?: RegExp };
}

export const LEAD_CASES: LeadCase[] = [
  {
    id: 'nhbr_article_quote',
    catches: 'NH Business Review: an event/article page quoting "Beth Slepian, President & CEO, Granite VNA" and "Marty Sink, CEO and President" was taken as NHBR\'s CEO.',
    lead: { companyName: 'NH Business Review', website: 'https://www.nhbr.com/', industry: 'local newspaper', city: 'Manchester, NH', email: 'aandrews@nhbr.com', phone: '+16036241442' },
    pages: { '/': 'nhbr_home.html', '/events-awards/leadership-unscripted-event/': 'nhbr_event.html', '/contact-us/': 'nhbr_contact.html' },
    expect: { contactReady: false },
  },
  {
    id: 'kcur_name_split',
    catches: 'KCUR: "Luke X. Martin Culture — Editor" is a name/title split (title is "Culture Editor"), and a section editor is not a decision maker.',
    lead: { companyName: 'KCUR - Kansas City news and NPR', website: 'https://www.kcur.org/', industry: 'news radio station', city: 'Kansas City, MO', email: 'kcur@kcur.org', phone: '+18162351551' },
    pages: { '/': 'kcur_home.html', '/staff': 'kcur_staff.html' },
    expect: { contactReady: false },
  },
  {
    id: 'kxlb_sister_site_writer',
    catches: 'KXLB: "Carena Liptak — Associate Editor … at Taste of Country" is a writer for a sister Townsquare site (tasteofcountry.com), surfaced on the station\'s site-search page.',
    lead: { companyName: '100.7 KXLB', website: 'https://xlcountry.com/', industry: 'news radio station', city: 'Bozeman, MT', email: null, phone: '+14065862343' },
    pages: { '/': 'kxlb_home.html', '/contact/': 'kxlb_contact.html' },
    pagePatterns: [{ pattern: /[?&]s=/, file: 'kxlb_search.html' }],
    search: [
      { title: 'Carena Liptak - Associate Editor - Taste of Country', url: 'https://tasteofcountry.com/author/carena-liptak/', snippet: 'Carena Liptak is an Associate Editor and staff writer at Taste of Country.' },
      { title: 'Carena Liptak | 100.7 KXLB', url: 'https://xlcountry.com/author/carena-liptak/', snippet: 'Carena Liptak, Associate Editor at Taste of Country, writes about country music.' },
    ],
    expect: { contactReady: false },
  },
  {
    id: 'script_style_names',
    catches: 'Names that exist only inside <script>, <style> or <noscript> ("Greg Holt, Owner" in a JS blob; "Karen Wells, CEO" in a CSS comment) are not visible first-party evidence.',
    lead: { companyName: 'Summit Roofing Co', website: 'https://www.summitroofingco.com/', industry: 'roofing', city: 'Denver, CO', email: null, phone: '+13032964410' },
    pages: { '/': 'summit_home.html', '/about/': 'summit_about.html' },
    expect: { contactReady: false },
  },
  {
    id: 'byline_vs_staff_role',
    catches: 'A byline/article JSON-LD claims "Dana Whitfield, Editor & Publisher"; the staff page says Staff Reporter. Article bylines are not roster evidence.',
    lead: { companyName: 'Carson Valley Times', website: 'https://www.carsonvalleytimes.com/', industry: 'local newspaper', city: 'Minden, NV', email: 'news@carsonvalleytimes.com', phone: '+17757825121' },
    pages: { '/': 'cvt_home.html', '/staff/': 'cvt_staff.html', '/2026/10/02/council-vote/': 'cvt_article.html' },
    search: [{ title: 'County budget vote | Carson Valley Times', url: 'https://www.carsonvalleytimes.com/2026/10/02/council-vote/', snippet: 'By Dana Whitfield, Editor & Publisher. Commissioners voted 3-2.' }],
    expect: { contactReady: false },
  },
  {
    id: 'usnews_rankings_page',
    catches: 'The "us News" discovery query returned a U.S. News & World Report hospital-rankings page as a local newsroom.',
    lead: { companyName: 'US News', website: 'https://www.usnews.com/best-hospitals/area/nv/reno', industry: 'local news website', city: 'Reno, NV', email: null, phone: '+12029552000' },
    pages: { '/best-hospitals/area/nv/reno': 'usnews_rankings.html', '/': 'usnews_rankings.html' },
    expect: { contactReady: false },
  },
  {
    id: 'youtube_channel',
    catches: 'A YouTube channel (youtube.com/@KOLO8News) is a platform page, not the station\'s own website.',
    lead: { companyName: 'KOLO 8 News Now', website: 'https://www.youtube.com/@KOLO8News', industry: 'tv news station', city: 'Reno, NV', email: null, phone: '+17758588888' },
    pages: { '/@KOLO8News': 'youtube_channel.html', '/': 'youtube_channel.html' },
    expect: { contactReady: false },
  },
  {
    id: 'gov_page_mentions_news',
    catches: 'A city government (.gov) news-release page mentions "news" but is not a news business.',
    lead: { companyName: 'City of Reno News', website: 'https://www.reno.gov/government/news', industry: 'local news website', city: 'Reno, NV', email: null, phone: '+17753342097' },
    pages: { '/government/news': 'gov_news.html', '/': 'gov_news.html' },
    expect: { contactReady: false },
  },
  {
    id: 'edu_page_mentions_news',
    catches: 'A university (.edu) news page mentions "news" but is not a news business.',
    lead: { companyName: 'Nevada Today', website: 'https://www.unr.edu/nevada-today', industry: 'local news website', city: 'Reno, NV', email: null, phone: '+17757844941' },
    pages: { '/nevada-today': 'edu_news.html', '/': 'edu_news.html' },
    expect: { contactReady: false },
  },
  {
    id: 'search_snippet_only',
    catches: 'The only evidence is a third-party news snippet ("Mark Benson, owner of Lakeshore Plumbing, said…"); nothing on the company\'s own site.',
    lead: { companyName: 'Lakeshore Plumbing', website: 'https://www.lakeshoreplumbingmn.com/', industry: 'plumbing', city: 'Duluth, MN', email: 'service@lakeshoreplumbingmn.com', phone: '+12187224410' },
    pages: { '/': 'lakeshore_home.html', '/contact/': 'lakeshore_contact.html' },
    search: [{ title: 'Duluth plumbers brace for frozen pipes - Duluth News Tribune', url: 'https://www.duluthnewstribune.com/news/local/duluth-plumbers-frozen-pipes', snippet: 'Mark Benson, owner of Lakeshore Plumbing, said calls doubled during the cold snap.' }],
    expect: { contactReady: false },
  },
  {
    id: 'linkedin_aggregator_only',
    catches: 'A LinkedIn-style profile and a data-aggregator listing name "Jane Roe, Owner" with no first-party confirmation.',
    lead: { companyName: 'Peakview Roofing', website: 'https://www.peakviewroofing.com/', industry: 'roofing', city: 'Colorado Springs, CO', email: null, phone: '+17196334410' },
    pages: { '/': 'peakview_home.html' },
    search: [
      { title: 'Jane Roe - Owner - Peakview Roofing | LinkedIn', url: 'https://www.linkedin.com/in/jane-roe-peakview', snippet: 'Owner at Peakview Roofing · Colorado Springs, Colorado' },
      { title: 'Jane Roe - Owner - Peakview Roofing | ZoomInfo', url: 'https://www.zoominfo.com/p/Jane-Roe/123456', snippet: 'Jane Roe, Owner at Peakview Roofing.' },
    ],
    expect: { contactReady: false },
  },
  // ── Positive controls ──
  {
    id: 'positive_masthead_same_domain',
    catches: 'Control: masthead on the paper\'s own domain names the Editor-in-Chief.',
    lead: { companyName: 'High Desert Sentinel', website: 'https://www.highdesertsentinel.com/', industry: 'local newspaper', city: 'Bend, OR', email: 'news@highdesertsentinel.com', phone: '+15413821811' },
    pages: { '/': 'hds_home.html', '/masthead/': 'hds_masthead.html' },
    expect: { contactReady: true, decisionMaker: 'Maria Lopez', title: /editor-in-chief/i },
  },
  {
    id: 'positive_jsonld_person_same_domain',
    catches: 'Control: JSON-LD Person (Owner) on the company\'s own About page.',
    lead: { companyName: 'Granite State Locksmith', website: 'https://www.granitestatelocksmith.com/', industry: 'locksmith', city: 'Concord, NH', email: null, phone: '+16032284410' },
    pages: { '/': 'gsl_home.html', '/about/': 'gsl_about.html' },
    expect: { contactReady: true, decisionMaker: 'Robert King', title: /owner/i },
  },
  {
    id: 'positive_staff_page',
    catches: 'Control: staff page on the station\'s own domain lists the General Manager.',
    lead: { companyName: 'KBRW 101.9', website: 'https://www.kbrwradio.com/', industry: 'news radio station', city: 'Boise, ID', email: 'info@kbrwradio.com', phone: '+12083441019' },
    pages: { '/': 'kbrw_home.html', '/staff/': 'kbrw_staff.html' },
    expect: { contactReady: true, decisionMaker: 'Linda Park', title: /general manager/i },
  },
];

/** Title authority rules (Matthew, 3:39 PM CT). */
export const TITLE_CASES: Array<{ title: string; qualifies: boolean }> = [
  { title: 'Owner', qualifies: true },
  { title: 'Co-Founder & CEO', qualifies: true },
  { title: 'President', qualifies: true },
  { title: 'Publisher', qualifies: true },
  { title: 'Managing Partner', qualifies: true },
  { title: 'General Manager', qualifies: true },
  { title: 'COO', qualifies: true },
  { title: 'Vice President of Sales', qualifies: true },
  { title: 'VP, Marketing', qualifies: true },
  { title: 'Director of Operations', qualifies: true },
  { title: 'Marketing Director', qualifies: true },
  { title: 'Managing Editor', qualifies: true },
  { title: 'Editor-in-Chief', qualifies: true },
  { title: 'News Director', qualifies: true },
  { title: 'Station Manager', qualifies: true },
  { title: 'Reporter', qualifies: false },
  { title: 'Staff Writer', qualifies: false },
  { title: 'Contributing Writer', qualifies: false },
  { title: 'Associate Editor', qualifies: false },
  { title: 'Culture Editor', qualifies: false },
  { title: 'Executive Assistant to the President', qualifies: false },
  { title: 'Assistant Manager', qualifies: false },
  { title: 'Associate Director', qualifies: false },
  { title: 'Sales Representative', qualifies: false },
  { title: 'Account Executive', qualifies: false },
  { title: 'Marketing Coordinator', qualifies: false },
  { title: 'Intern', qualifies: false },
  { title: 'Former CEO', qualifies: false },
  { title: 'Morning Show Host', qualifies: false },
];

/** CNN Reno/Atlanta: a domain-keyed cache row researched for Atlanta. */
export const CNN_CACHE_ROW = {
  city: 'Atlanta, GA',
  campaignDraft: { firstTouch: 'Show CNN how to capture and follow up with Atlanta news tips before competitors respond.' },
  contactResearch: { contactPhone: '+14048271500' },
  verification: { status: 'verified', checkedAt: '2026-10-01T14:00:00.000Z' },
};
