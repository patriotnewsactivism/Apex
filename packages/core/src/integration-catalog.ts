/**
 * integration-catalog.ts — THE single source of truth for what APEX supports.
 *
 * Before this file existed, the Settings allowlist and the dashboard's
 * provider list were two independent hard-coded lists that silently drifted:
 * the UI offered keys (DeepSeek, Cerebras, Cohere, Poolside, Qwen, GitHub,
 * Resend, Slack, Supabase) that the server's `getKnownApiKeyEnvs()` had never
 * heard of, so saving them 400'd with "Unknown integration key", while
 * providers already removed from the runtime chain stayed in the UI as valid.
 *
 * Both halves now derive from this one catalog:
 *   - LLM keys are derived from `listLLMProviderEntries()` (the live provider
 *     chain in llm-client.ts), so a provider added to or removed from the
 *     runtime is automatically added to or removed from the Settings surface
 *     and the save allowlist.
 *   - Non-LLM integrations are declared here once, in one place, and are
 *     marked `active` (wired into the runtime) or `disabled` (key exists in
 *     the wild but is not consumed by any APEX code path yet).
 *
 * `getKnownApiKeyEnvs()` returns the flat allowlist the settings route uses.
 * It is derived from the active entries here — there is no second list left
 * to drift.
 */

import { listLLMProviderEntries } from './llm-client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type IntegrationCategory = 'ai' | 'comms' | 'dev' | 'data';
export type IntegrationState = 'active' | 'disabled';

export interface IntegrationEnvSpec {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
}

export interface IntegrationSpec {
  id: string;
  name: string;
  description: string;
  category: IntegrationCategory;
  docsUrl?: string;
  state: IntegrationState;
  /** Human-readable reason this entry is disabled (rendered as a badge). */
  stateReason?: string;
  envVars: IntegrationEnvSpec[];
}

export type ProbeVerdict =
  | 'connected'
  | 'rate_limited'
  | 'invalid_key'
  | 'billing_required'
  | 'error'
  | 'not_probed';

export interface ProbeResult {
  status: ProbeVerdict;
  httpStatus?: number;
  detail?: string;
}

// ─── LLM provider display metadata (keyed by apiKeyEnv) ──────────────────────
//
// LLM *keys* come from the live chain; this map only supplies the human-facing
// label/description/docs URL so the dashboard can render them. A provider that
// is removed from the chain will disappear even if its entry lingers here.

interface LLMDisplay {
  id: string;
  name: string;
  description: string;
  docsUrl?: string;
  placeholder?: string;
}

const LLM_DISPLAY: Record<string, LLMDisplay> = {
  OPENROUTER_API_KEY: {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Free dynamic router plus optional metered Claude Sonnet fallback',
    docsUrl: 'https://openrouter.ai/keys',
    placeholder: 'sk-or-…',
  },
  MISTRAL_API_KEY: {
    id: 'mistral',
    name: 'Mistral',
    description: 'La Plateforme — 1B tokens/month free tier, reliable tool calling',
    docsUrl: 'https://console.mistral.ai',
    placeholder: 'Bearer token from console.mistral.ai',
  },
  GEMINI_API_KEY: {
    id: 'google-gemini',
    name: 'Google Gemini',
    description: 'Gemini flash — free 1,500 req/day',
    docsUrl: 'https://aistudio.google.com',
    placeholder: 'AIza…',
  },
  GEMINI_API_KEY_2: {
    id: 'google-gemini-2',
    name: 'Google Gemini (2nd project)',
    description: 'Second Google Cloud project — doubles daily Gemini quota',
    docsUrl: 'https://aistudio.google.com',
    placeholder: 'AIza…',
  },
  GROQ_API_KEY: {
    id: 'groq',
    name: 'Groq',
    description: 'Free tier — 30 RPM / 14,400 RPD, gpt-oss-120b',
    docsUrl: 'https://console.groq.com',
    placeholder: 'gsk_…',
  },
  GROQ_API_KEY_2: {
    id: 'groq-2',
    name: 'Groq (2nd org)',
    description: 'Second Groq org — doubles daily token capacity',
    docsUrl: 'https://console.groq.com',
    placeholder: 'gsk_…',
  },
  SAMBANOVA_API_KEY: {
    id: 'sambanova',
    name: 'SambaNova',
    description: 'gpt-oss-120b on SambaNova RDU hardware',
    docsUrl: 'https://cloud.sambanova.ai',
    placeholder: 'sn-…',
  },
  HF_TOKEN: {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Inference Providers — free inference credits (Llama 3.3 70B)',
    docsUrl: 'https://huggingface.co/settings/tokens',
    placeholder: 'hf_…',
  },
  NVIDIA_API_KEY: {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    description: 'Demoted free tier — Nemotron 3 Nano',
    docsUrl: 'https://build.nvidia.com',
    placeholder: 'nvapi-…',
  },
};

