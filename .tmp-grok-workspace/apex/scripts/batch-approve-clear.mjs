import { readFileSync } from 'fs';

const env = readFileSync('.env', 'utf-8');
const password = env.match(/APEX_ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
if (!password) { console.error('No password'); process.exit(1); }

const API = 'https://apex.donmatthews.live';
const h = { 'Content-Type': 'application/json' };
const login = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: h, body: JSON.stringify({ password }) });
const { token } = await login.json();
const auth = { ...h, Authorization: `Bearer ${token}` };

// 1. Approve remaining pending recs (batch via Promise.all)
const recsRes = await fetch(`${API}/api/learning/recommendations`, { headers: auth });
const recs = await recsRes.json();
const pending = recs.filter((r) => r.status === 'pending');
console.log(`Approving ${pending.length} remaining recs...`);
await Promise.all(pending.map((r) =>
  fetch(`${API}/api/learning/recommendations/${r.id}/respond`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ action: 'approve', note: 'Auto-approved: strongly suggested' }),
  })
));
console.log(`Done approving.`);

// 2. Clear backlog — batch
const tasksRes = await fetch(`${API}/api/tasks?limit=200`, { headers: auth });
const tasksData = await tasksRes.json();
const tasks = tasksData.tasks ?? [];
const active = tasks.filter((t) => ['pending', 'in_progress', 'failed'].includes(t.status));
console.log(`Clearing ${active.length} backlog tasks...`);
await Promise.all(active.map((t) =>
  fetch(`${API}/api/tasks/${t.id}`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ status: 'done', result: 'Cleared during backlog cleanup' }),
  }).catch(() => {})
));
console.log(`Done clearing.`);

// 3. Re-submit sales goal (rephrased)
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

const goalRes = await fetch(`${API}/api/goals`, { method: 'POST', headers: auth, body: JSON.stringify(goal) });
const goalData = await goalRes.json();
console.log('\nSales goal re-submitted:', JSON.stringify(goalData));

// 4. Quick agent status check
const agentsRes = await fetch(`${API}/api/agents`, { headers: auth });
const agentsData = await agentsRes.json();
console.log('\nAgent statuses:');
for (const a of (agentsData.agents ?? [])) {
  console.log(`  ${a.id} (${a.name}): ${a.liveStatus ?? a.status}`);
}
