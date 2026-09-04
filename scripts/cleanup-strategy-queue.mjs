#!/usr/bin/env node

const execute = process.argv.includes('--execute');
const token = process.env.APEX_ADMIN_TOKEN;
const origin = (process.env.APEX_URL ?? 'https://apex.donmatthews.live').replace(/\/$/, '');

if (!token) {
  console.error('APEX_ADMIN_TOKEN is required; the credential is never accepted as a command argument.');
  process.exit(1);
}

const response = await fetch(`${origin}/api/learning/recommendations/cleanup`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ execute, confirm: execute ? 'CLEAN_DUPLICATE_STRATEGIES' : undefined }),
});
const body = await response.json();
if (!response.ok) {
  console.error(`Cleanup request failed (${response.status}):`, body);
  process.exit(1);
}

console.log(JSON.stringify(body, null, 2));
if (!execute) console.log('\nDry run only. Review the totals, then rerun with --execute.');
