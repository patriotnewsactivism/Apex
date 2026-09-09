import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}
function write(path, content) {
  fs.writeFileSync(path, content);
}
function replaceExact(content, before, after, label) {
  const first = content.indexOf(before);
  const last = content.lastIndexOf(before);
  if (first === -1 || first !== last) {
    throw new Error(`${label}: expected exactly one match`);
  }
  return content.slice(0, first) + after + content.slice(first + before.length);
}

const serviceId = '60b6d260-f5d8-463d-87be-58339545eaaf';
const environmentId = '6ce38db0-789b-4fe9-ad02-f068fe6866ae';

// Core BuildMyBot connector: Railway is production authority; Vercel is not used.
{
  const path = 'packages/core/src/buildmybot-connector.ts';
  let src = read(path);
  src = replaceExact(
    src,
    `// workforce (the persistent, role-specific agents that run as Vercel cron\n// workers backed by Supabase). APEX is the portfolio-level commander; the\n// BuildMyBot agents are its hands for that product.`,
    `// workforce (the persistent, role-specific agents served by the Railway-hosted\n// Node/Express application, with scheduled jobs triggered by BuildMyBot/GitHub\n// automation and durable state in Supabase). APEX is the portfolio-level\n// commander; the BuildMyBot agents are its hands for that product.`,
    'core architecture comment',
  );
  src = replaceExact(
    src,
    `//   BUILDMYBOT_CRON_SECRET           same value as Vercel's CRON_SECRET\n//   BUILDMYBOT_VERCEL_DEPLOY_HOOK    Vercel deploy-hook URL for the\n//                                    buildmybot2 project (managed-project\n//                                    deploy authority; approval-gated tool)`,
    `//   BUILDMYBOT_CRON_SECRET           shared secret protecting BuildMyBot cron routes\n//   BUILDMYBOT_RAILWAY_TOKEN         Railway API token (approval-gated deploy tool)\n//   BUILDMYBOT_RAILWAY_SERVICE_ID    defaults to the current buildmybot2-web service\n//   BUILDMYBOT_RAILWAY_ENVIRONMENT_ID defaults to the current production environment`,
    'core env docs',
  );
  src = replaceExact(
    src,
    `// 'patriotnewsactivism/buildmybot2'), trigger deploys via the Vercel deploy\n// hook (approval-gated), and run live health checks against buildmybot.app.\n// Direct pushes to main remain off the table — code still lands through\n// branch-protected PRs; the deploy hook only rebuilds what's merged.`,
    `// 'patriotnewsactivism/buildmybot2'), manually retrigger the Railway service\n// when required (approval-gated), and run live health checks against\n// buildmybot.app. Direct pushes to main remain off the table — code still lands\n// through reviewed PRs, and Railway normally auto-deploys merged main commits.`,
    'core security docs',
  );
  src = replaceExact(
    src,
    `        // Every one of these resolves through buildmybot2's single dynamic\n        // cron route (api/cron/[job].ts), which exists to stay under Vercel's\n        // Hobby 12-function cap. sales-outreach in particular has NO\n        // vercel.json cron entry, so this tool is the only thing that runs it\n        // short of a manual curl. sms_overage (added 2026-09-06) also has its`,
    `        // Every one of these resolves through buildmybot2's dynamic cron routes\n        // mounted by the Railway/Express runtime. This tool provides an on-demand\n        // trigger independent of the recurring GitHub/BuildMyBot schedules.\n        // sms_overage (added 2026-09-06) also has its`,
    'core cron docs',
  );
  src = src.replaceAll(
    `After merge, request buildmybot_deploy (approval-gated Vercel deploy hook)`,
    `Railway auto-deploys merged main commits; use buildmybot_deploy only to manually retrigger production when needed`,
  );

  const start = `    // ── Manage: trigger a production deploy via Vercel deploy hook ─────────\n    {\n      name: 'buildmybot_deploy',`;
  const startIndex = src.indexOf(start);
  if (startIndex < 0) throw new Error('core deploy block start not found');
  const endMarker = `\n    // ── Manage: live health check against the deployed product ─────────────`;
  const endIndex = src.indexOf(endMarker, startIndex);
  if (endIndex < 0) throw new Error('core deploy block end not found');
  const railwayBlock = `    // ── Manage: manually retrigger the Railway production service ───────────\n    {\n      name: 'buildmybot_deploy',\n      description:\n        'Manually retrigger the Railway production service for buildmybot2. Railway normally auto-deploys merged main commits, so use this only for an explicit recovery/redeploy. Requires BUILDMYBOT_RAILWAY_TOKEN and approval.',\n      schema: z.object({\n        reason: z\n          .string()\n          .describe('Why this Railway redeploy is being triggered (audit trail)'),\n      }),\n      requiresApproval: true,\n      async execute({ reason }) {\n        const token = process.env.BUILDMYBOT_RAILWAY_TOKEN;\n        if (!token) throw new Error('BUILDMYBOT_RAILWAY_TOKEN is not configured');\n        const serviceId = process.env.BUILDMYBOT_RAILWAY_SERVICE_ID ?? '${serviceId}';\n        const environmentId = process.env.BUILDMYBOT_RAILWAY_ENVIRONMENT_ID ?? '${environmentId}';\n        const query = \\`mutation serviceInstanceRedeploy($environmentId: String!, $serviceId: String!) {\n          serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId)\n        }\\`;\n        const res = await fetch('https://backboard.railway.com/graphql/v2', {\n          method: 'POST',\n          headers: {\n            Authorization: \\`Bearer $\\{token}\\`,\n            'Content-Type': 'application/json',\n          },\n          body: JSON.stringify({ query, variables: { environmentId, serviceId } }),\n          signal: AbortSignal.timeout(15_000),\n        });\n        const payload = await res.json().catch(() => null) as\n          | { data?: { serviceInstanceRedeploy?: boolean }; errors?: Array<{ message?: string }> }\n          | null;\n        const railwayError = payload?.errors?.map((error) => error.message).filter(Boolean).join('; ');\n        if (!res.ok || railwayError || payload?.data?.serviceInstanceRedeploy !== true) {\n          throw new Error(\n            \\`Railway redeploy failed ($\\{res.status}): $\\{railwayError || 'unexpected response'}\\`,\n          );\n        }\n        return { success: true, platform: 'railway', reason, serviceId, environmentId };\n      },\n    },\n`;
  src = src.slice(0, startIndex) + railwayBlock + src.slice(endIndex);
  if (/BUILDMYBOT_VERCEL_DEPLOY_HOOK|Vercel deploy|Vercel cron|vercel\.json/.test(src)) {
    throw new Error('core connector still contains a BuildMyBot Vercel assumption');
  }
  write(path, src);
}

