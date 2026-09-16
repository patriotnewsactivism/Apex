import { readFileSync } from 'fs';

const env = readFileSync('.env', 'utf-8');
const password = env.match(/APEX_ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
if (!password) { process.exit(1); }

const API = 'https://apex.donmatthews.live';
const h = { 'Content-Type': 'application/json' };

// Login
const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: h,
  body: JSON.stringify({ password }),
});
const { token } = await login.json();
const auth = { ...h, Authorization: `Bearer ${token}` };

// Wait 90s for Railway deploy
console.log('Waiting 90s for Railway deploy of Cohere fix + updated_by fix...');
await new Promise((r) => setTimeout(r, 90_000));
console.log('Done waiting. Checking state...\n');

// 1. Clear old failed tasks
const tasksRes = await fetch(`${API}/api/tasks?limit=200`, { headers: auth });
const tasksData = await tasksRes.json();
const failed = (tasksData.tasks ?? []).filter((t) => ['failed', 'in_progress'].includes(t.status));
console.log(`Clearing ${failed.length} old failed/in-progress tasks...`);
await Promise.all(failed.map((t) =>
  fetch(`${API}/api/tasks/${t.id}`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ status: 'done', result: 'Cleared before re-test' }),
  }).catch(() => {})
));

// 2. Re-submit the sales goal (rephrased, website-focused)
const goal = {
  title: 'Sales Pitch: BuildMyBot.app for donmatthews.live',
  description: `## Sales Simulation — BuildMyBot.app Pitch

You are the Sales Director for BuildMyBot.app. A prospective client has been identified.

### Prospect Business Profile
- Business website: donmatthews.live
- Contact email: don@donmatthews.live
- Contact phone: 832-880-4970
- Business type: Independent journalism and publishing — public records research, court proceedings documentation, civic reporting for a nonfiction book

### Your Mission
1. Visit donmatthews.live using fetchUrl to understand what the business does, its services, and how it currently handles audience inquiries
2. Based on your research of the WEBSITE (not the person), craft a compelling, personalized sales pitch for BuildMyBot's AI chatbot and voice agent platform — show how it solves specific problems for a journalism/publishing business:
   - 24/7 lead capture for source outreach and audience engagement
   - Automated inquiry handling for reader questions and booking requests
   - After-hours coverage so no tip or lead goes unanswered
3. Write the full sales outreach email addressed to don@donmatthews.live — make it genuine and specific to the website's actual content
4. Write a cold call script for the phone outreach to 832-880-4970
5. Present both the email and the call script as your task output

### Guidelines
- Use BUSINESS_PROFILE.md at the repo root as ground truth for what BuildMyBot actually does
- Reference the WEBSITE's actual content, not assumptions about the person
- This is a live test of APEX's sales workforce capabilities — make it impressive
- Delegate to the Sales agent (apex-sales-001) via sendMessage to craft the outreach`,
  priority: 1,
};

const goalRes = await fetch(`${API}/api/goals`, {
  method: 'POST', headers: auth,
  body: JSON.stringify(goal),
});
const goalData = await goalRes.json();
console.log('Sales goal submitted:', JSON.stringify(goalData));

// 3. Wait 30s for CEO to pick it up and start working
console.log('\nWaiting 30s for CEO to process...');
await new Promise((r) => setTimeout(r, 30_000));

// 4. Check what happened
const logsRes = await fetch(`${API}/api/logs?limit=30`, { headers: auth });
const logsData = await logsRes.json();
console.log('\n=== RECENT LOGS ===');
for (const l of (logsData.logs ?? [])) {
  console.log(`[${l.timestamp}] [${l.agentId ?? 'system'}] ${l.level}: ${l.message?.slice(0, 200)}`);
}

// 5. Check tasks for the new goal
const newTasksRes = await fetch(`${API}/api/tasks?limit=20`, { headers: auth });
const newTasksData = await newTasksRes.json();
console.log('\n=== TASKS ===');
for (const t of (newTasksData.tasks ?? []).slice(0, 5)) {
  console.log(`\n${t.title}`);
  console.log(`  Agent: ${t.assignedAgentId} | Status: ${t.status}`);
  if (t.errorMessage) console.log(`  Error: ${t.errorMessage.slice(0, 300)}`);
  if (t.result) console.log(`  Result: ${t.result.slice(0, 300)}`);
}

// 6. Agent statuses
const agentsRes = await fetch(`${API}/api/agents`, { headers: auth });
const agentsData = await agentsRes.json();
console.log('\n=== AGENT STATUSES ===');
for (const a of (agentsData.agents ?? [])) {
  console.log(`  ${a.name}: ${a.liveStatus ?? a.status}`);
}
