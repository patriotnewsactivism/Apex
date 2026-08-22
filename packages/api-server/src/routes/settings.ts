import { Router } from 'express';
import { db, integrationSettings, tasks, agents } from '@workspace/db';
import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { getKnownApiKeyEnvs } from '@workspace/core';
import { CronParser } from '@workspace/background-jobs';

type IntegrationCategory = 'ai' | 'search' | 'voice' | 'dev' | 'data' | 'business';

type ProbeDefinition = {
  kind: 'openai-models';
  baseUrl: string;
  extraHeaders?: Record<string, string>;
};

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

const OPENROUTER_HEADERS = {
  'HTTP-Referer': 'https://apex.donmatthews.live',
  'X-Title': 'Apex',
};

/**
 * Backend-owned integration catalog.
 *
 * The dashboard used to carry a second, hard-coded provider list that drifted
 * away from the actual runtime. That made the UI advertise dead providers and
 * POST keys the backend would reject. The browser now renders this catalog
 * instead, and the same catalog is the allowlist for writes.
 */
const BASE_INTEGRATION_CATALOG: IntegrationDefinition[] = [
  {
    id: 'mistral',
    name: 'Mistral',
    description: 'Primary high-capacity LLM provider in the current fallback chain.',
    category: 'ai',
    docsUrl: 'https://console.mistral.ai',
    envVars: [
      {
        key: 'MISTRAL_API_KEY',
        label: 'API Key',
        placeholder: 'Mistral API key',
        secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://api.mistral.ai/v1' },
      },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Two independently-quotad Gemini projects can be configured for fallback capacity.',
    category: 'ai',
    docsUrl: 'https://aistudio.google.com',
    envVars: [
      {
        key: 'GEMINI_API_KEY',
        label: 'Primary API Key',
        placeholder: 'AIza...',
        secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      },
      {
        key: 'GEMINI_API_KEY_2',
        label: 'Secondary Project Key',
        placeholder: 'AIza...',
        secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    description: 'Fast tool-capable inference with two optional organizations for separate quotas.',
    category: 'ai',
    docsUrl: 'https://console.groq.com',
    envVars: [
      {
        key: 'GROQ_API_KEY',
        label: 'Primary API Key',
        placeholder: 'gsk_...',
        secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://api.groq.com/openai/v1' },
      },
      {
        key: 'GROQ_API_KEY_2',
        label: 'Secondary Org Key',
        placeholder: 'gsk_...',
        secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://api.groq.com/openai/v1' },
      },
    ],
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    description: 'Tool-capable inference fallback.',
    category: 'ai',
    docsUrl: 'https://cloud.sambanova.ai',
    envVars: [
      {
        key: 'SAMBANOVA_API_KEY',
        label: 'API Key',
        placeholder: 'SambaNova API key',
        secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://api.sambanova.ai/v1' },
      },
    ],
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Inference Providers fallback through the OpenAI-compatible router.',
    category: 'ai',
    docsUrl: 'https://huggingface.co/settings/tokens',
    envVars: [
      {
        key: 'HF_TOKEN',
        label: 'Access Token',
        placeholder: 'hf_...',
        secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://router.huggingface.co/v1' },
      },
    ],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    description: 'Demoted recovery-tier provider kept available for zero-code-change fallback.',
    category: 'ai',
    docsUrl: 'https://build.nvidia.com',
    envVars: [
      {
        key: 'NVIDIA_API_KEY',
        label: 'API Key',
        placeholder: 'nvapi-...',
        secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://integrate.api.nvidia.com/v1' },
      },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Bounded paid fallback plus last-resort free routing.',
    category: 'ai',
    docsUrl: 'https://openrouter.ai/settings/keys',
    envVars: [
      {
        key: 'OPENROUTER_API_KEY',
        label: 'API Key',
        placeholder: 'sk-or-v1-...',
        secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://openrouter.ai/api/v1', extraHeaders: OPENROUTER_HEADERS },
      },
    ],
  },
  {
    id: 'openai-embeddings',
    name: 'OpenAI Embeddings',
    description: 'Optional remote embedding provider; APEX falls back to local embeddings when unset.',
    category: 'ai',
    docsUrl: 'https://platform.openai.com/api-keys',
    envVars: [
      {
        key: 'OPENAI_API_KEY',
        label: 'API Key',
        placeholder: 'sk-...',
        secret: true,
        probe: { kind: 'openai-models', baseUrl: 'https://api.openai.com/v1' },
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
    id: 'vapi',
    name: 'Vapi',
    description: 'Outbound AI phone calls for the Sales agent.',
    category: 'voice',
    docsUrl: 'https://dashboard.vapi.ai',
    envVars: [
      { key: 'VAPI_API_KEY', label: 'Private API Key', placeholder: 'Vapi private key', secret: true },
      { key: 'VAPI_PHONE_NUMBER_ID', label: 'Phone Number ID', placeholder: 'Vapi phone number ID' },
      { key: 'VAPI_WEBHOOK_SECRET', label: 'Webhook Secret', placeholder: 'Optional webhook secret', secret: true },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repository access used by the autonomous engineering PR loop.',
    category: 'dev',
    docsUrl: 'https://github.com/settings/tokens',
    envVars: [
      { key: 'GITHUB_TOKEN', label: 'Personal Access Token', placeholder: 'github_pat_... or ghp_...', secret: true },
    ],
  },
  {
    id: 'buildmybot',
    name: 'BuildMyBot Connector',
    description: 'Credentials and endpoints APEX uses to operate BuildMyBot.App as a managed project.',
    category: 'data',
    envVars: [
      { key: 'BUILDMYBOT_SUPABASE_URL', label: 'Supabase URL', placeholder: 'https://xxx.supabase.co' },
      { key: 'BUILDMYBOT_SUPABASE_SERVICE_KEY', label: 'Supabase Service Key', placeholder: 'service_role key', secret: true },
      { key: 'BUILDMYBOT_APP_URL', label: 'Application URL', placeholder: 'https://www.buildmybot.app' },
      { key: 'BUILDMYBOT_CRON_SECRET', label: 'Cron Secret', placeholder: 'cron secret', secret: true },
      { key: 'BUILDMYBOT_VERCEL_DEPLOY_HOOK', label: 'Deploy Hook', placeholder: 'https://api.vercel.com/v1/integrations/deploy/...' , secret: true },
    ],
  },
  {
    id: 'casebuddy',
    name: 'CaseBuddy Connector',
    description: 'Credentials APEX uses to supervise the CaseBuddy platform.',
    category: 'data',
    envVars: [
      { key: 'CASEBUDDY_SUPABASE_URL', label: 'Supabase URL', placeholder: 'https://xxx.supabase.co' },
      { key: 'CASEBUDDY_SUPABASE_SERVICE_KEY', label: 'Supabase Service Key', placeholder: 'service_role key', secret: true },
      { key: 'CASEBUDDY_SYSTEM_USER_ID', label: 'System User ID', placeholder: 'UUID' },
    ],
  },
  {
    id: 'tubescribe',
    name: 'TubeScribe Connector',
    description: 'Read-only monitoring credentials for TubeScribe.',
    category: 'data',
    envVars: [
      { key: 'TUBESCRIBE_SUPABASE_URL', label: 'Supabase URL', placeholder: 'https://xxx.supabase.co' },
      { key: 'TUBESCRIBE_SUPABASE_SERVICE_KEY', label: 'Supabase Service Key', placeholder: 'service_role key', secret: true },
      { key: 'TUBESCRIBE_WORKER_URL', label: 'Worker URL', placeholder: 'https://worker.example.com' },
    ],
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Payment processing used by sales-call checkout workflows.',
    category: 'business',
    docsUrl: 'https://dashboard.stripe.com/apikeys',
    envVars: [
      { key: 'STRIPE_SECRET_KEY', label: 'Secret Key', placeholder: 'sk_live_... or sk_test_...', secret: true },
    ],
  },
];

const EXCLUDED_RUNTIME_KEYS = new Set(['APEX_APPROVAL_MODE']);

function getIntegrationCatalog(): IntegrationDefinition[] {
  const catalog = BASE_INTEGRATION_CATALOG.map((item) => ({
    ...item,
    envVars: item.envVars.map((envVar) => ({ ...envVar })),
  }));

  // Safety net: if the runtime adds a new LLM/provider key before the UI
  // metadata is updated, expose it generically instead of silently rejecting
  // it. This keeps the backend runtime allowlist and Settings write path from
  // drifting apart again.
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

  if (!field.probe) {
    return {
      key,
      status: 'configured',
      detail: 'Stored and applied to the running process. This integration does not have a non-destructive live probe yet.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const baseUrl = field.probe.baseUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${value}`,
        ...(field.probe.extraHeaders ?? {}),
      },
      signal: controller.signal,
    });

    if (response.ok) {
      return { key, status: 'connected', detail: 'Provider accepted the credential.', httpStatus: response.status };
    }
    if (response.status === 401 || response.status === 403) {
      return { key, status: 'invalid_key', detail: 'Provider rejected the credential.', httpStatus: response.status };
    }
    if (response.status === 402) {
      return { key, status: 'billing_required', detail: 'Credential is recognized, but the provider requires billing/account funding.', httpStatus: response.status };
    }
    if (response.status === 429) {
      return { key, status: 'rate_limited', detail: 'Credential reached the provider, but the account is currently rate/quota limited.', httpStatus: response.status };
    }
    if (response.status === 404 || response.status === 405) {
      return {
        key,
        status: 'configured',
        detail: 'Credential is stored; this provider does not expose the lightweight model-list probe used by APEX.',
        httpStatus: response.status,
      };
    }
    return {
      key,
      status: 'degraded',
      detail: `Provider probe returned HTTP ${response.status}.`,
      httpStatus: response.status,
    };
  } catch (err) {
    const detail = err instanceof Error && err.name === 'AbortError'
      ? 'Provider probe timed out after 10 seconds.'
      : `Provider probe failed: ${err instanceof Error ? err.message : String(err)}`;
    return { key, status: 'degraded', detail };
  } finally {
    clearTimeout(timeout);
  }
}

/** Integration Settings API — server-side persistence for dashboard credentials. */
export function createSettingsRouter(): Router {
  const router = Router();

  // GET /api/settings/integrations — status + backend-owned catalog. Plaintext
  // secret values are never returned.
  router.get('/integrations', async (_req, res) => {
    try {
      const catalog = getIntegrationCatalog();
      const flatStatus = catalog
        .flatMap((item) => item.envVars)
        .map((envVar) => ({ key: envVar.key, configured: Boolean(process.env[envVar.key]) }));

      res.json({
        integrations: flatStatus,
        catalog: catalog.map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          category: item.category,
          docsUrl: item.docsUrl,
          envVars: item.envVars.map((envVar) => ({
            key: envVar.key,
            label: envVar.label,
            placeholder: envVar.placeholder,
            secret: envVar.secret ?? false,
            configured: Boolean(process.env[envVar.key]),
            probeable: Boolean(envVar.probe),
          })),
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/settings/integrations { key, value }
  router.post('/integrations', async (req, res) => {
    try {
      const { key, value } = req.body ?? {};
      if (typeof key !== 'string' || typeof value !== 'string' || !value.trim()) {
        res.status(400).json({ error: 'key and non-empty value are required' });
        return;
      }
      const allowedKeys = getAllowedKeys();
      if (!allowedKeys.has(key)) {
        res.status(400).json({ error: `Unknown integration key '${key}'` });
        return;
      }

      await db
        .insert(integrationSettings)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: integrationSettings.key,
          set: { value, updatedAt: new Date() },
        });

      // Apply immediately so the current process picks it up without waiting
      // for a restart/redeploy.
      process.env[key] = value;

      res.json({ ok: true, key, configured: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/settings/integrations/probe { key } — non-destructive credential
  // verification. Provider probes never return or log the secret value.
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

  // DELETE /api/settings/integrations/:key — clears the DB override and the
  // value in this running process. A platform-level value will return after a
  // process restart if the host injects it again.
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

  // POST /api/settings/recover-workforce
  // Requeue ONLY provider-capacity/auth failures. Do not replay arbitrary
  // failed work: this control is deliberately narrow so a user can restore
  // provider capacity without accidentally rerunning a destructive failure.
  router.post('/recover-workforce', async (_req, res) => {
    try {
      const providerFailurePredicate = or(
        ilike(tasks.errorMessage, '%All LLM providers failed%'),
        ilike(tasks.errorMessage, '%LLM provider%failed%'),
        ilike(tasks.errorMessage, '%providers exhausted%'),
      );

      const candidates = await db
        .select({ id: tasks.id, assignedAgentId: tasks.assignedAgentId })
        .from(tasks)
        .where(and(
          eq(tasks.status, 'failed'),
          sql`${tasks.retryCount} < ${tasks.maxRetries}`,
          providerFailurePredicate,
        ))
        .limit(100);

      // Recover in bounded batches to avoid releasing a huge historical
      // backlog into freshly restored provider capacity all at once.
      const batch = candidates.slice(0, 25);
      const now = new Date();
      for (const task of batch) {
        await db
          .update(tasks)
          .set({
            status: 'pending',
            leasedAt: null,
            nextRetryAt: new Date(now.getTime() + 1_000),
            errorMessage: null,
            updatedAt: now,
          })
          .where(and(eq(tasks.id, task.id), eq(tasks.status, 'failed')));
      }

      const affectedAgentIds = [...new Set(batch.map((task) => task.assignedAgentId).filter((id): id is string => Boolean(id)))];
      let resetAgentRows = 0;
      if (affectedAgentIds.length > 0) {
        const resetRows = await db
          .update(agents)
          .set({ status: 'idle', lastActiveAt: now })
          .where(and(eq(agents.status, 'error'), inArray(agents.id, affectedAgentIds)))
          .returning({ id: agents.id });
        resetAgentRows = resetRows.length;
      }

      res.json({
        ok: true,
        recoveredTasks: batch.length,
        resetAgentRows,
        skippedTasks: Math.max(0, candidates.length - batch.length),
        note: batch.length > 0
          ? 'Provider-failure tasks were requeued in a bounded batch. Live agent status will clear as the autonomous loops pick up work.'
          : 'No retryable provider-failure tasks were found.',
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── System Settings (autonomy, behavior dials) ──────────────────────────
  // Stored in integration_settings with 'system:' prefix — no schema change
  // needed (key is a text column, value is text). Applied at runtime for
  // immediate effect.

  const AUTONOMY_PRESETS: Record<string, { cron: string; label: string }> = {
    conservative: { cron: '*/30 * * * *', label: 'Conservative — goal review every 30 min, lower throughput' },
    balanced: { cron: '*/15 * * * *', label: 'Balanced — goal review every 15 min (default)' },
    aggressive: { cron: '*/10 * * * *', label: 'Aggressive — goal review every 10 min, max throughput' },
  };

  // GET /api/settings/system — current system-level settings
  router.get('/system', async (_req, res) => {
    try {
      const rows = await db.select().from(integrationSettings);
      const systemRows = rows.filter((r) => r.key.startsWith('system:'));
      const settings: Record<string, string> = {};
      for (const r of systemRows) {
        settings[r.key.replace('system:', '')] = r.value;
      }
      if (!settings.autonomy_level) {
        settings.autonomy_level = 'balanced';
      }
      res.json({ settings });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PUT /api/settings/system — update system-level settings
  router.put('/system', async (req, res) => {
    try {
      const { autonomy_level } = req.body ?? {};
      const updates: Array<{ key: string; value: string }> = [];

      if (autonomy_level && AUTONOMY_PRESETS[autonomy_level]) {
        updates.push({ key: 'system:autonomy_level', value: autonomy_level });

        const newCron = AUTONOMY_PRESETS[autonomy_level].cron;
        const { scheduledJobs } = await import('@workspace/db');
        const [reviewJob] = await db.select().from(scheduledJobs)
          .where(eq(scheduledJobs.id, 'system-ceo-goal-review')).limit(1);
        if (reviewJob) {
          const nextRunAt = CronParser.nextRun(newCron, new Date()) ?? new Date(Date.now() + 60_000);
          await db.update(scheduledJobs).set({
            cronExpression: newCron,
            nextRunAt,
            status: 'active',
            retryCount: 0,
          }).where(eq(scheduledJobs.id, 'system-ceo-goal-review'));
        }
      }

      for (const { key, value } of updates) {
        await db.insert(integrationSettings)
          .values({ key, value, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: integrationSettings.key,
            set: { value, updatedAt: new Date() },
          });
      }

      res.json({ ok: true, updated: updates });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
