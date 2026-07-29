import { readFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf8');
const m = envContent.match(/^APEX_ADMIN_PASSWORD=(.+)$/m);
const PASSWORD = m[1].trim();
const BASE = 'https://apex.donmatthews.live';

const r = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
  signal: AbortSignal.timeout(15000),
});
const { token } = await r.json();
console.log('Auth OK');

const s = await fetch(`${BASE}/api/tools/searchBusinessDirectory`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ query: 'HVAC contractor Dallas Texas' }),
  signal: AbortSignal.timeout(30000),
});
console.log('Search status:', s.status);
const d = await s.json();
console.log('Full response:', JSON.stringify(d).slice(0, 1000));
