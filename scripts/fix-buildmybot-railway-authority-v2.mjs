import fs from 'node:fs';

const serviceId = '60b6d260-f5d8-463d-87be-58339545eaaf';
const environmentId = '6ce38db0-789b-4fe9-ad02-f068fe6866ae';
const endpoint = 'https://backboard.railway.com/graphql/v2';
const mutation = 'mutation serviceInstanceRedeploy($environmentId: String!, $serviceId: String!) { serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId) }';

const read = (path) => fs.readFileSync(path, 'utf8');
const write = (path, text) => fs.writeFileSync(path, text);

function replaceOne(text, before, after, label) {
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return text.replace(before, after);
}

function coreDeployBlock() {
  return [
    '    // ── Manage: manually retrigger the Railway production service ───────────',
    '    {',
    "      name: 'buildmybot_deploy',",
    '      description:',
    "        'Manually retrigger the Railway production service for buildmybot2. Railway normally auto-deploys merged main commits, so use this only for an explicit recovery/redeploy. Requires BUILDMYBOT_RAILWAY_TOKEN and approval.',",
    '      schema: z.object({',
    '        reason: z',
    '          .string()',
    "          .describe('Why this Railway redeploy is being triggered (audit trail)'),",
    '      }),',
    '      requiresApproval: true,',
    '      async execute({ reason }) {',
    '        const token = process.env.BUILDMYBOT_RAILWAY_TOKEN;',
    "        if (!token) throw new Error('BUILDMYBOT_RAILWAY_TOKEN is not configured');",
    `        const serviceId = process.env.BUILDMYBOT_RAILWAY_SERVICE_ID ?? '${serviceId}';`,
    `        const environmentId = process.env.BUILDMYBOT_RAILWAY_ENVIRONMENT_ID ?? '${environmentId}';`,
    `        const query = '${mutation}';`,
    `        const res = await fetch('${endpoint}', {`,
    "          method: 'POST',",
    "          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },",
    '          body: JSON.stringify({ query, variables: { environmentId, serviceId } }),',
    '          signal: AbortSignal.timeout(15_000),',
    '        });',
    '        const payload = await res.json().catch(() => null) as',
    '          | { data?: { serviceInstanceRedeploy?: boolean }; errors?: Array<{ message?: string }> }',
    '          | null;',
    "        const railwayError = payload?.errors?.map((error) => error.message).filter(Boolean).join('; ');",
    '        if (!res.ok || railwayError || payload?.data?.serviceInstanceRedeploy !== true) {',
    "          throw new Error('Railway redeploy failed (' + res.status + '): ' + (railwayError || 'unexpected response'));",
    '        }',
    "        return { success: true, platform: 'railway', reason, serviceId, environmentId };",
    '      },',
    '    },',
  ].join('\n');
}

function convexDeployBlock() {
  return [
    '  // ─── BuildMyBot: Deploy (sync — Railway redeploy; approval required) ────────',
    '  buildmybot_deploy: {',
    '    schema: {',
    "      name: 'buildmybot_deploy',",
    '      description:',
    "        'Manually retrigger the Railway production service for buildmybot2. Railway normally auto-deploys merged main commits. Requires BUILDMYBOT_RAILWAY_TOKEN and approval.',",
    '      parameters: {',
    "        type: 'object',",
    "        properties: { reason: { type: 'string', description: 'Why this Railway redeploy is being triggered (audit trail)' } },",
    "        required: ['reason'],",
    '      },',
    '    },',
    '    requiresApproval: true,',
    "    kind: 'sync',",
    '    run: async (_ctx, args) => {',
    '      const { reason } = args as { reason: string };',
    '      const token = process.env.BUILDMYBOT_RAILWAY_TOKEN;',
    "      if (!token) throw new Error('BUILDMYBOT_RAILWAY_TOKEN is not configured');",
    `      const serviceId = process.env.BUILDMYBOT_RAILWAY_SERVICE_ID ?? '${serviceId}';`,
    `      const environmentId = process.env.BUILDMYBOT_RAILWAY_ENVIRONMENT_ID ?? '${environmentId}';`,
    `      const query = '${mutation}';`,
    `      const res = await fetch('${endpoint}', {`,
    "        method: 'POST',",
    "        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },",
    '        body: JSON.stringify({ query, variables: { environmentId, serviceId } }),',
    '        signal: AbortSignal.timeout(15_000),',
    '      });',
    '      const payload = await res.json().catch(() => null) as',
    '        | { data?: { serviceInstanceRedeploy?: boolean }; errors?: Array<{ message?: string }> }',
    '        | null;',
    "      const railwayError = payload?.errors?.map((error) => error.message).filter(Boolean).join('; ');",
    '      if (!res.ok || railwayError || payload?.data?.serviceInstanceRedeploy !== true) {',
    "        throw new Error('Railway redeploy failed (' + res.status + '): ' + (railwayError || 'unexpected response'));",
    '      }',
    "      return { success: true, platform: 'railway', reason, serviceId, environmentId };",
    '    },',
    '  },',
  ].join('\n');
}

