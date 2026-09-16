import { readFileSync } from 'fs';

const env = readFileSync('.env', 'utf-8');
const password = env.match(/APEX_ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
if (!password) { console.error('No APEX_ADMIN_PASSWORD found in .env'); process.exit(1); }

const API = 'https://apex.donmatthews.live';
const GOAL_ID = '4fdbb22f-5597-4904-b7a3-56a312cf502f';

try {
  // Login
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!loginRes.ok) { console.error('Login failed:', loginRes.status); process.exit(1); }
  const { token } = await loginRes.json();

  // Check the goal status
  const goalRes = await fetch(`${API}/api/goals/${GOAL_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const goalData = await goalRes.json();
  console.log('=== GOAL ===');
  console.log(JSON.stringify(goalData, null, 2));

  // Check tasks for this goal
  const tasksRes = await fetch(`${API}/api/tasks?goalId=${GOAL_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const tasksData = await tasksRes.json();
  console.log('\n=== TASKS ===');
  console.log(JSON.stringify(tasksData, null, 2));

  // Check recent logs
  const logsRes = await fetch(`${API}/api/logs?limit=30`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const logsData = await logsRes.json();
  console.log('\n=== RECENT LOGS (last 30) ===');
  for (const l of (logsData.logs ?? [])) {
    console.log(`[${l.timestamp}] [${l.agentId ?? 'system'}] ${l.level}: ${l.message?.slice(0, 200)}`);
  }

  // Check agent statuses
  const agentsRes = await fetch(`${API}/api/agents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const agentsData = await agentsRes.json();
  console.log('\n=== AGENT STATUSES ===');
  for (const a of (agentsData.agents ?? [])) {
    console.log(`${a.id} (${a.name}): ${a.liveStatus ?? a.status}`);
  }
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : String(err));
}
