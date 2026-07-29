import { readFileSync } from 'fs';
const env = readFileSync('.env', 'utf-8');
const password = env.match(/APEX_ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
const API = 'https://apex.donmatthews.live';
const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password }),
});
if (!login.ok) { console.log('Server down — build in progress'); process.exit(0); }
const { token } = await login.json();
const auth = { Authorization: `Bearer ${token}` };

// Quick endpoint check
for (const [method, path, label] of [
  ['GET', '/api/suggestions', 'Suggestions'],
  ['GET', '/api/settings/system', 'Autonomy'],
  ['GET', '/api/jobs', 'Jobs'],
]) {
  const res = await fetch(`${API}${path}`, { method, headers: auth });
  const ok = res.ok ? '✅' : '❌';
  let extra = '';
  if (res.ok && path === '/api/suggestions') {
    const d = await res.json();
    extra = ` (${d.suggestions?.length ?? 0} suggestions)`;
  }
  if (res.ok && path === '/api/settings/system') {
    const d = await res.json();
    extra = ` (autonomy: ${d.settings?.autonomy_level ?? '?'})`;
  }
  console.log(`${ok} ${method} ${path} → ${res.status}${extra}  ${label}`);
}

// Check crons
const jobsRes = await fetch(`${API}/api/jobs`, { headers: auth });
const jobs = await jobsRes.json();
const ids = jobs.map((j) => j.id);
console.log(`\nCron IDs: ${ids.join(', ')}`);
console.log(`lead-gen-sweep: ${ids.includes('system-lead-gen-sweep') ? '✅' : '❌'}`);
console.log(`daily-report: ${ids.includes('system-daily-report') ? '✅' : '❌'}`);
