import { readFileSync, unlinkSync } from 'fs';

const env = readFileSync('.env', 'utf-8');
const password = env.match(/APEX_ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
if (!password) { console.error('No password'); process.exit(1); }

const mistralKey = readFileSync('.tmp-mistral-key', 'utf-8').trim();
if (!mistralKey) { console.error('No key found'); process.exit(1); }

const API = 'https://apex.donmatthews.live';

// Wait 75s for Railway to deploy the fix
console.log('Waiting 75s for Railway deploy...');
await new Promise((r) => setTimeout(r, 75_000));

try {
  // Login
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const { token } = await loginRes.json();
  console.log('Logged in.');

  // Save the Mistral key
  const saveRes = await fetch(`${API}/api/settings/integrations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ key: 'MISTRAL_API_KEY', value: mistralKey }),
  });

  const result = await saveRes.json();
  console.log('Save status:', saveRes.status);
  console.log('MISTRAL_API_KEY configured:', result.configured ?? result.ok ?? false);
  if (result.error) console.log('Error:', result.error);

  // Check integration status
  const intRes = await fetch(`${API}/api/settings/integrations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const intData = await intRes.json();
  const mistral = intData.integrations?.find((i) => i.key === 'MISTRAL_API_KEY');
  console.log('\nMistral integration status:', mistral);
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : String(err));
}

// Clean up temp file
try { unlinkSync('.tmp-mistral-key'); } catch {}