// APEX Settings: configure Railway authority, never a Vercel hook.
{
  const path = 'packages/api-server/src/routes/settings.ts';
  let src = read(path);
  src = replaceExact(
    src,
    `      { key: 'BUILDMYBOT_VERCEL_DEPLOY_HOOK', label: 'Deploy Hook', placeholder: 'legacy deploy hook', secret: true },`,
    `      { key: 'BUILDMYBOT_RAILWAY_TOKEN', label: 'Railway API Token', placeholder: 'Railway token', secret: true },\n      { key: 'BUILDMYBOT_RAILWAY_SERVICE_ID', label: 'Railway Service ID', placeholder: '${serviceId}' },\n      { key: 'BUILDMYBOT_RAILWAY_ENVIRONMENT_ID', label: 'Railway Environment ID', placeholder: '${environmentId}' },`,
    'settings BuildMyBot deploy fields',
  );
  write(path, src);
}

// Environment example.
{
  const path = '.env.example';
  let src = read(path);
  src = replaceExact(
    src,
    `# BUILDMYBOT_VERCEL_DEPLOY_HOOK=`,
    `# BUILDMYBOT_RAILWAY_TOKEN=\n# BUILDMYBOT_RAILWAY_SERVICE_ID=${serviceId}\n# BUILDMYBOT_RAILWAY_ENVIRONMENT_ID=${environmentId}`,
    'env example deploy field',
  );
  write(path, src);
}

// Lead Developer runtime prompt.
{
  const path = 'packages/agents/src/lead-developer.ts';
  let src = read(path);
  src = replaceExact(
    src,
    `on github.com/patriotnewsactivism/buildmybot2 (the revenue flagship, deployed\non Vercel at buildmybot.app), dispatched by the COO/CEO. Treat them exactly\nlike internal tickets, with these rules:\n1. All changes land via create_pull_request with repo\n   'patriotnewsactivism/buildmybot2' — NEVER direct pushes to main.\n2. That codebase is 100% Vercel serverless functions under api/*.ts (no\n   server/ directory — it's phantom legacy documentation).\n3. After the PR merges, request buildmybot_deploy (approval-gated), then\n   verify with buildmybot_health_check and report the real HTTP result.`,
    `on github.com/patriotnewsactivism/buildmybot2 (the revenue flagship, deployed\non Railway at buildmybot.app), dispatched by the COO/CEO. Treat them exactly\nlike internal tickets, with these rules:\n1. All changes land via create_pull_request with repo\n   'patriotnewsactivism/buildmybot2' — NEVER direct pushes to main.\n2. The production runtime is the Railway-hosted Node/Express app in server.ts;\n   API handlers remain under api/*.ts and are mounted into that server.\n3. Railway normally auto-deploys merged main commits. Verify with\n   buildmybot_health_check; use buildmybot_deploy only for an approved manual\n   Railway redeploy/recovery.`,
    'lead developer BuildMyBot prompt',
  );
  write(path, src);
}

// Portfolio registration shown to autonomous agents.
{
  const path = 'packages/api-server/src/index.ts';
  let src = read(path);
  src = replaceExact(
    src,
    `Managed project: COO dispatches engineering via buildmybot_dispatch_engineering; deploys via Vercel hook; health target https://www.buildmybot.app/api/health.`,
    `Managed project: COO dispatches engineering via buildmybot_dispatch_engineering; Railway auto-deploys merged main commits and buildmybot_deploy can manually retrigger Railway; health target https://www.buildmybot.app/api/health.`,
    'portfolio BuildMyBot purpose',
  );
  write(path, src);
}

