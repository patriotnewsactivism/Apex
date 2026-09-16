import { readFileSync } from 'fs';

// Read admin password from .env (never printed)
const env = readFileSync('.env', 'utf-8');
const password = env.match(/APEX_ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
if (!password) { console.error('No APEX_ADMIN_PASSWORD found in .env'); process.exit(1); }

const API = 'https://apex.donmatthews.live';

const goal = {
  title: 'Sales Outreach: Sell BuildMyBot.app to Don Matthews',
  description: `## Sales Simulation — BuildMyBot.app Pitch to Don Matthews

You are acting as the Sales Manager for BuildMyBot.app. Don Matthews is a prospective customer — treat him as a lead.

### Prospect Profile
- Name: Don Matthews
- Email: don@donmatthews.live
- Phone: 832-880-4970
- Business: donmatthews.live — journalist and author documenting public records, court proceedings, and civic matters for a nonfiction book
- He is also the founder of BuildMyBot.app (but for this exercise, treat him as an EXTERNAL prospect who has never heard of BuildMyBot)

### Your Mission
1. Research Don Matthews and his work at donmatthews.live — understand his business, pain points, and how he handles customer communication
2. Craft a compelling, personalized sales pitch for BuildMyBot's AI chatbot & voice agent platform — show him SPECIFICALLY how it solves his problems (missed calls, after-hours inquiries, lead capture for his journalism/booking business)
3. Write the full sales outreach email as if you were sending it to don@donmatthews.live
4. Write a cold call script for the phone outreach to 832-880-4970
5. Present your pitch and outreach materials as your task output

### Guidelines
- Be genuine, not spammy. Reference his ACTUAL work.
- Use BUSINESS_PROFILE.md as ground truth for what BuildMyBot actually does — don't overpromise.
- This is a live test of APEX's ability to act as a sales workforce. Make it impressive.
- Delegate to the Sales agent (apex-sales-001) to craft the outreach. Use dispatchSwarm if you want parallel pitches from different angles.`,
  priority: 1,
};

try {
  // Step 1: Login to get a valid token
  console.log('Logging in to live APEX...');
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  if (!loginRes.ok) {
    const err = await loginRes.json().catch(() => ({ error: loginRes.statusText }));
    console.error('Login failed:', loginRes.status, err.error);
    process.exit(1);
  }

  const { token } = await loginRes.json();
  console.log('Login successful, submitting goal...');

  // Step 2: Submit the sales goal
  const res = await fetch(`${API}/api/goals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(goal),
  });

  const data = await res.json();
  console.log('Status:', res.status);
  console.log('Response:', JSON.stringify(data, null, 2));
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : String(err));
}
