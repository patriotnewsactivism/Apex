import { readFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf8');
const m = envContent.match(/^APEX_ADMIN_PASSWORD=(.+)$/m);
const PASSWORD = m[1].trim();
const BASE = 'https://apex.donmatthews.live';

const goals = [
  {
    title: 'Lead Blitz: Home Services sweep',
    description: 'Run an aggressive lead research session targeting home service businesses (HVAC, plumbing, electrical, roofing, landscaping, cleaning) across all major US cities. Use searchBusinessDirectory with different city/industry combinations. Save ALL qualifying leads in batches of 20+ using saveResearchedLeadsBatch. Target 500+ new leads this session. Dedup by website.',
    priority: 9,
  },
  {
    title: 'Lead Blitz: Professional Services sweep',
    description: 'Run an aggressive lead research session targeting professional service businesses (lawyers, accountants, financial advisors, insurance agents, mortgage brokers, real estate) across all major US cities. Use searchBusinessDirectory with different city/industry combinations. Save ALL qualifying leads in batches using saveResearchedLeadsBatch. Target 500+ new leads.',
    priority: 9,
  },
  {
    title: 'Lead Blitz: Health & Beauty sweep',
    description: 'Run an aggressive lead research session targeting health and beauty businesses (dental practices, veterinary clinics, beauty salons, fitness studios, med spas, chiropractors) across all major US cities. Use searchBusinessDirectory then saveResearchedLeadsBatch for each batch. Target 500+ new leads.',
    priority: 9,
  },
];

const r = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
  signal: AbortSignal.timeout(15000),
});
const { token } = await r.json();

for (const g of goals) {
  const res = await fetch(`${BASE}/api/goals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(g),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  console.log(`Goal submitted: ${g.title.slice(0, 50)} → ${data.goalId ? 'OK (' + data.goalId.slice(0, 8) + ')' : 'FAILED'}`);
}
