import {
  APEX_CARTESIA_CALLER_NUMBER,
  CARTESIA_API_VERSION,
  CARTESIA_SALES_AGENT_NAME,
  clearCartesiaSalesResolutionCache,
} from '@workspace/core';

const CARTESIA_API = 'https://api.cartesia.ai';
const TOOL_BASE_URL = 'https://apex.donmatthews.live/api/cartesia';
const EVENT_WEBHOOK_URL = `${TOOL_BASE_URL}/events`;
const EVENT_WEBHOOK_NAME = 'APEX Sales Events';
const DEFAULT_MODEL_ID = process.env.CARTESIA_SALES_MODEL_ID?.trim() || 'gpt-5.4-mini';
const DEFAULT_VOICE_ID =
  process.env.CARTESIA_SALES_VOICE_ID?.trim() || '910fb75e-1d20-4840-ac63-ac6b26a71bdc';
const OWNER_TRANSFER_NUMBER = '+18328804970';

type AgentSummary = { id?: string; name?: string; description?: string | null };
type AgentPage = { data?: AgentSummary[] };
type ToolSummary = { id?: string; name?: string };
type ToolPage = { data?: ToolSummary[] };
type WebhookSummary = { id?: string; url?: string; display_name?: string | null };
type WebhookPage = { data?: WebhookSummary[] };
type PhoneNumberSummary = {
  id?: string;
  number?: string;
  label?: string | null;
  provider?: { type?: string; id?: string; label?: string | null } | null;
};
type PhoneNumberPage = { data?: PhoneNumberSummary[] };

function apiKey(): string {
  const value = process.env.CARTESIA_API_KEY?.trim();
  if (!value) throw new Error('CARTESIA_API_KEY is not configured');
  return value;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${CARTESIA_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Cartesia-Version': CARTESIA_API_VERSION,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(8_000),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof data.message === 'string' ? data.message : `HTTP ${response.status}`;
    throw new Error(`Cartesia ${path} failed: ${message}`);
  }
  return data as T;
}

function dynamic(type: 'string' | 'boolean' | 'number', name: string, description?: string) {
  return {
    type,
    dynamic_variable: name,
    ...(description ? { description } : {}),
  };
}

function modelString(description: string, options?: { enum?: string[] }) {
  return {
    type: 'string',
    description,
    ...(options?.enum ? { enum: options.enum } : {}),
  };
}

function webhookTool(
  name: string,
  endpoint: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  toolSecret: string,
) {
  // Cartesia injects dynamic_variable/constant_value properties at runtime and
  // rejects a tool schema if either kind is also listed in JSON Schema
  // "required". Only LLM-supplied fields belong there.
  const modelRequired = required.filter((key) => {
    const property = properties[key];
    if (!property || typeof property !== 'object') return true;
    const record = property as Record<string, unknown>;
    return !('dynamic_variable' in record) && !('constant_value' in record);
  });

  return {
    type: 'webhook',
    name,
    description,
    pre_tool_speech: 'auto',
    execution_mode: 'immediate',
    response_timeout_secs: 10,
    api_schema: {
      url: `${TOOL_BASE_URL}/tools/${endpoint}`,
      method: 'POST',
      request_body_schema: {
        type: 'object',
        properties,
        ...(modelRequired.length ? { required: modelRequired } : {}),
      },
      authentication: {
        mode: 'bearer',
        token: { type: 'secret', secret_value: toolSecret },
      },
    },
    assignments: [],
  };
}

