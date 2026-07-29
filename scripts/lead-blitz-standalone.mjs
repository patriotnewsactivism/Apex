// Standalone lead generation — calls Yelp API directly, saves to local JSON.
// No dependency on the Apex server. Imports later via batch API.
//
// Usage: node scripts/lead-blitz-standalone.mjs
// Outputs: scripts/leads-export.json

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf8');
const yelpKey = envContent.match(/^YELP_API_KEY=(.+)$/m)?.[1]?.trim();

if (!yelpKey) {
  console.error('YELP_API_KEY not found in .env');
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
  'New York, NY', 'Los Angeles, CA', 'Chicago, IL', 'Houston, TX', 'Phoenix, AZ',
  'Philadelphia, PA', 'San Antonio, TX', 'San Diego, CA', 'Dallas, TX', 'San Jose, CA',
  'Austin, TX', 'Jacksonville, FL', 'Fort Worth, TX', 'Columbus, OH', 'Charlotte, NC',
  'San Francisco, CA', 'Indianapolis, IN', 'Seattle, WA', 'Denver, CO', 'Boston, MA',
  'Nashville, TN', 'El Paso, TX', 'Portland, OR', 'Las Vegas, NV', 'Memphis, TN',
  'Louisville, KY', 'Baltimore, MD', 'Milwaukee, WI', 'Albuquerque, NM', 'Tucson, AZ',
  'Fresno, CA', 'Sacramento, CA', 'Kansas City, MO', 'Atlanta, GA', 'Omaha, NE',
  'Colorado Springs, CO', 'Raleigh, NC', 'Miami, FL', 'Tampa, FL', 'Orlando, FL',
  'St Louis, MO', 'Pittsburgh, PA', 'Cincinnati, OH', 'Cleveland, OH', 'New Orleans, LA',
  'Minneapolis, MN', 'Tulsa, OK', 'Arlington, TX', 'Bakersfield, CA',
];

// Build queries
const queries = [];
for (const ind of INDUSTRIES) {
  for (const city of CITIES) {
    queries.push({ industry: ind, city, query: `${ind} ${city}` });
  }
}
// Shuffle
for (let i = queries.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [queries[i], queries[j]] = [queries[j], queries[i]];
}

const OUTPUT_FILE = 'scripts/leads-export.json';
const STATS_FILE = 'scripts/leads-stats.txt';

// Load existing leads for dedup
let existingWebsites = new Set();
if (existsSync(OUTPUT_FILE)) {
  try {
    const existing = JSON.parse(readFileSync(OUTPUT_FILE, 'utf8'));
    for (const lead of existing) {
      if (lead.website) existingWebsites.add(lead.website);
    }
    console.log(`Loaded ${existingWebsites.size} existing leads for dedup`);
  } catch {}
}

console.log(`Lead Blitz (standalone) — ${queries.length} queries, 5 workers`);
console.log(`Yelp API key: ${yelpKey.slice(0, 8)}...`);
console.log(`Output: ${OUTPUT_FILE}\n`);

let totalFound = 0;
let totalSaved = 0;
let totalDupes = 0;
let totalErrors = 0;
let queryIndex = 0;
const startTime = Date.now();

async function searchYelp(industry, city, query) {
  // Parse query into term + location for Yelp
  const location = city;
  const term = industry;

  const url = new URL('https://api.yelp.com/v3/businesses/search');
  url.searchParams.set('term', term);
  url.searchParams.set('location', location);
  url.searchParams.set('limit', '20');

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${yelpKey}`,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yelp ${res.status}: ${text.slice(0, 100)}`);
  }

  const data = await res.json();
  return (data.businesses || []).map(b => ({
    companyName: b.name?.trim() || 'Unknown',
    website: b.url ? `https://www.yelp.com/biz/${b.alias}` : undefined,
    phone: b.phone || b.display_phone || '',
    industry,
    city: b.location?.city || city.split(',')[0],
    fitReason: `${industry} — handles customer communication, potential BuildMyBot pain point`,
    outreachAngle: 'Cold call offering AI receptionist / lead capture automation',
  }));
}

async function worker(workerId) {
  while (queryIndex < queries.length) {
    const myIndex = queryIndex++;
    const { industry, city, query } = queries[myIndex];

    try {
      const businesses = await searchYelp(industry, city, query);
      totalFound += businesses.length;

      const newLeads = [];
      for (const lead of businesses) {
        if (lead.website && existingWebsites.has(lead.website)) {
          totalDupes++;
        } else {
          if (lead.website) existingWebsites.add(lead.website);
          newLeads.push(lead);
          totalSaved++;
        }
      }

      if (newLeads.length > 0) {
        // Append to file
        const lines = newLeads.map(l => JSON.stringify(l)).join('\n') + '\n';
        appendFileSync(OUTPUT_FILE, lines);
      }

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = elapsed > 0 ? (totalSaved / (elapsed / 60)).toFixed(1) : '0';

      console.log(
        `  [w${workerId}] ${businesses.length}→${newLeads.length} new, ${businesses.length - newLeads.length} dup` +
        ` | total: ${totalSaved} saved, ${totalDupes} dup` +
        ` | ${rate}/min | ${industry} ${city}`
      );
    } catch (err) {
      totalErrors++;
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = elapsed > 0 ? (totalSaved / (elapsed / 60)).toFixed(1) : '0';
      console.log(`  [w${workerId}] ERR: ${err.message.slice(0, 60)} | ${rate}/min | ${industry} ${city}`);
      // Rate limit hit — wait and retry
      if (err.message.includes('429')) {
        console.log('  Rate limited, waiting 5s...');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
}

// Initialize output file
if (!existsSync(OUTPUT_FILE)) {
  writeFileSync(OUTPUT_FILE, '');
}

async function main() {
  const NUM_WORKERS = 5;
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
  console.log(`  Queries run:     ${queryIndex}`);
  console.log(`  Leads found:     ${totalFound}`);
  console.log(`  Leads saved:     ${totalSaved}`);
  console.log(`  Duplicates:      ${totalDupes}`);
  console.log(`  Errors:          ${totalErrors}`);
  console.log(`  Time:            ${elapsed.toFixed(0)}s (${minutes.toFixed(1)} min)`);
  console.log(`  Rate:            ${rate} leads/minute`);
  console.log(`  Output:          ${OUTPUT_FILE}`);
  console.log('══════════════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
