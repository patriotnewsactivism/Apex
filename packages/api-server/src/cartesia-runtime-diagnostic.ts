const CARTESIA_VERSION = '2026-08-14';
const CARTESIA_API = 'https://api.cartesia.ai';
const EXPECTED_SALES_TOOLS = [
  'lookup_lead_info_v2',
  'capture_and_qualify_lead',
  'check_calendar_availability',
  'book_consultation',
  'send_demo_link',
  'record_call_outcome_v2',
] as const;
const EVENT_WEBHOOK_URL = 'https://apex.donmatthews.live/api/cartesia/events';

type CartesiaList<T> = {
  data?: T[];
};

type CartesiaAgentSummary = {
  id?: string;
  name?: string;
  description?: string | null;
};

type CartesiaToolSummary = {
  id?: string;
  name?: string;
};

type CartesiaWebhookSummary = {
  id?: string;
  url?: string;
  display_name?: string | null;
};

async function cartesiaGet<T>(path: string, apiKey: string): Promise<T> {
  const response = await fetch(`${CARTESIA_API}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Cartesia-Version': CARTESIA_VERSION,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(6_000),
  });

  if (!response.ok) {
    // Intentionally do not include response bodies here. Vendor error bodies can
    // echo request details, and this diagnostic must never leak credentials.
    throw new Error(`Cartesia returned HTTP ${response.status}`);
  }

  return await response.json() as T;
}

/**
 * Read-only Cartesia startup diagnostic.
 *
 * Railway protects secret values from external operator tooling, so the running
 * APEX process is the right place to verify that CARTESIA_API_KEY actually
 * authenticates. This function never creates, updates, or deletes Cartesia
 * resources and never logs the API key or webhook/tool secrets.
 */
export async function diagnoseCartesiaRuntime(): Promise<void> {
  const apiKey = process.env.CARTESIA_API_KEY?.trim();
  if (!apiKey) {
    console.warn('[cartesia] Runtime diagnostic skipped: CARTESIA_API_KEY is not configured');
    return;
  }

  try {
    const [agentPage, toolPage, webhookPage] = await Promise.all([
      cartesiaGet<CartesiaList<CartesiaAgentSummary>>('/v1/agents?limit=100', apiKey),
      cartesiaGet<CartesiaList<CartesiaToolSummary>>('/v1/agents/tools?limit=100', apiKey),
      cartesiaGet<CartesiaList<CartesiaWebhookSummary>>('/agents/webhooks?limit=100', apiKey),
    ]);

    const agents = agentPage.data ?? [];
    const tools = toolPage.data ?? [];
    const webhooks = webhookPage.data ?? [];

    const salesAgents = agents.filter((agent) => {
      const haystack = `${agent.name ?? ''} ${agent.description ?? ''}`.toLowerCase();
      return haystack.includes('apex') || haystack.includes('alex') || haystack.includes('buildmybot');
    });
    const presentToolNames = new Set(tools.map((tool) => tool.name).filter(Boolean));
    const presentSalesTools = EXPECTED_SALES_TOOLS.filter((name) => presentToolNames.has(name));
    const eventWebhook = webhooks.find((webhook) => webhook.url === EVENT_WEBHOOK_URL);

    console.log(
      `[cartesia] API authentication succeeded; agents=${agents.length}; sales-agent-matches=${salesAgents.length}; ` +
      `sales-tools=${presentSalesTools.length}/${EXPECTED_SALES_TOOLS.length}; event-webhook=${eventWebhook ? 'present' : 'missing'}`,
    );

    if (agents.length > 0) {
      console.log(
        '[cartesia] Agent inventory:',
        agents.map((agent) => `${agent.name ?? 'unnamed'} (${agent.id ?? 'no-id'})`).join(', '),
      );
    }

    if (salesAgents.length > 0) {
      console.log(
        '[cartesia] Matching sales agents:',
        salesAgents.map((agent) => `${agent.name ?? 'unnamed'} (${agent.id ?? 'no-id'})`).join(', '),
      );
    }

    const missingTools = EXPECTED_SALES_TOOLS.filter((name) => !presentToolNames.has(name));
    if (missingTools.length > 0) {
      console.warn('[cartesia] Missing APEX sales tools:', missingTools.join(', '));
    }
    if (!eventWebhook) {
      console.warn('[cartesia] APEX call-event webhook is not registered in Cartesia');
    }
  } catch (err) {
    console.warn(
      '[cartesia] Runtime diagnostic failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
