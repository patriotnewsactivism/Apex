import { readFileSync } from 'fs';
const env = readFileSync('.env', 'utf-8');
const password = env.match(/APEX_ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
const API = 'https://apex.donmatthews.live';
const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password }),
});
const { token } = await login.json();
const auth = { Authorization: `Bearer ${token}` };

// Test each NEW endpoint to see which are deployed
const tests = [
  ['GET', '/api/suggestions', 'Suggestions list'],
  ['GET', '/api/settings/system', 'System settings (autonomy)'],
  ['PATCH', '/api/jobs/test', 'Jobs PATCH (edit cron)'],
  ['POST', '/api/vapi/webhook', 'Vapi webhook (no auth)'],
  ['GET', '/api/learning/recommendations', 'Learning recommendations (existing)'],
];

console.log('=== ENDPOINT AVAILABILITY ===');
for (const [method, path, label] of tests) {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: method === 'POST' && path.includes('vapi') ? {} : auth,
    });
    console.log(`${method} ${path} → ${res.status}  ${label}`);
  } catch (e) {
    console.log(`${method} ${path} → ERROR  ${label}`);
  }
}

// Also check what the server identifies as (look for build-specific features)
const jobsRes = await fetch(`${API}/api/jobs`, { headers: auth });
const jobs = await jobsRes.json();
const hasLeadGenSweep = jobs.some((j) => j.id === 'system-lead-gen-sweep');
const hasDailyReport = jobs.some((j) => j.id === 'system-daily-report');
const hasDailyMaintenance = jobs.some((j) => j.id === 'system-daily-maintenance');
console.log(`\n=== SEEDED CRONS (from latest code) ===`);
console.log(`system-lead-gen-sweep: ${hasLeadGenSweep ? 'EXISTS ✅' : 'MISSING ❌'}`);
console.log(`system-daily-report: ${hasDailyReport ? 'EXISTS ✅' : 'MISSING ❌'}`);
console.log(`system-daily-maintenance: ${hasDailyMaintenance ? 'EXISTS ✅' : 'MISSING ❌'}`);