function desiredTools(toolSecret: string) {
  return [
    webhookTool(
      'lookup_lead_info',
      'lookup-lead',
      'Look up the business or prospect APEX is calling. Use near the start of an outbound call to avoid asking for facts APEX already knows. If do_not_contact is true, apologize briefly, record DNC, and end the call.',
      {
        phone_number: dynamic('string', 'system__called_number'),
      },
      ['phone_number'],
      toolSecret,
    ),
    webhookTool(
      'capture_and_qualify_lead',
      'capture-and-qualify-lead',
      'Save confirmed prospect details and qualification context after the caller has actually provided or confirmed them. Never invent missing fields.',
      {
        call_id: dynamic('string', 'system__conversation_id'),
        phone_number: dynamic('string', 'system__called_number'),
        business_name: modelString('Business name stated or confirmed by the prospect.'),
        prospect_name: modelString('Prospect name, only if stated or confirmed.'),
        prospect_email: modelString('Prospect email, only if stated or confirmed.'),
        interest_track: modelString('Best-fit product interest based on the conversation.', {
          enum: ['voice_bot', 'chat_agent', 'workflow_automation', 'full_stack'],
        }),
        call_or_ticket_volume: modelString('Approximate call or ticket volume if discussed.'),
        current_tech_stack: modelString('Current phone, CRM, chat, or automation stack if discussed.'),
        qualification_notes: modelString('Short factual qualification notes from this call.'),
      },
      ['call_id', 'phone_number', 'business_name', 'interest_track'],
      toolSecret,
    ),
    webhookTool(
      'check_calendar_availability',
      'check-calendar-availability',
      'Check real consultation availability before offering appointment times. Use only resolved calendar dates in the prospect time zone and offer only returned slots.',
      {
        start_date: modelString('First date to check in YYYY-MM-DD format.'),
        end_date: modelString('Last date to check in YYYY-MM-DD format, at most 14 days after start_date.'),
        timezone: modelString('Prospect IANA time zone, such as America/Chicago.'),
        preferred_time_of_day: modelString('Prospect preference.', {
          enum: ['morning', 'afternoon', 'any'],
        }),
      },
      ['start_date', 'end_date', 'timezone', 'preferred_time_of_day'],
      toolSecret,
    ),
    webhookTool(
      'book_consultation',
      'book-consultation',
      'Book a consultation only after the prospect explicitly agrees to a slot returned by check_calendar_availability. Say it is confirmed only when booked is true.',
      {
        call_id: dynamic('string', 'system__conversation_id'),
        phone_number: dynamic('string', 'system__called_number'),
        prospect_name: modelString('Prospect name for the appointment.'),
        prospect_email: modelString('Prospect email for the appointment.'),
        slot_time: modelString('Exact agreed slot in ISO 8601 format with UTC offset.'),
        timezone: modelString('Prospect IANA time zone.'),
        scope_summary: modelString('One-sentence summary of what the prospect wants to discuss.'),
      },
      ['call_id', 'phone_number', 'prospect_name', 'prospect_email', 'slot_time', 'timezone'],
      toolSecret,
    ),
    webhookTool(
      'send_demo_link',
      'send-demo-link',
      'Text a fixed BuildMyBot or APEX link only after the prospect explicitly agrees to receive a text. Never set consent_to_text true without that agreement.',
      {
        call_id: dynamic('string', 'system__conversation_id'),
        phone_number: dynamic('string', 'system__called_number'),
        demo_type: modelString('Which requested link to send.', {
          enum: ['buildmybot_live_demo', 'apex_overview'],
        }),
        consent_to_text: {
          type: 'boolean',
          description: 'Set true only after the prospect explicitly agrees to receive this text.',
          enum: [true],
        },
      },
      ['call_id', 'phone_number', 'demo_type', 'consent_to_text'],
      toolSecret,
    ),
    webhookTool(
      'record_call_outcome',
      'record-outcome',
      'Record the real call disposition before ending the call. Use dnc immediately when the prospect asks not to be contacted again.',
      {
        call_id: dynamic('string', 'system__conversation_id'),
        phone_number: dynamic('string', 'system__called_number'),
        disposition: modelString('Actual disposition of the call.', {
          enum: ['qualified', 'callback_requested', 'not_interested', 'no_decision', 'dnc'],
        }),
        prospect_name: modelString('Prospect name if known.'),
        notes: modelString('Short factual notes about the outcome and any promised next step.'),
      },
      ['call_id', 'phone_number', 'disposition'],
      toolSecret,
    ),
  ];
}

