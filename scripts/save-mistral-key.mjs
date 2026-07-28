import { readFileSync, unlinkSync } from 'fs';
import { readFileSync as read } from 'fs';

const env = read('.env', 'utf-8');
const password = env.match(/APEX_ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
if (!password) { console.error('No password'); process.exit(1); }

// Read the Mistral key from temp file (never printed/echoed)
const mistralKey = read('.tmp-mistral-key', 'utf-8').trim();
if (!mistralKey) { console.error('No key found in temp file'); process.exit(1); }

const API = 'https://apex.donmatthews.live';

try {
  // Login
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const { token } = await loginRes.json();

  // Save the Mistral key via Settings API
  const saveRes = await fetch(`${API}/api/settings/integrations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ key: 'MISTRAL_API_KEY', value: mistralKey }),
  });

  const result = await saveRes.json();
  console.log('Status:', saveRes.status);
  console.log('MISTRAL_API_KEY configured:', result.configured ?? result.ok ?? false);

  // Quick test — trigger a learning analysis to see if Mistral responds
  console.log('\nTesting Mistral provider...');
  const testRes = await fetch(`${API}/api/learning/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  if (testRes.ok) {
    const testData = await testRes.json();
    console.log('Learning analysis triggered:', JSON.stringify(testData).slice(0, 200));
  }
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : String(err));
}

// Clean up temp file
try { unlinkSync('.tmp-mistral-key'); } catch {}