function buildLLMEntries(): IntegrationSpec[] {
  const byKey = new Map<string, IntegrationSpec>();
  for (const p of listLLMProviderEntries()) {
    if (byKey.has(p.apiKeyEnv)) continue;
    const meta = LLM_DISPLAY[p.apiKeyEnv];
    byKey.set(p.apiKeyEnv, {
      id: meta?.id ?? p.apiKeyEnv.toLowerCase().replace(/_/g, '-'),
      name: meta?.name ?? p.name,
      description: meta?.description ?? `LLM fallback provider (${p.fallbackModel || 'model'})`,
      category: 'ai',
      docsUrl: meta?.docsUrl,
      state: 'active',
      envVars: [{ key: p.apiKeyEnv, label: 'API Key', placeholder: meta?.placeholder, secret: true }],
    });
  }
  return [...byKey.values()];
}

// ─── Non-LLM integrations ─────────────────────────────────────────────────────
//
// Only keys that are actually consumed by APEX code paths are `active`. Where
// a key is commonly expected but NOT wired into the runtime, the entry is
// `disabled` with a `stateReason` so the dashboard greys it out instead of
// silently presenting it as saveable-and-effective. This is what keeps the
// Settings surface honest.

const NON_LLM_ENTRIES: IntegrationSpec[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repo access for push_to_remote / create_pull_request tools',
    category: 'dev',
    docsUrl: 'https://github.com/settings/tokens',
    state: 'active',
    envVars: [{ key: 'GITHUB_TOKEN_4', label: 'Personal Access Token', placeholder: 'ghp_…', secret: true }],
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Live payment processing used by the Vapi webhook (checkout sessions)',
    category: 'dev',
    docsUrl: 'https://dashboard.stripe.com/apikeys',
    state: 'active',
    envVars: [{ key: 'STRIPE_SECRET_KEY', label: 'Secret Key', placeholder: 'sk_live_…', secret: true }],
  },
  {
    id: 'vapi',
    name: 'Vapi',
    description: 'AI voice agent outbound calling (make_outbound_call tool)',
    category: 'comms',
    docsUrl: 'https://dashboard.vapi.ai',
    state: 'active',
    envVars: [
      { key: 'VAPI_API_KEY', label: 'API Key', placeholder: 'Private key from dashboard.vapi.ai', secret: true },
      { key: 'VAPI_PHONE_NUMBER_ID', label: 'Phone Number ID', placeholder: 'ID of purchased Vapi number' },
    ],
  },
  {
    id: 'tavily',
    name: 'Tavily',
    description: 'Web search API (webSearch tool)',
    category: 'data',
    docsUrl: 'https://app.tavily.com',
    state: 'active',
    envVars: [{ key: 'TAVILY_API_KEY', label: 'API Key', placeholder: 'tvly-…', secret: true }],
  },
  {
    id: 'brave',
    name: 'Brave Search',
    description: 'Web search API (webSearch tool)',
    category: 'data',
    docsUrl: 'https://brave.com/search/api',
    state: 'active',
    envVars: [{ key: 'BRAVE_SEARCH_API_KEY', label: 'API Key', placeholder: 'BSA…', secret: true }],
  },
  {
    id: 'google-places',
    name: 'Google Places',
    description: 'Business directory search (searchBusinessDirectory tool)',
    category: 'data',
    docsUrl: 'https://developers.google.com/maps',
    state: 'active',
    envVars: [{ key: 'GOOGLE_PLACES_API_KEY', label: 'API Key', placeholder: 'AIza…', secret: true }],
  },
  {
    id: 'yelp',
    name: 'Yelp',
    description: 'Business directory search (searchBusinessDirectory tool)',
    category: 'data',
    docsUrl: 'https://www.yelp.com/developers',
    state: 'active',
    envVars: [{ key: 'YELP_API_KEY', label: 'API Key', placeholder: '…', secret: true }],
  },
  {
    id: 'buildmybot',
    name: 'BuildMyBot (Supabase)',
    description: 'Command-and-supervision connector over the BuildMyBot.app workforce',
    category: 'data',
    state: 'active',
    envVars: [
      { key: 'BUILDMYBOT_SUPABASE_URL', label: 'Project URL', placeholder: 'https://xxx.supabase.co' },
      { key: 'BUILDMYBOT_SUPABASE_SERVICE_KEY', label: 'Service Role Key', placeholder: 'eyJ…', secret: true },
      { key: 'BUILDMYBOT_APP_URL', label: 'App URL', placeholder: 'https://www.buildmybot.app' },
      { key: 'BUILDMYBOT_CRON_SECRET', label: 'Cron Secret', placeholder: '…', secret: true },
    ],
  },
  {
    id: 'casebuddy',
    name: 'CaseBuddy (Supabase)',
    description: 'Command-and-supervision connector over the CaseBuddy legal platform',
    category: 'data',
    state: 'active',
    envVars: [
      { key: 'CASEBUDDY_SUPABASE_URL', label: 'Project URL', placeholder: 'https://xxx.supabase.co' },
      { key: 'CASEBUDDY_SUPABASE_SERVICE_KEY', label: 'Service Role Key', placeholder: 'eyJ…', secret: true },
      { key: 'CASEBUDDY_SYSTEM_USER_ID', label: 'System User ID', placeholder: 'user UUID' },
    ],
  },
  {
    id: 'tubescribe',
    name: 'TubeScribe (Supabase)',
    description: 'Read-only monitoring connector over the TubeScribe platform',
    category: 'data',
    state: 'active',
    envVars: [
      { key: 'TUBESCRIBE_SUPABASE_URL', label: 'Project URL', placeholder: 'https://xxx.supabase.co' },
      { key: 'TUBESCRIBE_SUPABASE_SERVICE_KEY', label: 'Service Role Key', placeholder: 'eyJ…', secret: true },
    ],
  },
  {
    id: 'resend',
    name: 'Resend',
    description: 'Transactional email delivery',
    category: 'comms',
    docsUrl: 'https://resend.com/api-keys',
    state: 'disabled',
    stateReason: 'Not wired into the APEX runtime — the key would be saved but never consumed.',
    envVars: [{ key: 'RESEND_API_KEY', label: 'API Key', placeholder: 're_…', secret: true }],
  },
  {
    id: 'slack',
    name: 'Slack Webhook',
    description: 'Send notifications to Slack',
    category: 'comms',
    docsUrl: 'https://api.slack.com/messaging/webhooks',
    state: 'disabled',
    stateReason: 'Not wired into the APEX runtime — no code path reads this key.',
    envVars: [{ key: 'SLACK_NOTIFY_WEBHOOK', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/…' }],
  },
  {
    id: 'supabase',
    name: 'Supabase (general)',
    description: 'Database & auth backend',
    category: 'data',
    docsUrl: 'https://supabase.com/dashboard',
    state: 'disabled',
    stateReason: "APEX's own database uses DATABASE_URL; per-connector Supabase credentials live under BuildMyBot / CaseBuddy / TubeScribe.",
    envVars: [
      { key: 'SUPABASE_URL', label: 'Project URL', placeholder: 'https://xxx.supabase.co' },
      { key: 'SUPABASE_SERVICE_ROLE_KEY', label: 'Service Role Key', placeholder: 'eyJ…', secret: true },
    ],
  },
];

// ─── Catalog + allowlist derivation ───────────────────────────────────────────

export function getIntegrationCatalog(): IntegrationSpec[] {
  return [...buildLLMEntries(), ...NON_LLM_ENTRIES];
}

/** Flat allowlist of every env var the settings route may save/clear. Derived
 * from the active entries of the catalog — no separate hard-coded list. */
export function getKnownApiKeyEnvs(): string[] {
  return getIntegrationCatalog()
    .filter((e) => e.state === 'active')
    .flatMap((e) => e.envVars.map((v) => v.key));
}

export function findIntegrationByKey(
  key: string,
): { integration: IntegrationSpec; envVar: IntegrationEnvSpec } | null {
  for (const integration of getIntegrationCatalog()) {
    const envVar = integration.envVars.find((v) => v.key === key);
    if (envVar) return { integration, envVar };
  }
  return null;
}

// ─── Probe — validate a just-saved key against the real provider ──────────────
//
// After a key is saved (DB write + process.env injection), the settings route
// probes the provider so the dashboard can show Connected / Rate Limited /
// Invalid Key / Billing Required instead of merely "configured". Probing is
// best-effort and never blocks the save: a network failure reports `error`
// with the underlying detail, never a fake "connected".

function classifyHttp(status: number): ProbeVerdict {
  if (status >= 200 && status < 300) return 'connected';
  if (status >= 401 && status <= 403) return 'invalid_key';
  if (status === 402) return 'billing_required';
  if (status === 429) return 'rate_limited';
  return 'error';
}

async function rawFetch(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; text: string } | { status: 'network'; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    return { status: res.status, text };
  } catch (err) {
    return { status: 'network', text: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function probeHttp(url: string, init: RequestInit = {}): Promise<ProbeResult> {
  return rawFetch(url, init).then((r) => {
    if (r.status === 'network') return { status: 'error', detail: r.text };
    return { status: classifyHttp(r.status), httpStatus: r.status };
  });
}

function llmProviderFor(apiKeyEnv: string) {
  return listLLMProviderEntries()
    .filter((p) => p.apiKeyEnv === apiKeyEnv)
    .sort((a, b) => Number(a.paid) - Number(b.paid))[0];
}

async function probeLLM(apiKeyEnv: string, value: string): Promise<ProbeResult> {
  const p = llmProviderFor(apiKeyEnv);
  if (!p) return { status: 'not_probed', detail: `No runtime provider reads ${apiKeyEnv}` };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${value}`,
  };
  if (p.extraHeaders) Object.assign(headers, p.extraHeaders);

  const r = await rawFetch(`${p.baseURL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: p.fallbackModel,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    }),
  });
  if (r.status === 'network') return { status: 'error', detail: r.text };
  return { status: classifyHttp(r.status), httpStatus: r.status };
}

