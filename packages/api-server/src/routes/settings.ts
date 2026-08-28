import { Router } from 'express';
import { db, integrationSettings, tasks, agents } from '@workspace/db';
import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { getKnownApiKeyEnvs } from '@workspace/core';
import { CronParser } from '@workspace/background-jobs';

type IntegrationCategory = 'ai' | 'search' | 'voice' | 'dev' | 'data' | 'business';
type ProbeDefinition = { kind: 'openai-models'; baseUrl: string; extraHeaders?: Record<string, string> };
type IntegrationFieldDefinition = {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  probe?: ProbeDefinition;
};
type IntegrationDefinition = {
  id: string;
  name: string;
  description: string;
  category: IntegrationCategory;
  docsUrl?: string;
  envVars: IntegrationFieldDefinition[];
};

/** Backend-owned integration catalog. The AI section MUST match the runtime
 * free-first allowlist in packages/core/src/llm-client.ts. */
const BASE_INTEGRATION_CATALOG: IntegrationDefinition[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter — DeepSeek V4',
    description: 'Primary APEX LLM: DeepSeek V4 Flash Latest via OpenRouter. Extremely inexpensive at $0.03/$0.10 per million tokens.',
    category: 'ai',
    docsUrl: 'https://openrouter.ai',
    envVars: [
      {
        key: 'OPENROUTER_API_KEY_2', label: 'OpenRouter API Key', placeholder: 'sk-or-...', secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://openrouter.ai/api/v1' },
      },
      {
        key: 'OPENROUTER_API_KEY', label: 'Backup OpenRouter API Key', placeholder: 'sk-or-...', secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://openrouter.ai/api/v1' },
      },
    ],
  }];
};

/** Backend-owned integration catalog. The AI section MUST match the runtime
 * free-first allowlist in packages/core/src/llm-client.ts. */
