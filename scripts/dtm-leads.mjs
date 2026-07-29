import { readFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf8');
const PASSWORD = envContent.match(/^APEX_ADMIN_PASSWORD=(.+)$/m)?.[1]?.trim();
const BASE = 'https://apex.donmatthews.live';

const queries = [
  'home builder Porter TX',
  'construction company Houston TX',
  'home improvement Houston TX',
  'roofing contractor Houston TX',
  'remodeling contractor Houston TX',
  'custom home builder Houston TX',
  'general contractor Houston TX',
  'real estate developer Houston TX',
  'plumbing contractor Houston TX',
  'electrician Houston TX',
  'landscaping service Porter TX',
  'cleaning service Houston TX',
  'real estate agency Houston TX',
  'insurance agent Houston TX',
  'mortgage broker Houston TX',
];

const r = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
  signal: AbortSignal.timeout(15000),
});
const { token } = await r.json();
console.log('Auth OK — 1 worker, 15 queries, Porter TX + Houston TX\n');

let totalSaved = 0;
let totalDupes = 0;

for (const query of queries) {
  try {
    const searchRes = await fetch(`${BASE}/api/tools/searchBusinessDirectory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(60000),
    });

    if (!searchRes.ok) {
      console.log(`  ERR ${searchRes.status} | ${query}`);
      continue;
    }

    const searchData = await searchRes.json();
    const businesses = searchData.data?.businesses || searchData.businesses || [];

    if (businesses.length === 0) {
      console.log(`  0 found | ${query}`);
      continue;
    }

    const industry = query.replace(/\s+(Porter|Houston)\s+TX$/, '');
    const leads = businesses.filter(b => b.n).map(b => ({
      companyName: b.n.trim(),
      website: b.w || undefined,
      industry,
      city: b.c || 'Houston',
      fitReason: `${industry} in Porter/Houston TX area — potential DTM Builders lead (referral partner, client, or complementary service)`,
      outreachAngle: 'DTM Builders referral or partnership opportunity',
    }));

    const saveRes = await fetch(`${BASE}/api/tools/saveResearchedLeadsBatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ leads }),
      signal: AbortSignal.timeout(60000),
    });

    const saveData = await saveRes.json();
    const sd = saveData.data || saveData;
    const saved = sd.saved || 0;
    const dupes = sd.duplicates || 0;
    totalSaved += saved;
    totalDupes += dupes;

    console.log(`  ${businesses.length}→${saved} saved, ${dupes} dup | total: ${totalSaved} | ${query}`);
  } catch (err) {
    console.log(`  ERR ${err.message.slice(0, 60)} | ${query}`);
  }
}

console.log(`\nDone: ${totalSaved} new leads saved, ${totalDupes} duplicates for Porter/Houston TX`);
