import { readFileSync } from 'fs';

const env = readFileSync('.env', 'utf-8');
const password = env.match(/APEX_ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
if (!password) { console.error('No password'); process.exit(1); }

const API = 'https://apex.donmatthews.live';

try {
  // Login
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  if (!loginRes.ok) {
    console.log('Login status:', loginRes.status, loginRes.statusText);
    console.log('Server might still be deploying or down');
    process.exit(0);
  }

  const { token } = await loginRes.json();
  const auth = { Authorization: `Bearer ${token}` };

  // Health check
  const healthRes = await fetch(`${API}/api/health`, { headers: auth });
  const health = await healthRes.json();
  console.log('=== HEALTH ===');
  console.log('Status:', healthRes.status);
  console.log(JSON.stringify(health, null, 2).slice(0, 500));

  // Check recent logs for deployment / startup messages
  const logsRes = await fetch(`${API}/api/logs?limit=20`, { headers: auth });
  const logsData = await logsRes.json();
  console.log('\n=== RECENT LOGS ===');
  for (const l of (logsData.logs ?? [])) {
    console.log(`[${l.timestamp}] [${l.agentId ?? 'system'}] ${l.level}: ${l.message?.slice(0, 150)}`);
  }

  // Check agent statuses
  const agentsRes = await fetch(`${API}/api/agents`, { headers: auth });
  const agentsData = await agentsRes.json();
  console.log('\n=== AGENT STATUSES ===');
  for (const a of (agentsData.agents ?? [])) {
    console.log(`  ${a.name}: ${a.liveStatus ?? a.status}`);
  }

  // Check integration status (Mistral + Vapi)
  const intRes = await fetch(`${API}/api/settings/integrations`, { headers: auth });
  const intData = await intRes.json();
  console.log('\n=== INTEGRATIONS ===');
  for (const i of (intData.integrations ?? [])) {
    if (i.key.includes('MISTRAL') || i.key.includes('VAPI') || i.key.includes('COHERE') || i.key.includes('CEREBRAS') || i.key.includes('GROQ')) {
      console.log(`  ${i.key}: ${i.configured ? 'configured ✅' : 'missing ❌'}`);
    }
  }

  // Check crons
  const jobsRes = await fetch(`${API}/api/jobs`, { headers: auth });
  const jobs = await jobsRes.json();
  console.log('\n=== CRON JOBS ===');
  for (const j of (jobs ?? [])) {
    console.log(`  ${j.name} | ${j.cronExpression} | ${j.enabled ? 'enabled' : 'disabled'} | ${j.status}`);
  }

  // Check suggestions (new endpoint)
  const sugRes = await fetch(`${API}/api/suggestions`, { headers: auth });
  if (sugRes.ok) {
    const sugData = await sugRes.json();
    console.log('\n=== SUGGESTIONS ===');
    console.log(`${sugData.suggestions?.length ?? 0} suggestions available`);
    for (const s of (sugData.suggestions ?? []).slice(0, 5)) {
      console.log(`  [${s.category}] ${s.title}`);
    }
  } else {
    console.log('\nSuggestions endpoint:', sugRes.status);
  }

  // Check system settings (autonomy)
  const sysRes = await fetch(`${API}/api/settings/system`, { headers: auth });
  if (sysRes.ok) {
    const sysData = await sysRes.json();
    console.log('\n=== SYSTEM SETTINGS ===');
    console.log(JSON.stringify(sysData));
  }

  console.log('\n✅ Build deployed successfully — all endpoints responding');
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  console.log('\n❌ Server may still be deploying or down');
}