const BASE_INTEGRATION_CATALOG: IntegrationDefinition[] = [
  {
    id: 'gemini-free',
    name: 'Google Gemini — Free Tier',
    description: 'First APEX rung: Gemini 3.7 Flash. Use only keys from projects that are not billing-enabled.',
    category: 'ai',
    docsUrl: 'https://aistudio.google.com',
    envVars: [
      {
        key: 'GEMINI_FREE_API_KEY', label: 'Free Project API Key', placeholder: 'AIza...', secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      },
      {
        key: 'GEMINI_FREE_API_KEY_2', label: 'Second Free Project Key', placeholder: 'AIza...', secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      },
    ],
  },
  {
    id: 'groq-free',
    name: 'Groq — Free Tier',
    description: 'Second rung: GPT-OSS 120B. Use only a key from a confirmed Groq Free-plan project/account.',
    category: 'ai',
    docsUrl: 'https://console.groq.com/docs/rate-limits',
    envVars: [
      {
        key: 'GROQ_FREE_API_KEY', label: 'Free Plan API Key', placeholder: 'gsk_...', secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://api.groq.com/openai/v1' },
      },
      {
        key: 'GROQ_FREE_TIER_CONFIRMED',
        label: 'Free Plan Confirmed',
        placeholder: 'true only while this key belongs to a Groq Free plan',
      },
    ],
  },
  {
    id: 'cohere',
    name: 'Cohere',
    description: 'Third rung: Command A+. Cohere currently makes Command A+ free until its applicable API rate limit is reached.',
    category: 'ai',
    docsUrl: 'https://dashboard.cohere.com/api-keys',
    envVars: [{
      key: 'COHERE_API_KEY', label: 'API Key', placeholder: 'Cohere API key', secret: true,
      probe: { kind: 'openai-models', baseUrl: 'https://api.cohere.ai/compatibility/v1' },
    }],
  },
  {
    id: 'poolside',
    name: 'Poolside',
    description: 'Fourth rung: Laguna S 2.1. Poolside currently advertises limited-time free API access; APEX requires an explicit confirmation.',
    category: 'ai',
    docsUrl: 'https://poolside.ai/models',
    envVars: [
      {
        key: 'POOLSIDE_API_KEY', label: 'API Key', placeholder: 'Poolside API key', secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://inference.poolside.ai/v1' },
      },
      {
        key: 'POOLSIDE_FREE_ACCESS_CONFIRMED',
        label: 'Free Access Confirmed',
        placeholder: 'true only while Poolside free access is active',
      },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    description: 'Fifth rung: Qwen 3.7 Max. Enable Alibaba Model Studio “Free quota only” before allowing APEX to use it.',
    category: 'ai',
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio',
    envVars: [
      { key: 'QWEN_API_KEY', label: 'API Key', placeholder: 'Qwen / Model Studio API key', secret: true },
      { key: 'QWEN_BASE_URL', label: 'Compatible API Base URL', placeholder: 'https://<workspace>.<region>.maas.aliyuncs.com/compatible-mode/v1' },
      { key: 'QWEN_FREE_QUOTA_ONLY', label: 'Free Quota Only Confirmed', placeholder: 'true after enabling provider-side Free quota only' },
    ],
  },
  {
    id: 'kilo',
    name: 'Kilo Code',
    description: 'Sixth rung: Kilo Auto Free. This is the free router, not Auto Frontier.',
    category: 'ai',
    docsUrl: 'https://kilo.ai/docs/getting-started/using-kilo-for-free',
    envVars: [{
      key: 'KILO_API_KEY', label: 'API Key', placeholder: 'Kilo AI Gateway key', secret: true,
      probe: { kind: 'openai-models', baseUrl: 'https://api.kilo.ai/api/gateway' },
    }],
  },
  {
    id: 'mistral-paid',
    name: 'Mistral — Paid Emergency Only',
    description: 'Last rung: Mistral Medium 3.5. Disabled by default and unreachable unless paid fallback is explicitly enabled.',
    category: 'ai',
    docsUrl: 'https://console.mistral.ai',
    envVars: [
      {
        key: 'MISTRAL_API_KEY', label: 'API Key', placeholder: 'Mistral API key', secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://api.mistral.ai/v1' },
      },
      {
        key: 'APEX_PAID_LLM_MODE',
        label: 'Paid Fallback Mode',
        placeholder: 'off (set fallback only with explicit spend approval)',
      },
    ],
  },
  {
    id: 'business-search',
    name: 'Business Search',
    description: 'Lead-research data providers used by searchBusinessDirectory and web research.',
    category: 'search',
    envVars: [
      { key: 'YELP_API_KEY', label: 'Yelp API Key', placeholder: 'Yelp key', secret: true },
      { key: 'GOOGLE_PLACES_API_KEY', label: 'Google Places API Key', placeholder: 'Google Places key', secret: true },
      { key: 'TAVILY_API_KEY', label: 'Tavily API Key', placeholder: 'tvly-...', secret: true },
      { key: 'BRAVE_SEARCH_API_KEY', label: 'Brave Search API Key', placeholder: 'Brave Search key', secret: true },
    ],
  },
  {
    id: 'vapi', name: 'Vapi', description: 'Outbound AI phone calls for the Sales agent.', category: 'voice',
    docsUrl: 'https://dashboard.vapi.ai',
    envVars: [
      { key: 'VAPI_API_KEY', label: 'Private API Key', placeholder: 'Vapi private key', secret: true },
      { key: 'VAPI_PHONE_NUMBER_ID', label: 'Phone Number ID', placeholder: 'Vapi phone number ID' },
      { key: 'VAPI_WEBHOOK_SECRET', label: 'Webhook Secret', placeholder: 'Optional webhook secret', secret: true },
    ],
  },
  {
    id: 'github', name: 'GitHub', description: 'Repository access used by the autonomous engineering PR loop.', category: 'dev',
    docsUrl: 'https://github.com/settings/tokens',
    envVars: [{ key: 'GITHUB_TOKEN', label: 'Personal Access Token', placeholder: 'github_pat_... or ghp_...', secret: true }],
  },
  {
    id: 'buildmybot', name: 'BuildMyBot Connector', description: 'Credentials and endpoints APEX uses to operate BuildMyBot.App as a managed project.', category: 'data',
    envVars: [
      { key: 'BUILDMYBOT_SUPABASE_URL', label: 'Supabase URL', placeholder: 'https://xxx.supabase.co' },
      { key: 'BUILDMYBOT_SUPABASE_SERVICE_KEY', label: 'Supabase Service Key', placeholder: 'service_role key', secret: true },
      { key: 'BUILDMYBOT_APP_URL', label: 'Application URL', placeholder: 'https://www.buildmybot.app' },
      { key: 'BUILDMYBOT_CRON_SECRET', label: 'Cron Secret', placeholder: 'cron secret', secret: true },
      { key: 'BUILDMYBOT_VERCEL_DEPLOY_HOOK', label: 'Deploy Hook', placeholder: 'https://api.vercel.com/v1/integrations/deploy/...', secret: true },
    ],
  },
  {
    id: 'casebuddy', name: 'CaseBuddy Connector', description: 'Credentials APEX uses to supervise the CaseBuddy platform.', category: 'data',
    envVars: [
      { key: 'CASEBUDDY_SUPABASE_URL', label: 'Supabase URL', placeholder: 'https://xxx.supabase.co' },
      { key: 'CASEBUDDY_SUPABASE_SERVICE_KEY', label: 'Supabase Service Key', placeholder: 'service_role key', secret: true },
      { key: 'CASEBUDDY_SYSTEM_USER_ID', label: 'System User ID', placeholder: 'UUID' },
    ],
  },
  {
    id: 'tubescribe', name: 'TubeScribe Connector', description: 'Read-only monitoring credentials for TubeScribe.', category: 'data',
    envVars: [
      { key: 'TUBESCRIBE_SUPABASE_URL', label: 'Supabase URL', placeholder: 'https://xxx.supabase.co' },
      { key: 'TUBESCRIBE_SUPABASE_SERVICE_KEY', label: 'Supabase Service Key', placeholder: 'service_role key', secret: true },
      { key: 'TUBESCRIBE_WORKER_URL', label: 'Worker URL', placeholder: 'https://worker.example.com' },
    ],
  },
  {
    id: 'stripe', name: 'Stripe', description: 'Payment processing used by sales-call checkout workflows.', category: 'business',
    docsUrl: 'https://dashboard.stripe.com/apikeys',
    envVars: [{ key: 'STRIPE_SECRET_KEY', label: 'Secret Key', placeholder: 'sk_live_... or sk_test_...', secret: true }],
  },
];

const EXCLUDED_RUNTIME_KEYS = new Set(['APEX_APPROVAL_MODE']);

function getIntegrationCatalog(): IntegrationDefinition[] {
  const catalog = BASE_INTEGRATION_CATALOG.map((item) => ({
    ...item,
    envVars: item.envVars.map((envVar) => ({ ...envVar })),
  }));
  const represented = new Set(catalog.flatMap((item) => item.envVars.map((envVar) => envVar.key)));
  for (const key of getKnownApiKeyEnvs()) {
    if (EXCLUDED_RUNTIME_KEYS.has(key) || represented.has(key)) continue;
    catalog.push({
      id: `runtime-${key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: key,
      description: 'Runtime-supported integration key exposed automatically by APEX.',
      category: 'ai',
      envVars: [{ key, label: 'Value', placeholder: key, secret: !key.endsWith('_URL') && !key.endsWith('_ID') }],
    });
    represented.add(key);
  }
  return catalog;
}

function getAllowedKeys(): Set<string> {
  return new Set(getIntegrationCatalog().flatMap((item) => item.envVars.map((envVar) => envVar.key)));
}

function findField(key: string): IntegrationFieldDefinition | undefined {
  for (const integration of getIntegrationCatalog()) {
    const field = integration.envVars.find((envVar) => envVar.key === key);
    if (field) return field;
  }
  return undefined;
}

async function probeConfiguredKey(key: string): Promise<{
  key: string;
  status: 'connected' | 'configured' | 'rate_limited' | 'billing_required' | 'invalid_key' | 'degraded';
  detail: string;
  httpStatus?: number;
}> {
  const field = findField(key);
  if (!field) throw new Error(`Unknown integration key '${key}'`);
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not configured`);
  if (!field.probe) return { key, status: 'configured', detail: 'Stored and applied to the running process. This integration does not have a non-destructive live probe yet.' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const baseUrl = field.probe.baseUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${value}`, ...(field.probe.extraHeaders ?? {}) },
      signal: controller.signal,
    });
    if (response.ok) return { key, status: 'connected', detail: 'Provider accepted the credential.', httpStatus: response.status };
    if (response.status === 401 || response.status === 403) return { key, status: 'invalid_key', detail: 'Provider rejected the credential or free quota is unavailable.', httpStatus: response.status };
    if (response.status === 402) return { key, status: 'billing_required', detail: 'Credential is recognized, but the provider requires billing/account funding.', httpStatus: response.status };
    if (response.status === 429) return { key, status: 'rate_limited', detail: 'Credential reached the provider, but the account is currently rate/quota limited.', httpStatus: response.status };
    if (response.status === 404 || response.status === 405) return { key, status: 'configured', detail: 'Credential is stored; this provider does not expose the lightweight model-list probe used by APEX.', httpStatus: response.status };
    return { key, status: 'degraded', detail: `Provider probe returned HTTP ${response.status}.`, httpStatus: response.status };
  } catch (err) {
    const detail = err instanceof Error && err.name === 'AbortError'
      ? 'Provider probe timed out after 10 seconds.'
      : `Provider probe failed: ${err instanceof Error ? err.message : String(err)}`;
    return { key, status: 'degraded', detail };
  } finally {
    clearTimeout(timeout);
  }
}

export function createSettingsRouter(): Router {
  const router = Router();

  router.get('/integrations', async (_req, res) => {
    try {
      const catalog = getIntegrationCatalog();
      const flatStatus = catalog.flatMap((item) => item.envVars).map((envVar) => ({ key: envVar.key, configured: Boolean(process.env[envVar.key]) }));
      res.json({
        integrations: flatStatus,
        catalog: catalog.map((item) => ({
          id: item.id, name: item.name, description: item.description, category: item.category, docsUrl: item.docsUrl,
          envVars: item.envVars.map((envVar) => ({ key: envVar.key, label: envVar.label, placeholder: envVar.placeholder, secret: envVar.secret ?? false, configured: Boolean(process.env[envVar.key]), probeable: Boolean(envVar.probe) })),
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/integrations', async (req, res) => {
    try {
      const { key, value } = req.body ?? {};
      if (typeof key !== 'string' || typeof value !== 'string' || !value.trim()) {
        res.status(400).json({ error: 'key and non-empty value are required' });
        return;
      }
      if (!getAllowedKeys().has(key)) {
        res.status(400).json({ error: `Unknown integration key '${key}'` });
        return;
      }
      await db.insert(integrationSettings).values({ key, value, updatedAt: new Date() }).onConflictDoUpdate({ target: integrationSettings.key, set: { value, updatedAt: new Date() } });
      process.env[key] = value;
      res.json({ ok: true, key, configured: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/integrations/probe', async (req, res) => {
    try {
      const { key } = req.body ?? {};
      if (typeof key !== 'string' || !key) {
        res.status(400).json({ error: 'key is required' });
        return;
      }
      if (!getAllowedKeys().has(key)) {
        res.status(400).json({ error: `Unknown integration key '${key}'` });
        return;
      }
      res.json(await probeConfiguredKey(key));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/integrations/:key', async (req, res) => {
    try {
      const { key } = req.params;
      if (!getAllowedKeys().has(key)) {
        res.status(400).json({ error: `Unknown integration key '${key}'` });
        return;
      }
      await db.delete(integrationSettings).where(eq(integrationSettings.key, key));
      delete process.env[key];
      res.json({ ok: true, key, configured: false });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/recover-workforce', async (_req, res) => {
    try {
      const providerFailurePredicate = or(
        ilike(tasks.errorMessage, '%All LLM providers failed%'),
        ilike(tasks.errorMessage, '%LLM provider%failed%'),
        ilike(tasks.errorMessage, '%providers exhausted%'),
      );
      const candidates = await db.select({ id: tasks.id, assignedAgentId: tasks.assignedAgentId }).from(tasks).where(and(eq(tasks.status, 'failed'), sql`${tasks.retryCount} < ${tasks.maxRetries}`, providerFailurePredicate)).limit(100);
      const batch = candidates.slice(0, 25);
      const now = new Date();
      for (const task of batch) {
        await db.update(tasks).set({ status: 'pending', leasedAt: null, nextRetryAt: new Date(now.getTime() + 1_000), errorMessage: null, updatedAt: now }).where(and(eq(tasks.id, task.id), eq(tasks.status, 'failed')));
      }
      const affectedAgentIds = [...new Set(batch.map((task) => task.assignedAgentId).filter((id): id is string => Boolean(id)))];
      let resetAgentRows = 0;
      if (affectedAgentIds.length > 0) {
        const resetRows = await db.update(agents).set({ status: 'idle', lastActiveAt: now }).where(and(eq(agents.status, 'error'), inArray(agents.id, affectedAgentIds))).returning({ id: agents.id });
        resetAgentRows = resetRows.length;
      }
      res.json({ ok: true, recoveredTasks: batch.length, resetAgentRows, skippedTasks: Math.max(0, candidates.length - batch.length), note: batch.length > 0 ? 'Provider-failure tasks were requeued in a bounded batch. Live agent status will clear as the autonomous loops pick up work.' : 'No retryable provider-failure tasks were found.' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const AUTONOMY_PRESETS: Record<string, { cron: string; label: string }> = {
    conservative: { cron: '*/30 * * * *', label: 'Conservative — goal review every 30 min, lower throughput' },
    balanced: { cron: '*/15 * * * *', label: 'Balanced — goal review every 15 min (default)' },
    aggressive: { cron: '*/10 * * * *', label: 'Aggressive — goal review every 10 min, max throughput' },
  };

  router.get('/system', async (_req, res) => {
    try {
      const rows = await db.select().from(integrationSettings);
      const settings: Record<string, string> = {};
      for (const row of rows.filter((r) => r.key.startsWith('system:'))) settings[row.key.replace('system:', '')] = row.value;
      if (!settings.autonomy_level) settings.autonomy_level = 'balanced';
      res.json({ settings });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/system', async (req, res) => {
    try {
      const { autonomy_level } = req.body ?? {};
      const updates: Array<{ key: string; value: string }> = [];
      if (autonomy_level && AUTONOMY_PRESETS[autonomy_level]) {
        updates.push({ key: 'system:autonomy_level', value: autonomy_level });
        const newCron = AUTONOMY_PRESETS[autonomy_level].cron;
        const { scheduledJobs } = await import('@workspace/db');
        const [reviewJob] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, 'system-ceo-goal-review')).limit(1);
        if (reviewJob) {
          const nextRunAt = CronParser.nextRun(newCron, new Date()) ?? new Date(Date.now() + 60_000);
          await db.update(scheduledJobs).set({ cronExpression: newCron, nextRunAt, status: 'active', retryCount: 0 }).where(eq(scheduledJobs.id, 'system-ceo-goal-review'));
        }
      }
      for (const { key, value } of updates) {
        await db.insert(integrationSettings).values({ key, value, updatedAt: new Date() }).onConflictDoUpdate({ target: integrationSettings.key, set: { value, updatedAt: new Date() } });
      }
      res.json({ ok: true, updated: updates });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}