import {
  APEX_CARTESIA_CALLER_NUMBER,
  CARTESIA_API_VERSION,
  CARTESIA_SALES_AGENT_NAME,
  clearCartesiaSalesResolutionCache,
  resolveCartesiaSalesVoiceId,
} from '@workspace/core';

const CARTESIA_API = 'https://api.cartesia.ai';
const TOOL_BASE_URL = 'https://apex.donmatthews.live/api/cartesia';
const EVENT_WEBHOOK_URL = `${TOOL_BASE_URL}/events`;
const EVENT_WEBHOOK_NAME = 'APEX Sales Events';
const DEFAULT_MODEL_ID = process.env.CARTESIA_SALES_MODEL_ID?.trim() || 'gpt-5.4-mini';
const OWNER_TRANSFER_NUMBER = '+18328804970';

type AgentSummary = { id?: string; name?: string; description?: string | null };
type AgentPage = { data?: AgentSummary[] };
type ToolSummary = { id?: string; name?: string };
type ToolPage = { data?: ToolSummary[] };
type WebhookSummary = { id?: string; url?: string; display_name?: string | null };
type WebhookPage = { data?: WebhookSummary[] };
type ProviderSummary = { id?: string; type?: string; label?: string | null };

type PhoneNumberSummary = {
  id?: string;
  number?: string;
  label?: string | null;
  provider?: { type?: string; id?: string; label?: string | null } | null;
};
type PhoneNumberPage = { data?: PhoneNumberSummary[]; has_more?: boolean };

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
      'lookup_lead_info_v2',
      'lookup-lead',
      'Retrieve CRM context when needed. Answer short replies such as yes immediately. If do_not_contact is true, end politely without pitching or recording a new opt-out.',
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
      'record_call_outcome_v2',
      'record-outcome',
      'Record the real call outcome. Use dnc only after a clear request to stop contact, and include the exact spoken opt-out words in opt_out_quote. A yes, no, or not interested is not an opt-out.',
      {
        call_id: dynamic('string', 'system__conversation_id'),
        phone_number: dynamic('string', 'system__called_number'),
        disposition: modelString('Actual disposition of the call.', {
          enum: ['qualified', 'callback_requested', 'not_interested', 'no_decision', 'dnc'],
        }),
        prospect_name: modelString('Prospect name if known.'),
        notes: modelString('Short factual notes about the outcome and any promised next step.'),
        opt_out_quote: modelString('Exact prospect words requesting no further contact, required for dnc only.'),
      },
      ['call_id', 'phone_number', 'disposition'],
      toolSecret,
    ),
  ];
}

