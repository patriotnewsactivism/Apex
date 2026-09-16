import { readFileSync } from 'fs';
const env = readFileSync('.env', 'utf-8');
const password = env.match(/APEX_ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
const API = 'https://apex.donmatthews.live';
const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password }),
});
const { token } = await login.json();

// Get the sales task result
const tasksRes = await fetch(`${API}/api/tasks?limit=5`, {
  headers: { Authorization: `Bearer ${token}` },
});
const tasksData = await tasksRes.json();
const salesTask = (tasksData.tasks ?? []).find((t) => t.title.includes('Sales Pitch for BuildMyBot'));
if (salesTask) {
  console.log('=== SALES PITCH RESULT ===\n');
  console.log(salesTask.result);
} else {
  console.log('Sales task not found. Recent tasks:');
  for (const t of (tasksData.tasks ?? [])) {
    console.log(`  ${t.title} — ${t.status}`);
  }
}