async function probeGooglePlaces(key: string): Promise<ProbeResult> {
  const r = await rawFetch(
    `https://maps.googleapis.com/maps/api/place/textsearch/json?query=test&key=${encodeURIComponent(key)}`,
  );
  if (r.status === 'network') return { status: 'error', detail: r.text };
  if (r.status < 200 || r.status >= 300) return { status: classifyHttp(r.status), httpStatus: r.status };

  try {
    const body = JSON.parse(r.text) as { status?: string; error_message?: string };
    if (body.status === 'REQUEST_DENIED') {
      return {
        status: body.error_message?.toLowerCase().includes('billing') ? 'billing_required' : 'invalid_key',
        httpStatus: r.status,
        detail: body.error_message,
      };
    }
    if (body.status === 'OVER_QUERY_LIMIT') return { status: 'rate_limited', httpStatus: r.status };
    return { status: 'connected', httpStatus: r.status };
  } catch {
    return { status: 'connected', httpStatus: r.status };
  }
}

async function probeSupabase(
  integration: IntegrationSpec,
  envVarKey: string,
  value: string,
): Promise<ProbeResult> {
  if (envVarKey.endsWith('_URL')) {
    const r = await rawFetch(`${value.replace(/\/$/, '')}/auth/v1/health`);
    if (r.status === 'network') return { status: 'error', detail: r.text };
    return { status: classifyHttp(r.status), httpStatus: r.status };
  }

  const urlVar = integration.envVars.find((v) => v.key.endsWith('_URL'));
  const baseUrl = urlVar ? process.env[urlVar.key] : undefined;
  if (!baseUrl) {
    return { status: 'not_probed', detail: `Set ${urlVar?.key ?? 'the project URL'} first to probe the service key` };
  }
  const r = await rawFetch(`${baseUrl.replace(/\/$/, '')}/rest/v1/`, {
    headers: { apikey: value, Authorization: `Bearer ${value}` },
  });
  if (r.status === 'network') return { status: 'error', detail: r.text };
  return { status: classifyHttp(r.status), httpStatus: r.status };
}