function agentConfig(toolIds: string[]) {
  return {
    instructions: [
      'You are Alex, a clearly identified AI sales assistant for BuildMyBot.app and APEX Work Solutions at apexwork.org.',
      'You make outbound business sales calls. Be natural, concise, and conversational. Ask one question at a time and let the person answer.',
      'The campaign-specific instructions for this exact call are: {{campaign_prompt}}',
      'The customer or prospect name supplied by APEX is {{customer_name}}. Do not assume it is correct if the person tells you otherwise.',
      'Use lookup_lead_info near the start of the call so you do not ask for information APEX already has.',
      'Never invent a price, integration, customer result, guarantee, appointment, case study, or action that a tool did not confirm.',
      'If the person asks not to be contacted, call record_call_outcome with dnc, acknowledge the request, and end the call.',
      'Ask for explicit permission before using send_demo_link. Never claim a text was delivered if the tool says it failed.',
      'Offer only calendar slots returned by check_calendar_availability. Call book_consultation only after the prospect agrees to one. A booking is confirmed only when booked is true.',
      'Before a normal call ends, record the real disposition with record_call_outcome.',
      'If the prospect asks for Matthew or a human, or a human handoff would clearly help, use the transfer tool.',
      'When a tool is slow, briefly say what you are checking and allow interruption. If a tool fails, continue honestly instead of claiming success.',
      'Everything you say is spoken aloud. Use plain spoken prose, no markdown, no JSON, and no stage directions.',
      'Keep most turns to one or two sentences so the call stays responsive.',
    ].join('\n'),
    initial_message: '{{campaign_first_message}}',
    timezone: 'America/Chicago',
    model: {
      id: DEFAULT_MODEL_ID,
      temperature: 0.3,
      max_output_tokens: 220,
    },
    language: { primary: 'en' },
    audio: {
      input: {
        noise_suppression: 'auto',
        keyterms: ['BuildMyBot', 'APEX', 'apexwork.org'],
      },
      output: {
        voice_id: DEFAULT_VOICE_ID,
        speed: 1,
      },
    },
    turn: {
      inactivity_end_call_secs: 120,
      inactivity_check_in_secs: 8,
    },
    tools: toolIds.map((id) => ({ id })),
    system_tools: {
      end_call: {
        description: 'End the call when the conversation is complete, after recording the outcome when appropriate.',
        pre_tool_speech: 'force',
      },
      transfer_to_number: {
        description: 'Transfer the prospect to Matthew when a human handoff is requested or clearly useful.',
        pre_tool_speech: 'auto',
        transfers: [{
          destination: { type: 'phone', phone_number: OWNER_TRANSFER_NUMBER },
          condition: 'The prospect asks to speak with Matthew or a human, or has a qualified question that needs the owner.',
        }],
      },
    },
  };
}

async function reconcileTools(toolSecret: string): Promise<string[]> {
  const page = await request<ToolPage>('/v1/agents/tools?limit=100');
  const existing = page.data ?? [];
  const ids: string[] = [];

  for (const desired of desiredTools(toolSecret)) {
    const matches = existing.filter((tool) => tool.name === desired.name && tool.id);
    if (matches.length > 1) {
      throw new Error(`Multiple Cartesia tools are named ${desired.name}; refusing to guess`);
    }
    if (matches.length === 1) {
      const id = matches[0]!.id!;
      await request(`/v1/agents/tools/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(desired),
      });
      ids.push(id);
      continue;
    }
    const created = await request<{ id?: string }>('/v1/agents/tools', {
      method: 'POST',
      body: JSON.stringify(desired),
    });
    if (!created.id) throw new Error(`Cartesia did not return an id for tool ${desired.name}`);
    ids.push(created.id);
  }

  return ids;
}

async function reconcileWebhook(webhookSecret: string): Promise<string> {
  const page = await request<WebhookPage>('/agents/webhooks?limit=100');
  const matches = (page.data ?? []).filter(
    (webhook) => webhook.url === EVENT_WEBHOOK_URL || webhook.display_name === EVENT_WEBHOOK_NAME,
  );
  if (matches.length > 1) throw new Error('Multiple APEX Cartesia event webhooks exist; refusing to guess');

  if (matches.length === 1) {
    const id = matches[0]!.id;
    if (!id) throw new Error('Existing APEX Cartesia webhook has no id');
    await request(`/agents/webhooks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        url: EVENT_WEBHOOK_URL,
        secret: webhookSecret,
        display_name: EVENT_WEBHOOK_NAME,
      }),
    });
    return id;
  }

  const created = await request<{ id?: string }>('/agents/webhooks', {
    method: 'POST',
    body: JSON.stringify({
      url: EVENT_WEBHOOK_URL,
      secret: webhookSecret,
      display_name: EVENT_WEBHOOK_NAME,
    }),
  });
  if (!created.id) throw new Error('Cartesia did not return an event webhook id');
  return created.id;
}

