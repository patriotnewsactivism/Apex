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

// Check health for server uptime info
const healthRes = await fetch(`${API}/api/health`, { headers: auth });
const health = await healthRes.json();
console.log('=== HEALTH ===');
console.log(JSON.stringify(health, null, 2).slice(0, 800));

// Check the earliest logs (startup messages)
const logsRes = await fetch(`${API}/api/logs?limit=50`, { headers: auth });
const logsData = await logsRes.json();
const logs = logsData.logs ?? [];
console.log('\n=== EARLIEST LOGS (startup) ===');
// Show the first few logs which would be from server startup
for (const l of logs.slice(-5)) {
  console.log(`[${l.timestamp}] [${l.agentId ?? 'system'}] ${l.level}: ${l.message?.slice(0, 150)}`);
}
console.log(`\nTotal logs: ${logs.length}`);

// Check if the server has the PATCH /api/jobs/:id endpoint (test with a HEAD request)
const jobsRes = await fetch(`${API}/api/jobs`, { 
  headers: auth,
  method: 'PATCH',
  body: JSON.stringify({}),
});
console.log(`\nPATCH /api/jobs (should be 404 if old build, 400 if new build): ${jobsRes.status}`);
