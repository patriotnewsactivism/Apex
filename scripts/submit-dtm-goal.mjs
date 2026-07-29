import { readFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf8');
const PASSWORD = envContent.match(/^APEX_ADMIN_PASSWORD=(.+)$/m)?.[1]?.trim();
const BASE = 'https://apex.donmatthews.live';

const r = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
  signal: AbortSignal.timeout(60000),
});
const { token } = await r.json();
console.log('Auth OK');

const goal = {
  title: 'Find immediate leads for DTM Builders — Porter TX & Houston TX',
  description: `Research and find immediate sales leads for Dan at DTM Builders (https://dtm-builders.vercel.app/). DTM Builders is a construction/home building company. 

Target area: Porter, TX and Houston, TX metro area.

Use searchBusinessDirectory to find:
- Home builders and contractors in Porter TX and Houston TX
- Construction companies in the Greater Houston area
- Home improvement services (roofing, remodeling, additions, custom builds)
- Real estate developers and agents who might refer clients

Save ALL qualifying leads using saveResearchedLeadsBatch. Target 50+ leads. Dedup by website.

For each lead, note why they would be a good fit for DTM Builders (referral partner, potential client, complementary service provider, etc.).`,
  priority: 9,
};

const res = await fetch(`${BASE}/api/goals`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify(goal),
  signal: AbortSignal.timeout(60000),
});

if (res.ok) {
  const data = await res.json();
  console.log('Goal submitted:', data.goalId ? 'OK (' + data.goalId.slice(0, 8) + ')' : 'FAILED');
  console.log('Message:', data.message);
} else {
  console.log('Failed:', res.status);
  const text = await res.text().catch(() => '');
  console.log('Error:', text.slice(0, 300));
}