// Core BuildMyBot connector.
{
  const path = 'packages/core/src/buildmybot-connector.ts';
  let src = read(path);
  src = replaceOne(src, 'workforce (the persistent, role-specific agents that run as Vercel cron\n// workers backed by Supabase)', 'workforce (the persistent, role-specific agents served by the Railway-hosted\n// Node/Express application, with durable state in Supabase)', 'connector workforce description');
  src = replaceOne(src, "//   BUILDMYBOT_CRON_SECRET           same value as Vercel's CRON_SECRET\n//   BUILDMYBOT_VERCEL_DEPLOY_HOOK    Vercel deploy-hook URL for the\n//                                    buildmybot2 project (managed-project\n//                                    deploy authority; approval-gated tool)", `//   BUILDMYBOT_CRON_SECRET           shared secret protecting BuildMyBot cron routes\n//   BUILDMYBOT_RAILWAY_TOKEN         Railway API token (approval-gated redeploy tool)\n//   BUILDMYBOT_RAILWAY_SERVICE_ID    defaults to ${serviceId}\n//   BUILDMYBOT_RAILWAY_ENVIRONMENT_ID defaults to ${environmentId}`, 'connector env docs');
  src = replaceOne(src, "trigger deploys via the Vercel deploy\n// hook (approval-gated), and run live health checks against buildmybot.app.", 'manually retrigger Railway when required (approval-gated), and run live health\n// checks against buildmybot.app. Railway normally auto-deploys merged main commits.', 'connector security description');
  src = src.replace(/        \/\/ Every one of these resolves through buildmybot2's single dynamic[\s\S]*?short of a manual curl\./, "        // These resolve through buildmybot2's dynamic cron routes mounted by the\n        // Railway/Express runtime. This tool provides an on-demand trigger independent\n        // of the recurring GitHub/BuildMyBot schedules.");
  src = src.replaceAll('After merge, request buildmybot_deploy (approval-gated Vercel deploy hook)', 'Railway auto-deploys merged main commits; use buildmybot_deploy only to manually retrigger production when needed');
  const start = src.indexOf('    // ── Manage: trigger a production deploy via Vercel deploy hook');
  const end = src.indexOf('\n    // ── Manage: live health check against the deployed product', start);
  if (start < 0 || end < 0) throw new Error('connector deploy block markers not found');
  src = src.slice(0, start) + coreDeployBlock() + src.slice(end);
  if (/BUILDMYBOT_VERCEL_DEPLOY_HOOK|Vercel deploy hook|Vercel cron workers/.test(src)) throw new Error('stale BuildMyBot Vercel connector reference remains');
  write(path, src);
}

// APEX settings catalog.
{
  const path = 'packages/api-server/src/routes/settings.ts';
  let src = read(path);
  src = replaceOne(src, "      { key: 'BUILDMYBOT_VERCEL_DEPLOY_HOOK', label: 'Deploy Hook', placeholder: 'legacy deploy hook', secret: true },", `      { key: 'BUILDMYBOT_RAILWAY_TOKEN', label: 'Railway API Token', placeholder: 'Railway token', secret: true },\n      { key: 'BUILDMYBOT_RAILWAY_SERVICE_ID', label: 'Railway Service ID', placeholder: '${serviceId}' },\n      { key: 'BUILDMYBOT_RAILWAY_ENVIRONMENT_ID', label: 'Railway Environment ID', placeholder: '${environmentId}' },`, 'settings deploy fields');
  write(path, src);
}

// Environment template.
{
  const path = '.env.example';
  let src = read(path);
  src = replaceOne(src, '# BUILDMYBOT_VERCEL_DEPLOY_HOOK=', `# BUILDMYBOT_RAILWAY_TOKEN=\n# BUILDMYBOT_RAILWAY_SERVICE_ID=${serviceId}\n# BUILDMYBOT_RAILWAY_ENVIRONMENT_ID=${environmentId}`, 'env deploy field');
  write(path, src);
}

// Lead Developer operational prompt.
{
  const path = 'packages/agents/src/lead-developer.ts';
  let src = read(path);
  src = replaceOne(src, 'on Vercel at buildmybot.app', 'on Railway at buildmybot.app', 'lead developer platform');
  src = replaceOne(src, "2. That codebase is 100% Vercel serverless functions under api/*.ts (no\n   server/ directory — it's phantom legacy documentation).", '2. The production runtime is the Railway-hosted Node/Express app in server.ts;\n   API handlers remain under api/*.ts and are mounted into that server.', 'lead developer runtime');
  src = replaceOne(src, '3. After the PR merges, request buildmybot_deploy (approval-gated), then\n   verify with buildmybot_health_check and report the real HTTP result.', '3. Railway normally auto-deploys merged main commits. Verify with\n   buildmybot_health_check; use buildmybot_deploy only for an approved manual\n   Railway redeploy/recovery.', 'lead developer deploy flow');
  write(path, src);
}

// Portfolio registration used by running APEX.
{
  const path = 'packages/api-server/src/index.ts';
  let src = read(path);
  src = replaceOne(src, 'Managed project: COO dispatches engineering via buildmybot_dispatch_engineering; deploys via Vercel hook; health target https://www.buildmybot.app/api/health.', 'Managed project: COO dispatches engineering via buildmybot_dispatch_engineering; Railway auto-deploys merged main commits and buildmybot_deploy can manually retrigger Railway; health target https://www.buildmybot.app/api/health.', 'portfolio BuildMyBot purpose');
  write(path, src);
}

// Convex mirror of the BuildMyBot deploy tool.
{
  const path = 'packages/convex-backend/convex/toolRegistry.ts';
  let src = read(path);
  const start = src.indexOf('  // ─── BuildMyBot: Deploy (sync — Vercel deploy hook; approval required)');
  const end = src.indexOf('\n  // ─── BuildMyBot: Health Check', start);
  if (start < 0 || end < 0) throw new Error('Convex deploy block markers not found');
  src = src.slice(0, start) + convexDeployBlock() + src.slice(end);
  if (src.includes('BUILDMYBOT_VERCEL_DEPLOY_HOOK')) throw new Error('Convex BuildMyBot Vercel hook remains');
  write(path, src);
}

// Convex agent prompt snapshot.
{
  const path = 'packages/convex-backend/convex/agentConfigs.ts';
  let src = read(path);
  src = src.replaceAll('on Vercel at buildmybot.app', 'on Railway at buildmybot.app');
  src = src.replaceAll('Vercel serverless functions under api/*.ts', 'Railway/Express API handlers under api/*.ts');
  src = src.replaceAll('After the PR merges, request buildmybot_deploy (approval-gated), then', 'Railway normally auto-deploys merged main commits. Use buildmybot_deploy only for approved manual recovery; then');
  write(path, src);
}

for (const path of [
  'packages/core/src/buildmybot-connector.ts',
  'packages/api-server/src/routes/settings.ts',
  'packages/api-server/src/index.ts',
  'packages/agents/src/lead-developer.ts',
  'packages/convex-backend/convex/toolRegistry.ts',
  'packages/convex-backend/convex/agentConfigs.ts',
  '.env.example',
]) {
  const src = read(path);
  if (src.includes('BUILDMYBOT_VERCEL_DEPLOY_HOOK')) throw new Error(`${path}: stale BuildMyBot Vercel hook remains`);
}

console.log('BuildMyBot Railway authority patch applied.');
