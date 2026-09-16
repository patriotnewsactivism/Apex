/**
 * Answers ONE question: why did agents stop working?
 *
 * Run this when the dashboard shows agents stuck in ERROR and nothing is
 * getting done. It reads the live service and prints the actual evidence —
 * the real error text, which provider chain failed, whether tasks are even
 * being created — instead of leaving you to guess from status dots.
 *
 * Read-only. It changes nothing.
 *
 *   node scripts/triage-stalled-agents.mjs
 *
 * Requires a local .env with APEX_ADMIN_PASSWORD (same as the other scripts
 * in this directory). Override the target with APEX_URL=... if needed.
 */
import { readFileSync } from 'fs';

const API = process.env.APEX_URL ?? 'https://apex.donmatthews.live';

let password = process.env.APEX_ADMIN_PASSWORD;
if (!password) {
  try {
    password = readFileSync('.env', 'utf-8').match(/APEX_ADMIN_PASSWORD=(.+)/)?.[1]?.trim();
  } catch {
    /* no .env — fall through to the error below */
  }
}
if (!password) {
  console.error('No APEX_ADMIN_PASSWORD (checked env var and .env). Cannot authenticate.');
  process.exit(1);
}

const loginRes = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password }),
});
if (!loginRes.ok) {
  console.error(`Login failed: HTTP ${loginRes.status}. Wrong password, or the service is redeploying.`);
  process.exit(1);
}
const { token } = await loginRes.json();
const auth = { Authorization: `Bearer ${token}` };
const get = async (path) => {
  const res = await fetch(`${API}${path}`, { headers: auth });
  if (!res.ok) return { __error: `HTTP ${res.status}` };
  return res.json();
};

const line = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

// ── 1. Who is broken, and how long have they been broken? ─────────────────
line('1. AGENT STATUS');
const agentsData = await get('/api/agents');
const agents = Array.isArray(agentsData) ? agentsData : (agentsData.agents ?? []);
const errored = [];
for (const a of agents) {
  const status = a.liveStatus ?? a.status;
  const since = a.lastActiveAt ? `last active ${new Date(a.lastActiveAt).toISOString()}` : 'never active';
  if (status === 'error') errored.push(a);
  console.log(`  ${status === 'error' ? '❌' : status === 'idle' ? '·' : '▶'} ${(a.role ?? '?').padEnd(18)} ${String(status).padEnd(9)} ${since}`);
}
console.log(`\n  ${errored.length} of ${agents.length} agents in error.`);

// ── 2. The actual error text — the thing status dots don't tell you ───────
line('2. WHY THEY FAILED (recent error logs)');
const logsData = await get('/api/logs?limit=200');
const logs = (Array.isArray(logsData) ? logsData : (logsData.logs ?? [])).filter((l) => l.level === 'error');
if (logs.length === 0) {
  console.log('  No error-level logs returned. If agents show error but no errors are');
  console.log('  logged, the failure predates the log retention window (MaintenanceJob');
  console.log('  prunes debug/info after 7d) — check failed tasks in section 3 instead.');
} else {
  // Cluster identical root causes so one repeated failure reads as one line.
  const clusters = new Map();
  for (const l of logs) {
    const sig = (l.message ?? '')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      .replace(/\d+/g, '<n>')
      .slice(0, 150);
    const key = `${l.agentId ?? 'system'}::${sig}`;
    const e = clusters.get(key) ?? { agent: l.agentId ?? 'system', sig, count: 0, sample: l.message, last: l.timestamp };
    e.count++;
    if (l.timestamp > e.last) e.last = l.timestamp;
    clusters.set(key, e);
  }
  for (const c of [...clusters.values()].sort((a, b) => b.count - a.count).slice(0, 12)) {
    console.log(`\n  ${c.count}×  [${c.agent}]  (last: ${c.last})`);
    console.log(`      ${(c.sample ?? '').slice(0, 400)}`);
  }
}

// ── 3. Failed tasks — the durable record, survives log pruning ────────────
line('3. RECENTLY FAILED TASKS');
const tasksData = await get('/api/tasks?limit=200');
const allTasks = Array.isArray(tasksData) ? tasksData : (tasksData.tasks ?? []);
const failed = allTasks.filter((t) => t.status === 'failed');
const open = allTasks.filter((t) => ['pending', 'in_progress', 'blocked', 'awaiting_approval'].includes(t.status));
console.log(`  ${failed.length} failed / ${open.length} still open / ${allTasks.length} total in window`);
for (const t of failed.slice(0, 10)) {
  console.log(`\n  ❌ ${t.title}`);
  console.log(`     agent=${t.assignedAgentId} retries=${t.retryCount}/${t.maxRetries}`);
  console.log(`     ${(t.errorMessage ?? '(no error recorded)').slice(0, 300)}`);
}

// ── 4. Is the LLM chain the cause? This is the usual answer. ──────────────
line('4. LLM PROVIDER CHAIN');
const llmSignals = [...logs, ...failed.map((t) => ({ message: t.errorMessage }))]
  .map((x) => x.message ?? '')
  .filter((m) => /All LLM providers failed|rate limit|quota|insufficient credits|429|402|401/i.test(m));
if (llmSignals.length > 0) {
  console.log(`  ⚠️  ${llmSignals.length} message(s) indicate LLM provider exhaustion.`);
  console.log('     This is the most common cause of a whole workforce going quiet:');
  console.log('     every provider in the chain 429/402/401s, every task fails, and');
  console.log('     task-queue.ts deliberately does NOT retry (isCapacityExhaustion),');
  console.log('     so agents settle into error and stay there until capacity returns.');
  console.log('\n     Fix = restore provider capacity (top up / rotate keys / add a');
  console.log('     working provider in Settings), not a code change.');
  console.log(`\n     Sample: ${llmSignals[0].slice(0, 300)}`);
} else {
  console.log('  No provider-exhaustion signature found. The failures are something');
  console.log('  else — read the error text in sections 2 and 3.');
}

// ── 5. Are the autonomous crons actually firing? ──────────────────────────
line('5. SCHEDULED JOBS (is anything originating work?)');
// /api/jobs returns a BARE ARRAY, not {jobs:[...]}. Several routes in this
// API differ on that; normalize rather than assume.
const jobsData = await get('/api/jobs');
const jobList = Array.isArray(jobsData) ? jobsData : (jobsData.jobs ?? []);
if (jobList.length === 0) console.log('  (no scheduled jobs returned)');
for (const j of jobList) {
  const flag = !j.enabled ? '⏸ disabled' : j.status === 'failed' ? '❌ failed' : '✅';
  console.log(`  ${flag}  ${(j.jobType ?? '').padEnd(22)} ${(j.cronExpression ?? '').padEnd(14)} last=${j.lastRunAt ?? 'never'} next=${j.nextRunAt ?? '?'}`);
  if (j.error) console.log(`         error: ${String(j.error).slice(0, 200)}`);
}
console.log('\n  A job with last=never has NOT run since it was seeded. If the newer');
console.log('  autonomy jobs (delegation_followup, goal_progress, failure_review,');
console.log('  branch_review) all show last=never, they cannot be the cause of');
console.log('  anything that broke before their first run.');

line('DONE');
