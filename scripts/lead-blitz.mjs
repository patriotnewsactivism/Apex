// High-speed lead generation — bypasses LLM, calls search + save tools directly
// via the Apex tools API. 3 parallel workers, retry on 502.

import { readFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf8');
function getEnv(name) {
  const m = envContent.match(new RegExp(`^${name}=(.+)$`, 'm'));
  return m?.[1]?.trim();
}

const PASSWORD = getEnv('APEX_ADMIN_PASSWORD');
const BASE = getEnv('PUBLIC_URL') || 'https://apex.donmatthews.live';

if (!PASSWORD) {
  console.error('APEX_ADMIN_PASSWORD not found in .env');
  process.exit(1);
}

const INDUSTRIES = [
  'HVAC contractor', 'personal injury lawyer', 'dental practice', 'real estate agency',
  'insurance agent', 'auto repair shop', 'beauty salon', 'fitness studio',
  'tutoring center', 'accounting firm', 'financial advisor', 'veterinary clinic',
  'landscaping service', 'plumbing contractor', 'electrician', 'roofing contractor',
  'cleaning service', 'photographer', 'wedding planner', 'mortgage broker',
];

const CITIES = [
  'New York NY', 'Los Angeles CA', 'Chicago IL', 'Houston TX', 'Phoenix AZ',
  'Philadelphia PA', 'San Antonio TX', 'San Diego CA', 'Dallas TX', 'San Jose CA',
  'Austin TX', 'Jacksonville FL', 'Fort Worth TX', 'Columbus OH', 'Charlotte NC',
  'San Francisco CA', 'Indianapolis IN', 'Seattle WA', 'Denver CO', 'Boston MA',
  'Nashville TN', 'El Paso TX', 'Portland OR', 'Las Vegas NV', 'Memphis TN',
  'Louisville KY', 'Baltimore MD', 'Milwaukee WI', 'Albuquerque NM', 'Tucson AZ',
  'Fresno CA', 'Sacramento CA', 'Kansas City MO', 'Atlanta GA', 'Omaha NE',
  'Colorado Springs CO', 'Raleigh NC', 'Miami FL', 'Tampa FL', 'Orlando FL',
  'St Louis MO', 'Pittsburgh PA', 'Cincinnati OH', 'Cleveland OH', 'New Orleans LA',
  'Minneapolis MN', 'Tulsa OK', 'Arlington TX', 'Bakersfield CA',
];

const queries = [];
for (const ind of INDUSTRIES) {
  for (const city of CITIES) {
    queries.push(`${ind} ${city}`);
  }
}
for (let i = queries.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [queries[i], queries[j]] = [queries[j], queries[i]];
}

console.log(`Lead Blitz — ${queries.length} queries, 3 workers, targeting 100+ leads/min`);
console.log(`Endpoint: ${BASE}\n`);

let token = null;
let totalLeads = 0;
let totalSaved = 0;
let totalDupes = 0;
let totalErrors = 0;
let queryIndex = 0;
const startTime = Date.now();

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const data = await res.json();
  token = data.token;
  console.log('Authenticated ✓');
}

async function retryFetch(url, opts, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(60000) });
      if (res.status === 502 || res.status === 503) {
        await new Promise(r => setTimeout(r, 2000 * (i + 1))); // backoff
        continue;
      }
      return res;
    } catch (e) {
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw new Error('Max retries exceeded');
}

async function searchAndSave(query) {
  try {
    const searchRes = await retryFetch(`${BASE}/api/tools/searchBusinessDirectory`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!searchRes.ok) {
      const errText = await searchRes.text().catch(() => '');
      throw new Error(`search ${searchRes.status}: ${errText.slice(0, 100)}`);
    }

    const searchData = await searchRes.json();
    // Tools API wraps result in { success, data }
    const businesses = searchData.data?.businesses || searchData.businesses || [];

    if (businesses.length === 0) {
      return { found: 0, saved: 0, dupes: 0 };
    }

    const industry = query.split(' ').slice(0, -2).join(' ');
    const city = query.split(' ').slice(-2).join(' ');

    const leads = businesses
      .filter(b => b.n)
      .map(b => ({
        companyName: b.n.trim(),
        website: b.w || undefined,
        industry,
        city: b.c || city,
        fitReason: `${industry} — handles customer communication, potential BuildMyBot pain point (missed calls, slow response, after-hours gaps)`,
        outreachAngle: 'Cold call offering AI receptionist / lead capture automation',
      }));

    const saveRes = await retryFetch(`${BASE}/api/tools/saveResearchedLeadsBatch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ leads }),
    });

    if (!saveRes.ok) {
      const errText = await saveRes.text().catch(() => '');
      throw new Error(`save ${saveRes.status}: ${errText.slice(0, 100)}`);
    }

    const saveData = await saveRes.json();
    const sd = saveData.data || saveData;
    return {
      found: businesses.length,
      saved: sd.saved || 0,
      dupes: sd.duplicates || 0,
    };
  } catch (err) {
    return { found: 0, saved: 0, dupes: 0, error: err.message };
  }
}

async function worker(workerId) {
  while (queryIndex < queries.length) {
    const myIndex = queryIndex++;
    const query = queries[myIndex];

    const result = await searchAndSave(query);

    totalLeads += result.found;
    totalSaved += result.saved;
    totalDupes += result.dupes;
    if (result.error) totalErrors++;

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = elapsed > 0 ? (totalSaved / (elapsed / 60)).toFixed(1) : '0';

    if (result.found > 0) {
      console.log(
        `  [w${workerId}] ${result.found}→${result.saved} saved, ${result.dupes} dup` +
        ` | total: ${totalSaved} saved, ${totalDupes} dup` +
        ` | ${rate}/min | ${query.slice(0, 40)}`
      );
    } else if (result.error) {
      console.log(`  [w${workerId}] ERR: ${result.error.slice(0, 60)} | ${query.slice(0, 30)}`);
    }
  }
}

async function main() {
  await login();

  const NUM_WORKERS = 2;
  console.log(`Starting ${NUM_WORKERS} parallel workers...\n`);

  const workers = [];
  for (let i = 0; i < NUM_WORKERS; i++) {
    workers.push(worker(i + 1));
  }

  await Promise.all(workers);

  const elapsed = (Date.now() - startTime) / 1000;
  const minutes = elapsed / 60;
  const rate = minutes > 0 ? (totalSaved / minutes).toFixed(1) : '0';

  console.log('\n══════════════════════════════════════════');
  console.log('Lead Blitz Complete');
  console.log('══════════════════════════════════════════');
  console.log(`  Queries run:     ${queries.length}`);
  console.log(`  Leads found:     ${totalLeads}`);
  console.log(`  Leads saved:     ${totalSaved}`);
  console.log(`  Duplicates:      ${totalDupes}`);
  console.log(`  Errors:          ${totalErrors}`);
  console.log(`  Time:            ${elapsed.toFixed(0)}s (${minutes.toFixed(1)} min)`);
  console.log(`  Rate:            ${rate} leads/minute`);
  console.log('══════════════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