async function reconcileAgent(toolIds: string[], webhookId: string): Promise<string> {
  const page = await request<AgentPage>('/v1/agents?limit=100');
  const matches = (page.data ?? []).filter(
    (agent) => agent.name === CARTESIA_SALES_AGENT_NAME && agent.id,
  );
  if (matches.length > 1) {
    throw new Error(`Multiple Cartesia agents are named "${CARTESIA_SALES_AGENT_NAME}"; refusing to guess`);
  }

  let agentId: string;
  if (matches.length === 0) {
    const created = await request<{ id?: string }>('/v1/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: CARTESIA_SALES_AGENT_NAME,
        config: agentConfig(toolIds),
      }),
    });
    if (!created.id) throw new Error('Cartesia did not return the canonical sales agent id');
    agentId = created.id;
    console.log(`[cartesia-sales] Created canonical sales agent ${agentId}`);
  } else {
    agentId = matches[0]!.id!;
    await request(`/v1/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        config: agentConfig(toolIds),
        version_description: 'Reconcile APEX canonical outbound sales configuration',
      }),
    });
  }

  await request(`/agents/${encodeURIComponent(agentId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ webhook_id: webhookId }),
  });
  return agentId;
}

async function inspectApprovedOutboundNumber(): Promise<{ id: string | null; providerType: string | null }> {
  const digits = APEX_CARTESIA_CALLER_NUMBER.replace(/\D/g, '');
  const page = await request<PhoneNumberPage>(
    `/agents/phone-numbers?q=${encodeURIComponent(digits)}&limit=100`,
  );
  const matches = (page.data ?? []).filter((phone) => phone.number === APEX_CARTESIA_CALLER_NUMBER && phone.id);
  if (matches.length !== 1) return { id: null, providerType: null };
  return {
    id: matches[0]!.id!,
    providerType: matches[0]!.provider?.type ?? null,
  };
}

export async function reconcileCartesiaSalesAgent(): Promise<void> {
  const key = process.env.CARTESIA_API_KEY?.trim();
  const toolSecret = process.env.CARTESIA_TOOL_SECRET?.trim();
  const webhookSecret = process.env.CARTESIA_WEBHOOK_SECRET?.trim();
  if (!key || !toolSecret || !webhookSecret) {
    console.warn('[cartesia-sales] Reconciliation skipped: API key/tool secret/webhook secret must all be configured');
    return;
  }

  try {
    const toolIds = await reconcileTools(toolSecret);
    const webhookId = await reconcileWebhook(webhookSecret);
    const agentId = await reconcileAgent(toolIds, webhookId);
    clearCartesiaSalesResolutionCache();

    const outbound = await inspectApprovedOutboundNumber();
    if (!outbound.id) {
      console.error(
        `[cartesia-sales] Canonical agent ready (${agentId}), but approved caller ID ${APEX_CARTESIA_CALLER_NUMBER} is not connected to Cartesia. Outbound calls will fail closed.`,
      );
    } else {
      console.log(
        `[cartesia-sales] Canonical outbound ready: agent=${agentId}; tools=${toolIds.length}/6; webhook=${webhookId}; caller=${APEX_CARTESIA_CALLER_NUMBER}; numberId=${outbound.id}; telephony=${outbound.providerType ?? 'unknown'}`,
      );
    }
  } catch (err) {
    console.error(
      '[cartesia-sales] Reconciliation failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