export async function probeIntegrationKey(
  integration: IntegrationSpec,
  envVarKey: string,
  value: string,
): Promise<ProbeResult> {
  if (integration.state !== 'active') {
    return { status: 'not_probed', detail: integration.stateReason ?? 'Integration is disabled' };
  }

  switch (integration.id) {
    case 'github':
      return probeHttp('https://api.github.com/user', {
        headers: { Authorization: `token ${value}`, Accept: 'application/vnd.github+json', 'User-Agent': 'apex-settings-probe' },
      });
    case 'stripe':
      return probeHttp('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${value}` } });
    case 'tavily':
      return probeHttp('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: value, query: 'ping', max_results: 1 }),
      });
    case 'brave':
      return probeHttp('https://api.search.brave.com/res/v1/web/search?q=ping&count=1', {
        headers: { 'X-Subscription-Token': value, Accept: 'application/json' },
      });
    case 'google-places':
      return probeGooglePlaces(value);
    case 'yelp':
      return probeHttp('https://api.yelp.com/v3/businesses/search?location=New%20York&limit=1', {
        headers: { Authorization: `Bearer ${value}` },
      });
    case 'vapi':
      return probeHttp('https://api.vapi.ai/call?limit=1', { headers: { Authorization: `Bearer ${value}` } });
    case 'buildmybot':
    case 'casebuddy':
    case 'tubescribe':
      return probeSupabase(integration, envVarKey, value);
    default:
      return probeLLM(envVarKey, value);
  }
}