// Convex tool registry mirrors the production connector.
{
  const path = 'packages/convex-backend/convex/toolRegistry.ts';
  let src = read(path);
  const start = `  // ─── BuildMyBot: Deploy (sync — Vercel deploy hook; approval required) ───────\n  buildmybot_deploy: {`;
  const startIndex = src.indexOf(start);
  if (startIndex < 0) throw new Error('Convex BuildMyBot deploy block start not found');
  const endMarker = `\n  // ─── BuildMyBot: Health Check`;
  const endIndex = src.indexOf(endMarker, startIndex);
  if (endIndex < 0) throw new Error('Convex BuildMyBot deploy block end not found');
  const block = `  // ─── BuildMyBot: Deploy (sync — Railway redeploy; approval required) ────────\n  buildmybot_deploy: {\n    schema: {\n      name: 'buildmybot_deploy',\n      description:\n        'Manually retrigger the Railway production service for buildmybot2. Railway normally auto-deploys merged main commits. Requires BUILDMYBOT_RAILWAY_TOKEN and approval.',\n      parameters: {\n        type: 'object',\n        properties: { reason: { type: 'string', description: 'Why this Railway redeploy is being triggered (audit trail)' } },\n        required: ['reason'],\n      },\n    },\n    requiresApproval: true,\n    kind: 'sync',\n    run: async (_ctx, args) => {\n      const { reason } = args as { reason: string };\n      const token = process.env.BUILDMYBOT_RAILWAY_TOKEN;\n      if (!token) throw new Error('BUILDMYBOT_RAILWAY_TOKEN is not configured');\n      const serviceId = process.env.BUILDMYBOT_RAILWAY_SERVICE_ID ?? '${serviceId}';\n      const environmentId = process.env.BUILDMYBOT_RAILWAY_ENVIRONMENT_ID ?? '${environmentId}';\n      const query = \\`mutation serviceInstanceRedeploy($environmentId: String!, $serviceId: String!) {\n        serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId)\n      }\\`;\n      const res = await fetch('https://backboard.railway.com/graphql/v2', {\n        method: 'POST',\n        headers: { Authorization: \\`Bearer $\\{token}\\`, 'Content-Type': 'application/json' },\n        body: JSON.stringify({ query, variables: { environmentId, serviceId } }),\n        signal: AbortSignal.timeout(15_000),\n      });\n      const payload = await res.json().catch(() => null) as\n        | { data?: { serviceInstanceRedeploy?: boolean }; errors?: Array<{ message?: string }> }\n        | null;\n      const railwayError = payload?.errors?.map((error) => error.message).filter(Boolean).join('; ');\n      if (!res.ok || railwayError || payload?.data?.serviceInstanceRedeploy !== true) {\n        throw new Error(\\`Railway redeploy failed ($\\{res.status}): $\\{railwayError || 'unexpected response'}\\`);\n      }\n      return { success: true, platform: 'railway', reason, serviceId, environmentId };\n    },\n  },\n`;
  src = src.slice(0, startIndex) + block + src.slice(endIndex);
  if (src.includes('BUILDMYBOT_VERCEL_DEPLOY_HOOK')) {
    throw new Error('Convex registry still contains BUILDMYBOT_VERCEL_DEPLOY_HOOK');
  }
  write(path, src);
}

// Convex agent configs are generated snapshots of the operational prompts; fix
// the stale BuildMyBot deployment statements without touching unrelated Vercel
// targets that APEX may legitimately manage for other projects.
{
  const path = 'packages/convex-backend/convex/agentConfigs.ts';
  let src = read(path);
  src = src.replaceAll('on Vercel at buildmybot.app', 'on Railway at buildmybot.app');
  src = src.replaceAll(
    'That codebase is 100% Vercel serverless functions under api/*.ts (no\\n   server/ directory — it\'s phantom legacy documentation).',
    'The production runtime is the Railway-hosted Node/Express app in server.ts;\\n   API handlers remain under api/*.ts and are mounted into that server.',
  );
  src = src.replaceAll(
    'After the PR merges, request buildmybot_deploy (approval-gated), then\\n   verify with buildmybot_health_check and report the real HTTP result.',
    'Railway normally auto-deploys merged main commits. Verify with\\n   buildmybot_health_check; use buildmybot_deploy only for an approved manual Railway redeploy/recovery.',
  );
  write(path, src);
}

const filesToCheck = [
  'packages/core/src/buildmybot-connector.ts',
  'packages/api-server/src/routes/settings.ts',
  'packages/api-server/src/index.ts',
  'packages/agents/src/lead-developer.ts',
  'packages/convex-backend/convex/toolRegistry.ts',
  'packages/convex-backend/convex/agentConfigs.ts',
  '.env.example',
];
for (const path of filesToCheck) {
  const src = read(path);
  if (src.includes('BUILDMYBOT_VERCEL_DEPLOY_HOOK')) {
    throw new Error(`${path}: stale BUILDMYBOT_VERCEL_DEPLOY_HOOK remains`);
  }
}
console.log('BuildMyBot Railway authority patch applied successfully.');