function agentConfig(toolIds: string[], voiceId: string) {
  return {
    instructions: [
      'You are Alex, a clearly identified AI sales assistant for BuildMyBot.app and APEX Work Solutions at apexwork.org.',
      'You make outbound business sales calls. Be natural, concise, and conversational. Ask one question at a time and let the person answer.',
      'The campaign-specific instructions for this exact call are: {{campaign_prompt}}',
      'The customer or prospect name supplied by APEX is {{customer_name}}. Do not assume it is correct if the person tells you otherwise.',
      'Start speaking the configured initial message when the answered outbound call connects. Do not wait for a second hello or run a CRM lookup before the opening.',
      'If the person says yes, yep, yeah, sure, or okay to your opening question, continue the pitch immediately: explain the value in one sentence and ask one relevant question. Do not call a tool first.',
      'Use lookup_lead_info_v2 only if you need additional CRM context. A normal affirmative answer is not an opt-out.',
      'Never invent a price, integration, customer result, guarantee, appointment, case study, or action that a tool did not confirm.',
      'Only a clear request to stop future calls or messages is an opt-out. Never infer DNC from yes, no, silence, a short reply, or declining the offer. If unclear, ask one brief clarifying question.',
      'On an explicit opt-out, call record_call_outcome_v2 with dnc and opt_out_quote containing the exact spoken words; acknowledge it and end. If CRM lookup reports do_not_contact, end politely without writing a new DNC.',
      'Ask for explicit permission before using send_demo_link. Never claim a text was delivered if the tool says it failed.',
      'Offer only calendar slots returned by check_calendar_availability. Call book_consultation only after the prospect agrees to one. A booking is confirmed only when booked is true.',
      'Before a normal call ends, record the real disposition with record_call_outcome_v2.',
      'If the prospect asks for Matthew or a human, or a human handoff would clearly help, use the transfer tool.',
      'When a tool is slow, briefly say what you are checking and allow interruption. If a tool fails, continue honestly instead of claiming success.',
      'Everything you say is spoken aloud. Use plain spoken prose, no markdown, no JSON, and no stage directions.',
      'Keep most turns to one or two sentences so the call stays responsive.',
    ].join('\n'),
    // Cartesia speaks this prewritten opening on call connect; it does not wait for an LLM turn.
    initial_message: '{{campaign_first_message}}',
    timezone: 'America/Chicago',
    model: {
      id: DEFAULT_MODEL_ID,
      temperature: 0.3,
      max_output_tokens: 160,
    },
    language: { primary: 'en' },
    audio: {
      input: {
        noise_suppression: 'auto',
        keyterms: ['BuildMyBot', 'APEX', 'apexwork.org'],
      },
      output: {
        voice_id: voiceId,
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
        description: 'End only after a clear goodbye, explicit opt-out, or completed conversation. A short yes or pause is not a goodbye.',
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
      // Cartesia currently rejects PATCH for these already-created webhook
      // tools even when write-only authentication is omitted. Treat an exact
      // unique tool name as immutable/reusable at startup. Tool-schema changes
      // must be shipped as an explicit migration/versioned tool name rather
      // than blocking every process restart on a provider PATCH limitation.
      ids.push(matches[0]!.id!);
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

async function reconcileAgent(toolIds: string[], webhookId: string, voiceId: string): Promise<string> {
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
        config: agentConfig(toolIds, voiceId),
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
        config: agentConfig(toolIds, voiceId),
      }),
    });
  }

  await request(`/agents/${encodeURIComponent(agentId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ webhook_id: webhookId }),
  });
  return agentId;
}

async function listApprovedOutboundNumber(): Promise<PhoneNumberSummary | null> {
  // Cartesia's managed phone-number API is /agents/phone-numbers. Search by
  // digits so we see an imported number even when no inbound agent is assigned.
  const digits = APEX_CARTESIA_CALLER_NUMBER.replace(/\D/g, '');
  const page = await request<PhoneNumberPage>(
    `/agents/phone-numbers?q=${encodeURIComponent(digits)}&limit=100`,
  );
  if (page.has_more) throw new Error('Cartesia phone-number search was truncated; refusing to guess');
  const matches = (page.data ?? []).filter(
    (phone) => phone.number?.replace(/\D/g, '') === digits && phone.id,
  );
  if (matches.length > 1) {
    throw new Error(
      `Approved caller ID ${APEX_CARTESIA_CALLER_NUMBER} appears more than once in Cartesia; refusing to guess`,
    );
  }
  return matches[0] ?? null;
}

async function resolveTelnyxSipTrunkProvider(): Promise<string> {
  // Cartesia accepts Twilio and SIP trunk providers. Telnyx must be connected
  // as a SIP trunk with outbound routing already configured at both ends;
  // a Telnyx Call Control API key is not a Cartesia telephony provider.
  const providers = await request<ProviderSummary[]>('/agents/phone-numbers/providers');
  const configuredId = process.env.CARTESIA_SIP_TRUNK_PROVIDER_ID?.trim();
  const matches = providers.filter(
    (provider) => provider.type === 'sip_trunk' && provider.id &&
      (!configuredId || provider.id === configuredId),
  );
  if (matches.length !== 1) {
    throw new Error(
      configuredId
        ? `Configured Cartesia SIP trunk provider ${configuredId} is missing or ambiguous`
        : matches.length === 0
          ? 'No SIP trunk provider is connected in Cartesia; configure Telnyx outbound SIP routing before importing the APEX caller ID'
          : 'Multiple Cartesia SIP trunk providers exist; set CARTESIA_SIP_TRUNK_PROVIDER_ID to the Telnyx trunk',
    );
  }
  return matches[0]!.id!;
}

async function reconcileApprovedOutboundNumber(): Promise<{ id: string; providerType: string }> {
  let phone = await listApprovedOutboundNumber();

  if (!phone) {
    const providerId = await resolveTelnyxSipTrunkProvider();
    phone = await request<PhoneNumberSummary>('/agents/phone-numbers', {
      method: 'POST',
      body: JSON.stringify({
        label: 'APEX approved outbound caller ID',
        number: APEX_CARTESIA_CALLER_NUMBER,
        provider: { id: providerId },
      }),
    });
    if (!phone.id) throw new Error('Cartesia imported the approved caller ID but returned no phone-number id');
    console.log(`[cartesia-sales] Imported approved caller ID ${APEX_CARTESIA_CALLER_NUMBER} as ${phone.id}`);
  }

  if (!phone.id) throw new Error('Approved Cartesia phone number has no id');
  if (phone.provider?.type !== 'sip_trunk') {
    throw new Error('Approved Cartesia caller ID is not connected through the Telnyx SIP trunk');
  }
  // Outbound calls pass from_number_id. Assigning an agent here would also
  // redirect inbound calls on this number, which APEX has not requested.
  return { id: phone.id, providerType: 'sip_trunk' };
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
    const voiceId = await resolveCartesiaSalesVoiceId();
    const toolIds = await reconcileTools(toolSecret);
    const webhookId = await reconcileWebhook(webhookSecret);
    const agentId = await reconcileAgent(toolIds, webhookId, voiceId);
    clearCartesiaSalesResolutionCache();

    const outbound = await reconcileApprovedOutboundNumber();
    clearCartesiaSalesResolutionCache();

    console.log(
      `[cartesia-sales] Canonical outbound ready: agent=${agentId}; tools=${toolIds.length}/6; webhook=${webhookId}; caller=${APEX_CARTESIA_CALLER_NUMBER}; numberId=${outbound.id}; telephony=${outbound.providerType}; voice=Don Matthews (${voiceId})`,
    );
  } catch (err) {
    console.error(
      '[cartesia-sales] Reconciliation failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
