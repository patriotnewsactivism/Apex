/**
 * Non-destructive source/runtime contract checks for the expanded portfolio workforce.
 *
 * Usage:
 *   pnpm verify:portfolio-workforce
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  EXISTING_AGENT_ALIASES,
  PORTFOLIO_AGENT_DEFINITIONS,
} from '../packages/agents/src/portfolio-workforce.js';
import { getToolRegistry } from '../packages/core/src/tool-registry.js';
import { CronParser } from '../packages/background-jobs/src/cron-parser.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  console.log(condition ? `  ✅ ${label}` : `  ❌ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!condition) failures++;
}

const all = [
  ...EXISTING_AGENT_ALIASES.map((agent) => ({ ...agent, tools: [] as string[], skills: [] as string[], activationMode: 'stable' })),
  ...PORTFOLIO_AGENT_DEFINITIONS,
];

console.log('── Workforce roster ──');
check('217 new specialists are registered', PORTFOLIO_AGENT_DEFINITIONS.length === 217, PORTFOLIO_AGENT_DEFINITIONS.length);
check('13 stable APEX IDs are reused', EXISTING_AGENT_ALIASES.length === 13, EXISTING_AGENT_ALIASES.length);
check('230 total registered roles', all.length === 230, all.length);

const ids = all.map((agent) => agent.id);
check('agent IDs are unique', new Set(ids).size === ids.length);

const searchable = all.map((agent) => `${agent.id} ${agent.name} ${agent.role}`.toLowerCase());
check('AEGIS is excluded from the active roster', searchable.every((value) => !value.includes('aegis')));

const aliasById = new Map(EXISTING_AGENT_ALIASES.map((agent) => [agent.id, agent.name]));
for (const [id, name] of [
  ['apex-ceo-001', 'Atlas'],
  ['apex-lead-dev-001', 'Forge'],
  ['apex-cto-001', 'Architect'],
  ['apex-devops-001', 'Sentinel'],
  ['apex-marketing-001', 'Madison'],
] as const) {
  check(`${name} reuses stable ID ${id}`, aliasById.get(id) === name, aliasById.get(id));
}

const requiredNewIds = [
  'apex-publisher-001',
  'apex-newsroom-editor-001',
  'apex-blackstone-001',
  'apex-revenue-chief-001',
  'apex-producer-001',
  'apex-video-chief-001',
  'apex-webmaster-001',
  'apex-apex-commander-001',
  'apex-mission-control-001',
  'apex-bmb-commander-001',
  'apex-portfolio-commander-001',
  'apex-breakers-001',
  'apex-news-scout-001',
  'apex-factcheck-001',
];
for (const id of requiredNewIds) {
  check(`required specialist exists: ${id}`, PORTFOLIO_AGENT_DEFINITIONS.some((agent) => agent.id === id));
}

const standing = PORTFOLIO_AGENT_DEFINITIONS.filter((agent) => agent.activationMode === 'standing');
check('new standing specialist count stays bounded (<= 20)', standing.length <= 20, standing.length);

console.log('\n── Tool allowlists ──');
const registry = getToolRegistry(process.cwd());
const missingTools: Array<{ agentId: string; tool: string }> = [];
for (const agent of PORTFOLIO_AGENT_DEFINITIONS) {
  for (const tool of agent.tools) {
    if (!registry.get(tool)) missingTools.push({ agentId: agent.id, tool });
  }
}
check('every specialist tool name exists in the real registry', missingTools.length === 0, missingTools.slice(0, 20));

console.log('\n── Video provenance ──');
for (const id of ['apex-source-producer-001', 'apex-source-archivist-001']) {
  const agent = PORTFOLIO_AGENT_DEFINITIONS.find((candidate) => candidate.id === id);
  check(`${id} exists`, Boolean(agent));
  check(`${id} carries video-provenance skill`, Boolean(agent?.skills.includes('video-provenance')), agent?.skills);
}

console.log('\n── Central-time cron behavior ──');
const summer = CronParser.nextRun('0 7 * * *', new Date('2026-09-22T11:59:00.000Z'), 'America/Chicago');
check('07:00 CDT resolves to 12:00Z', summer?.toISOString() === '2026-09-22T12:00:00.000Z', summer?.toISOString());
const winter = CronParser.nextRun('0 7 * * *', new Date('2026-11-02T12:59:00.000Z'), 'America/Chicago');
check('07:00 CST resolves to 13:00Z after DST ends', winter?.toISOString() === '2026-11-02T13:00:00.000Z', winter?.toISOString());

console.log('\n── Seeded operating cadence ──');
const bootstrap = fs.readFileSync(path.join(process.cwd(), 'packages/api-server/src/bootstrap-jobs.ts'), 'utf8');
for (const jobId of [
  'system-news-scout-morning',
  'system-watchdog-morning',
  'system-factcheck-morning',
  'system-atlas-morning-brief',
  'system-mission-control-hourly',
  'system-breakers-nightly',
  'system-portfolio-weekly-review',
]) {
  check(`seeded job exists: ${jobId}`, bootstrap.includes(`id: '${jobId}'`));
}
check('portfolio cadence explicitly uses America/Chicago', (bootstrap.match(/timeZone: 'America\/Chicago'/g) ?? []).length >= 7);
check('on-demand activation scanner is present', fs.readFileSync(path.join(process.cwd(), 'packages/api-server/src/runtime-bootstrap.ts'), 'utf8').includes('activateQueuedPortfolioAgents'));

console.log(`\n${failures === 0 ? '✅ ALL PORTFOLIO WORKFORCE CHECKS PASSED' : `❌ ${failures} PORTFOLIO WORKFORCE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
