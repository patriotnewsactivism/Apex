import { readFileSync } from 'fs';

const env = readFileSync('.env', 'utf-8');
const password = env.match(/APEX_ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
if (!password) { process.exit(1); }

const API = 'https://apex.donmatthews.live';
const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password }),
});
const { token } = await login.json();
const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

// Check recent logs for Mistral mentions or successful LLM calls
const logsRes = await fetch(`${API}/api/logs?limit=50`, { headers: auth });
const logsData = await logsRes.json();
console.log('=== RECENT LOGS ===');
for (const l of (logsData.logs ?? [])) {
  console.log(`[${l.timestamp}] [${l.agentId ?? 'system'}] ${l.level}: ${l.message?.slice(0, 200)}`);
}

// Check agent statuses
const agentsRes = await fetch(`${API}/api/agents`, { headers: auth });
const agentsData = await agentsRes.json();
console.log('\n=== AGENT STATUSES ===');
for (const a of (agentsData.agents ?? [])) {
  console.log(`  ${a.name}: ${a.liveStatus ?? a.status}`);
}

// Check integration status
const intRes = await fetch(`${API}/api/settings/integrations`, { headers: auth });
const intData = await intRes.json();
console.log('\n=== INTEGRATIONS ===');
for (const i of (intData.integrations ?? [])) {
  console.log(`  ${i.key}: ${i.configured ? 'configured ✅' : 'missing ❌'}`);
}
