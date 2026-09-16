import { normalizeIndustry } from './packages/core/src/industry-taxonomy.js';
import { computeCampaignProgress, STALL_AFTER_MS } from './packages/background-jobs/src/campaign-runner.js';

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

console.log('\n-- industry normalization (819 strings -> canonical) --');
check('Real Estate variants collapse to one bucket',
  new Set(['Real Estate','Real Estate Brokerage','Real Estate Agents','real estate agency','realtor','Realty Group']
    .map(normalizeIndustry)).size === 1,
  JSON.stringify(['Real Estate','Real Estate Brokerage','real estate agency','realtor'].map(normalizeIndustry)));
check('Yelp comma-joined categories map', normalizeIndustry('Heating & Air Conditioning/HVAC, Plumbing') === 'HVAC');
check('Google Places types map', normalizeIndustry('real_estate_agency, point_of_interest') === 'Real Estate');
check('practice areas all land in Legal',
  new Set(['Personal Injury Lawyer','DUI Attorney','Family Law','Estate Planning Law'].map(normalizeIndustry)).size === 1);
check('property management beats real estate (order matters)',
  normalizeIndustry('Property Management Company') === 'Property Management');
check('unknown industry is tidied, not dropped',
  normalizeIndustry('artisanal candle maker') === 'Artisanal Candle Maker',
  String(normalizeIndustry('artisanal candle maker')));
check('junk types get tidied not stored raw',
  (normalizeIndustry('point_of_interest, establishment') || '').length < 30);
check('empty input yields undefined', normalizeIndustry('') === undefined && normalizeIndustry(null) === undefined);

console.log('\n-- progress math --');
const base = (over: any = {}) => ({
  id: 'c1', name: 'Texas HVAC', goalId: null, projectId: 'buildmybot',
  icp: { industries: ['HVAC'], cities: ['Dallas TX'] }, targetLeads: 100,
  status: 'running', pushToBuildmybot: false, createdAt: new Date(),
  startedAt: new Date(), completedAt: null, lastProgressAt: new Date(),
  createdByAgentId: null, result: null, ...over,
}) as any;
const seg = (over: any = {}) => ({
  id: Math.random().toString(36).slice(2), campaignId: 'c1', industry: 'HVAC', city: 'Dallas TX',
  status: 'pending', found: 0, saved: 0, duplicates: 0, attempts: 0, maxAttempts: 3,
  leasedAt: null, lastError: null, startedAt: null, completedAt: null, createdAt: new Date(), ...over,
}) as any;

const t0 = new Date('2026-08-22T10:00:00Z'), t1 = new Date('2026-08-22T10:02:00Z');
const mixed = [
  seg({ status: 'done', saved: 10, found: 12, duplicates: 2, startedAt: t0, completedAt: t1 }),
  seg({ status: 'done', saved: 6, found: 8, duplicates: 2, startedAt: t0, completedAt: t1 }),
  seg({ status: 'exhausted', saved: 0, found: 3, duplicates: 3, startedAt: t0, completedAt: t1 }),
  seg({ status: 'failed', lastError: 'boom' }),
  seg({ status: 'pending' }), seg({ status: 'pending' }),
];
const p = computeCampaignProgress(base(), mixed);
check('leadsSaved sums segments', p.leadsSaved === 16, String(p.leadsSaved));
check('exhausted counts toward coverage, not yield-as-failure', p.segmentsDone === 3, String(p.segmentsDone));
check('failed counted separately', p.segmentsFailed === 1);
check('remaining excludes done+failed', p.segmentsRemaining === 2, String(p.segmentsRemaining));
check('yield uses completed segments', Math.abs((p.yieldPerSegment ?? 0) - 16/3) < 0.001);
check('ETA is a real number when yield exists', p.etaMs !== null && p.etaMs > 0);
check('duplicates surfaced', p.duplicatesSkipped === 7, String(p.duplicatesSkipped));

const fresh = computeCampaignProgress(base(), [seg({ status: 'pending' })]);
check('yield is null with zero completed segments (no divide-by-zero)', fresh.yieldPerSegment === null);
check('ETA is null rather than fabricated', fresh.etaMs === null);

const over = computeCampaignProgress(base({ targetLeads: 10 }),
  [seg({ status: 'done', saved: 25, startedAt: t0, completedAt: t1 })]);
check('over-delivery caps the bar at 100%', over.leadProgress === 1, String(over.leadProgress));

const now = Date.now();
const stalledC = base({ lastProgressAt: new Date(now - STALL_AFTER_MS - 60_000) });
check('stalled is derived, status untouched',
  computeCampaignProgress(stalledC, [seg()], now).displayStatus === 'stalled'
  && computeCampaignProgress(stalledC, [seg()], now).status === 'running');
const freshC = base({ lastProgressAt: new Date(now - 60_000) });
check('recent progress is not stalled',
  computeCampaignProgress(freshC, [seg()], now).displayStatus === 'running');
const pausedC = base({ status: 'paused', lastProgressAt: new Date(now - STALL_AFTER_MS - 60_000) });
check('a paused campaign is never reported stalled',
  computeCampaignProgress(pausedC, [seg()], now).displayStatus === 'paused');

console.log('\n' + (fail === 0 ? 'ALL ' + pass + ' CHECKS PASSED' : pass + ' passed, ' + fail + ' FAILED'));
if (fail > 0) process.exit(1);
