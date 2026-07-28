import { readFileSync } from 'fs';

const env = readFileSync('.env', 'utf-8');
const password = env.match(/APEX_ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
if (!password) { console.error('No password'); process.exit(1); }

const API = 'https://apex.donmatthews.live';

try {
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const { token } = await loginRes.json();

  // Pull error logs specifically
  const logsRes = await fetch(`${API}/api/logs?limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const logsData = await logsRes.json();

  console.log('=== ERROR LOGS ===');
  for (const l of (logsData.logs ?? [])) {
    if (l.level === 'error' || l.level === 'warn') {
      console.log(`[${l.timestamp}] [${l.agentId ?? 'system'}] ${l.level}: ${l.message}`);
    }
  }

  // Check the specific task that failed
  const tasksRes = await fetch(`${API}/api/tasks?status=failed`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const tasksData = await tasksRes.json();

  console.log('\n=== FAILED TASKS ===');
  for (const t of (tasksData.tasks ?? [])) {
    console.log(`\nTask: ${t.title}`);
    console.log(`Agent: ${t.assignedAgentId}`);
    console.log(`Error: ${t.errorMessage ?? 'none'}`);
    console.log(`Result: ${(t.result ?? '').slice(0, 500)}`);
  }

  // Check the health endpoint for LLM provider status
  const healthRes = await fetch(`${API}/api/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const healthData = await healthRes.json();

  console.log('\n=== HEALTH ===');
  console.log(JSON.stringify(healthData, null, 2));
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : String(err));
}
