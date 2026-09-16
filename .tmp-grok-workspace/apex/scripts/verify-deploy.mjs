import { readFileSync } from 'fs';

const env = readFileSync('.env', 'utf-8');
const password = env.match(/APEX_ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
const API = 'https://apex.donmatthews.live';

console.log('Waiting 120s for Railway build + deploy...');
await new Promise((r) => setTimeout(r, 120_000));
console.log('Checking...\n');

// Login
const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password }),
});
if (!login.ok) {
  console.log('Server not responding — build may still be in progress or failed');
  process.exit(0);
}
const { token } = await login.json();
const auth = { Authorization: `Bearer ${token}` };

// Test all new endpoints
const tests = [
  ['GET', '/api/suggestions', 'Suggestions'],
  ['GET', '/api/settings/system', 'System Settings (autonomy)'],
  ['GET', '/api/jobs', 'Jobs list'],
  ['GET', '/api/agents', 'Agents list'],
  ['GET', '/api/learning/recommendations', 'Learning recommendations'],
];

console.log('=== ENDPOINT STATUS ===');
for (const [method, path, label] of tests) {
  const res = await fetch(`${API}${path}`, { method, headers: auth });
  const ok = res.ok ? '✅' : '❌';
  console.log(`  ${ok} ${method} ${path} → ${res.status}  ${label}`);
  
  // Show suggestions content if available
  if (path === '/api/suggestions' && res.ok) {
    const data = await res.json();
    console.log(`     ${data.suggestions?.length ?? 0} suggestions found`);
    for (const s of (data.suggestions ?? []).slice(0, 3)) {
      console.log(`     - [${s.category}] ${s.title}`);
    }
  }
  
  // Show system settings if available
  if (path === '/api/settings/system' && res.ok) {
    const data = await res.json();
    console.log(`     Autonomy: ${data.settings?.autonomy_level ?? 'unknown'}`);
  }
}

// Check seeded crons
const jobsRes = await fetch(`${API}/api/jobs`, { headers: auth });
const jobs = await jobsRes.json();
const leadSweep = jobs.find((j) => j.id === 'system-lead-gen-sweep');
const dailyReport = jobs.find((j) => j.id === 'system-daily-report');
console.log('\n=== SEEDED CRONS ===');
console.log(`  system-lead-gen-sweep: ${leadSweep ? '✅ ' + leadSweep.cronExpression : '❌ missing'}`);
console.log(`  system-daily-report: ${dailyReport ? '✅ ' + dailyReport.cronExpression : '❌ missing'}`);
