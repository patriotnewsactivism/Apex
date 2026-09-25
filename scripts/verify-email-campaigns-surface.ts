/**
 * Guard: Email campaigns must have a human-facing control surface, not just
 * an agent tool chain.
 *
 * start_email_campaign / send_email_campaign_batch / get_email_campaign_status
 * (packages/core/src/tool-registry.ts) have written and read emailCampaigns/
 * emailSends since 2026-09-06. Nothing else ever did: no route, no dashboard
 * panel. send_email_campaign_batch has always checked for a 'paused' campaign
 * and told the caller to "resume it" — but no code path could ever perform
 * that transition, so the message pointed at a control that did not exist.
 *
 * This guard is source-structural (no live Postgres in CI) except for the
 * funnel-math helper, which is pure and imported/executed directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.GITHUB_WORKSPACE ?? path.resolve(here, '..');

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ❌ ${label}`);
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail)}`);
}

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

async function main(): Promise<void> {
  console.log('Verifying the email-campaigns control surface...\n');

  const route = read('packages/api-server/src/routes/email-campaigns.ts');
  const index = read('packages/api-server/src/index.ts');
  const tools = read('packages/core/src/tool-registry.ts');
  const dashboardApi = read('packages/dashboard/src/lib/api.ts');
  const appTsx = read('packages/dashboard/src/App.tsx');
  const salesOpsPanel = read('packages/dashboard/src/components/SalesOperationsPanel.tsx');
  const emailPanel = read('packages/dashboard/src/components/EmailCampaignsPanel.tsx');

  // ── The route exists and covers the full lifecycle ───────────────────────
  check('lists every campaign', /router\.get\('\/', async/.test(route));
  check('reads one campaign with its individual sends', /router\.get\('\/:id', async/.test(route));
  check('exposes pause, resume, and cancel', ['pause', 'resume', 'cancel'].every((a) => route.includes(`action: '${a}'`)));
  check(
    'lists recent sends across campaigns and one-off email',
    /router\.get\('\/sends', async/.test(route) &&
      /scope === 'one-off'/.test(route) &&
      /isNull\(emailSends\.campaignId\)/.test(route),
  );
  check(
    'the literal /sends route is registered before /:id so Express cannot shadow it',
    route.indexOf("router.get('/sends'") > -1 &&
      route.indexOf("router.get('/sends'") < route.indexOf("router.get('/:id'"),
  );

  // ── Transitions match the states the tool chain actually uses ────────────
  // draft | running | paused | completed | cancelled (lib/db/src/schema.ts).
  check(
    'a draft can be paused before its first batch ever sends, same as a running one mid-send',
    /PAUSABLE_STATUSES = \['draft', 'running'\]/.test(route),
  );
  check(
    'resume only ever comes from paused — running is not a resume source',
    /\{ action: 'resume', next: 'running', from: \['paused'\] \}/.test(route),
  );
  check(
    'cancel is reachable from every non-terminal state',
    /CANCELLABLE_STATUSES = \['draft', 'running', 'paused'\]/.test(route),
  );
  check(
    'completed and cancelled are terminal — no transition accepts them as a source',
    !/from: readonly string\[\]\] = \[.*'completed'/.test(route) &&
      !route.includes("from: ['completed'") &&
      !route.includes("'completed', 'cancelled']"),
  );

  // ── The transition is CAS, not read-then-write ────────────────────────────
  // Two operators (or an operator racing send_email_campaign_batch's own
  // status flip to 'running') must not both win one transition.
  check(
    'the status update is conditioned on the status just read, not applied unconditionally',
    /\.where\(and\(eq\(emailCampaigns\.id, campaign\.id\), eq\(emailCampaigns\.status, campaign\.status\)\)\)/.test(route),
  );
  check(
    'a lost race is reported as 409, not silently treated as success',
    /if \(!updated\) \{[\s\S]{0,200}res\.status\(409\)/.test(route),
  );
  check(
    'an invalid transition (wrong current state) is also 409, with the actual state named',
    /res\.status\(409\)\.json\(\{[\s\S]{0,120}no longer be \$\{action\}d/.test(route),
  );

  // ── It is mounted, and mounted BEHIND admin auth ──────────────────────────
  // Unlike the Vapi/Telnyx/Resend webhook routers (mounted before auth because
  // a third party cannot carry a Bearer token), this route has only human
  // callers and pausing/cancelling a real send must require login.
  check('the router is imported in index.ts', /import \{ createEmailCampaignsRouter \} from '\.\/routes\/email-campaigns\.js';/.test(index));
  check('the router is mounted at /api/email-campaigns', /app\.use\('\/api\/email-campaigns', createEmailCampaignsRouter\(\)\)/.test(index));
  const authGateIndex = index.indexOf("app.use('/api', requireAdminAuth);");
  const mountIndex = index.indexOf("app.use('/api/email-campaigns'");
  check(
    'the mount point comes after the blanket /api admin-auth gate, not before it',
    authGateIndex > -1 && mountIndex > authGateIndex,
    { authGateIndex, mountIndex },
  );

  // ── The dead end is actually fixed ────────────────────────────────────────
  const pausedBlock = tools.slice(tools.indexOf("campaign.status === 'paused'"), tools.indexOf("campaign.status === 'paused'") + 400);
  check(
    'send_email_campaign_batch now names a real mechanism, not just "resume it"',
    /\/api\/email-campaigns\/:id\/resume/.test(pausedBlock) || /Email Campaigns dashboard/.test(pausedBlock),
  );

  // ── Dashboard: client, panel, and navigation all exist ────────────────────
  check(
    'the dashboard API client can list/get/control email campaigns and read all sends',
    /emailCampaigns: \{/.test(dashboardApi) &&
      /list: \(\) => apiFetch<\{ campaigns: EmailCampaignProgress\[\] \}>\('\/email-campaigns'\)/.test(dashboardApi) &&
      /sends: \(params\?:/.test(dashboardApi) &&
      /\/email-campaigns\/sends/.test(dashboardApi) &&
      /control: \(id: string, action: 'pause' \| 'resume' \| 'cancel'\)/.test(dashboardApi),
  );
  // Sales Operations consolidated Campaigns/Automation/Email Campaigns into
  // one nav destination with in-page sub-tabs (2026-09-15) — EmailCampaignsPanel
  // is reachable through SalesOperationsPanel's Email sub-tab now, not its own
  // top-level App.tsx entry. The panel component itself is untouched.
  check(
    'EmailCampaignsPanel is imported and rendered inside SalesOperationsPanel\'s Email sub-tab',
    /import \{ EmailCampaignsPanel \} from '\.\/EmailCampaignsPanel\.js';/.test(salesOpsPanel) &&
      /tab === 'email' && <EmailCampaignsPanel \/>/.test(salesOpsPanel),
  );
  check(
    'Revenue Operations has a real nav entry and page title, so the panel is actually reachable',
    /\{ id: 'sales-ops', label: 'Revenue Operations'/.test(appTsx) &&
      /'sales-ops': \{ title: 'Revenue Operations', kicker: 'Revenue' \}/.test(appTsx),
  );

  check(
    'Email panel exposes a recent activity feed that includes one-off sends',
    /Recent email activity/.test(emailPanel) &&
      /api\.emailCampaigns\.sends\(\{ limit: 100, scope: 'all' \}\)/.test(emailPanel) &&
      /'One-off'/.test(emailPanel),
  );
  check(
    'stored email HTML is sandboxed instead of injected into the dashboard DOM',
    /<iframe/.test(emailPanel) &&
      /sandbox=""/.test(emailPanel) &&
      /Content-Security-Policy/.test(emailPanel) &&
      !/dangerouslySetInnerHTML/.test(emailPanel),
  );

  // ── The one piece of real logic: run it, don't just read it ──────────────
  const mod = (await import(
    path.join(root, 'packages/api-server/src/routes/email-campaigns.ts')
  )) as typeof import('../packages/api-server/src/routes/email-campaigns.js');
  const { summarizeEmailCampaign } = mod;

  const baseCampaign = {
    id: 'camp_1',
    name: 'Q3 HVAC outreach',
    leadCampaignId: 'lead_camp_1',
    goalId: null,
    subjectTemplate: 'Hi {{companyName}}',
    bodyTemplate: '...',
    status: 'running',
    totalTargets: 100,
    sentCount: 40,
    failedCount: 5,
    createdByAgentId: 'apex-sales-001',
    createdAt: new Date('2026-09-10T00:00:00Z'),
    startedAt: new Date('2026-09-10T00:05:00Z'),
    completedAt: null,
    lastProgressAt: new Date('2026-09-10T01:00:00Z'),
    result: null,
  } as unknown as Parameters<typeof summarizeEmailCampaign>[0];

  const summary = summarizeEmailCampaign(baseCampaign, {
    queued: 55,
    sent: 10,
    delivered: 20,
    opened: 6,
    clicked: 2,
    bounced: 3,
    complained: 1,
    failed: 2,
    suppressed: 1,
  });

  check(
    'percentComplete is attempted-over-target, not sent-over-target',
    summary.percentComplete === 45, // (sentCount 40 + failedCount 5) / 100
    summary,
  );
  check(
    'every funnel bucket passes through unchanged',
    summary.delivered === 20 && summary.opened === 6 && summary.bounced === 3 && summary.suppressed === 1,
    summary,
  );
  check(
    'a status missing from the counts map reads as zero, never undefined',
    summarizeEmailCampaign(baseCampaign, {}).delivered === 0,
  );
  check(
    'a zero-target campaign reports 0% rather than dividing by zero',
    summarizeEmailCampaign({ ...baseCampaign, totalTargets: 0, sentCount: 0, failedCount: 0 }, {}).percentComplete === 0,
  );

  if (failures > 0) {
    console.error(`\n${failures} email-campaigns-surface check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll email-campaigns-surface checks passed.');
}

main();
