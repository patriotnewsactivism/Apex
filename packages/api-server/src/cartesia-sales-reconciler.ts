import {
  APEX_CARTESIA_CALLER_NUMBER,
  CARTESIA_API_VERSION,
  CARTESIA_SALES_AGENT_NAME,
  clearCartesiaSalesResolutionCache,
  resolveCartesiaSalesVoiceId,
} from '@workspace/core';
import { cartesiaCredentialMode, cartesiaSalesToolNames, cartesiaToolSecret, cartesiaWebhookSecret } from './cartesia-sales-auth.js';
import { DAN_SALES_CONSTITUTION } from './cartesia-dan-constitution.js';

const CARTESIA_API = 'https://api.cartesia.ai';
const TOOL_BASE_URL = 'https://apex.donmatthews.live/api/cartesia';
const EVENT_WEBHOOK_URL = `${TOOL_BASE_URL}/events`;
const EVENT_WEBHOOK_NAME = 'APEX Sales Events';
const DEFAULT_MODEL_ID = process.env.CARTESIA_SALES_MODEL_ID?.trim() || 'claude-haiku-4.5';
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
  const toolNames = cartesiaSalesToolNames();
  return [
    webhookTool(
      toolNames[0],
      'lookup-lead',
      'Retrieve CRM context when needed. Answer short replies such as yes immediately. If do_not_contact is true, end politely without pitching or recording a new opt-out.',
      {
        phone_number: dynamic('string', 'system__called_number'),
      },
      ['phone_number'],
      toolSecret,
    ),
    webhookTool(
      toolNames[1],
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
      toolNames[2],
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
      toolNames[3],
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
      toolNames[4],
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
      toolNames[5],
      'send-requested-followup-email',
      'Send one follow-up email only after the prospect explicitly asks for an email and confirms the address. This is a one-time requested response, not consent to an email campaign. Never claim it was sent unless the tool returns sent=true.',
      {
        call_id: dynamic('string', 'system__conversation_id'),
        phone_number: dynamic('string', 'system__called_number'),
        prospect_email: modelString('Email address the prospect stated and then confirmed.'),
        prospect_name: modelString('Prospect name if known.'),
        follow_up_type: modelString('Which requested overview to send.', {
          enum: ['buildmybot_overview', 'apex_overview'],
        }),
        requested_by_prospect: {
          type: 'boolean',
          description: 'Set true only when the prospect explicitly asks to receive an email during this call.',
          enum: [true],
        },
      },
      ['call_id', 'phone_number', 'prospect_email', 'follow_up_type', 'requested_by_prospect'],
      toolSecret,
    ),
    webhookTool(
      toolNames[6],
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
  const toolNames = cartesiaSalesToolNames();
  return {
    instructions: [
      DAN_SALES_CONSTITUTION,
      '=== OPERATIONAL RULES (APEX/Cartesia) — MUST FOLLOW ALONGSIDE THE CONSTITUTION ===',
      'You make outbound business sales calls. Sound warm and conversational. Answer as soon as the other person finishes.',
      'ANSWER THE WHOLE TURN: respond to every distinct point they just made — a yes plus a detail, a correction, a second question, and a short reply all count. Do not drop one of them, and do not replace what they said with the next scripted line. Then ask at most one next question.',
      'LANGUAGE LOCK: speak English only for the entire call. Never switch to Spanish or any other language because of an accent, noisy audio, or a transcription guess. If speech is unclear, ask for clarification in English.',
      'VOICE PACING: speak at a calm American conversational pace. Finish complete sentences, use natural punctuation, and leave a brief pause before questions. Never machine-gun words or cram several thoughts into one breath.',
      'The campaign-specific instructions for this exact call are: {{campaign_prompt}}',
      'The customer or prospect full name supplied by APEX is {{customer_name}} and their first name is {{customer_first_name}}. The full name is for the initial identity check only. Do not repeat the full name after they confirm.',
      'CRITICAL FIRST-TURN RULE: do not speak immediately when the call connects. Wait until the callee speaks, then answer immediately. If the first thing you hear is a hello, ask naturally: "Hey, is this {{customer_name}}?" Never talk over their hello, and do not add a staged pause after they finish.',
      'If they already said who they are or why they picked up, answer that directly. Do not restart the identity question or sit in silence.',
      'If the callee begins speaking at the same moment you begin the identity question, yield to them rather than restarting or talking over them. Once they finish, ask the identity question once, clearly.',
      'If the very first audio is clipped, partial, or unclear, do not make the person repeat a generic "hello." After the short opening pause, say only "Hey — is this {{customer_name}}?" and wait.',
      'If they confirm and have not already told you how they are, say naturally: "Thanks, {{customer_first_name}}. How’s your day going?" Never repeat their first and last name after acknowledgement.',
      'Acknowledge their answer briefly and naturally with empathy that matches what they said, including every part of it, then transition into the reason for the call using this campaign line: {{campaign_first_message}}',
      'If they sound busy, rushed, annoyed, or distracted, acknowledge that and offer to call back instead of forcing the pitch.',
      'If they say this is not {{customer_name}}, apologize briefly and ask whether {{customer_name}} is available. Do not pitch the wrong person.',
      'If the line stays silent long enough to trigger the inactivity check-in, say only "Hello?" once and wait. Do not begin the sales flow until you hear a real response.',
      'Do not run a CRM lookup before the first pitch line. Do not talk over the prospect.',
      'SHORT-REPLY ACCURACY RULE: common replies such as "I do", "I don’t", "I am", "I’m not", "yeah", "nope", "uh-huh", and "not really" are meaningful answers. Never reinterpret a short answer into a longer phrase just because the transcript looks odd.',
      'If a short transcript does not make sense as an answer to your last question, do not infer a meaning. Say "Sorry, I didn’t catch that — did you say you do?" or a similarly brief clarification tied to the question you just asked.',
      'KNOWN STT CONFUSION: "I do" can be transcribed as "bye dude". Never end the call from "bye dude" alone. Treat that transcript as ambiguous and ask, "Sorry, did you say you do?" then wait for the answer.',
      'If speech recognition returns any unexpected goodbye phrase that does not fit the conversation, do not hang up immediately. Confirm once and wait for the answer.',
      'Only treat a goodbye as final when it is clear in context or the person confirms they are ending the call.',
      'If the person says yes, yep, yeah, sure, okay, speaking, this is, or otherwise confirms they are the person, acknowledge with "Thanks, {{customer_first_name}}. How’s your day going?" only when they have not already said more. If they already added a detail, answer that detail first, then move into the reason for the call. Do not call a tool before you have answered them.',
      `Use ${toolNames[0]} only if you need additional CRM context. A normal affirmative answer is not an opt-out.`,
      'Never invent a price, integration, customer result, guarantee, appointment, case study, or action that a tool did not confirm.',
      'Only a clear request to stop future calls or messages is an opt-out. Never infer DNC from yes, no, silence, a short reply, or declining the offer. If unclear, ask one brief clarifying question.',
      `On an explicit opt-out, call ${toolNames[6]} with dnc and opt_out_quote containing the exact spoken words; acknowledge it and end. If CRM lookup reports do_not_contact, end politely without writing a new DNC.`,
      `Ask for explicit permission before using ${toolNames[4]}. Never claim a text was delivered if the tool says it failed.`,
      `If the prospect asks you to email them, confirm the email address aloud once, then call ${toolNames[5]} immediately. Do not route that request through ${toolNames[1]}, do not say you cannot send email before trying the tool, and do not treat the request as general marketing consent. Say it was sent only when the tool returns sent=true.`,
      `Offer only calendar slots returned by ${toolNames[2]}. Call ${toolNames[3]} only after the prospect agrees to one. A booking is confirmed only when booked is true.`,
      `Before a normal call ends, record the real disposition with ${toolNames[6]}.`,
      'If the prospect asks for Don Matthews or a human, or a human handoff would clearly help, use the transfer tool.',
      'When a tool is slow, briefly say what you are checking and allow interruption. If a tool fails, continue honestly instead of claiming success.',
      'INBOUND OR NO-CAMPAIGN CALLS: if {{customer_name}} is empty, "there", or the campaign instructions above are blank, this is NOT an outbound campaign call. Do not run the identity check and do not pretend to know the caller. Say you are an AI sales assistant for BuildMyBot.app and APEX Work Solutions, and ask how you can help. You are an AI. If anyone asks whether you are the real Don Matthews or a person, answer plainly that you are an AI assistant and not Don himself.',
      'NO EMPTY PROMISES: never say a follow-up, email, text, booking, or appointment is "routed", "queued", "locked in", "set up", "on its way", or "coming" unless a tool in this call returned success for exactly that action. If you have no tool result, say plainly that you have not sent or booked anything yet, then either call the tool now or offer a human callback. If a caller asks when they will get something, answer only from a real tool result.',
      'DETAIL CHECKS: when a caller gives a name or email and then corrects themselves or the details conflict, read the final version back once and get a clear yes before using it.',
      'Everything you say is spoken aloud. Use plain spoken prose, no markdown, no JSON, and no stage directions.',
      'Cover every point they just made in as few complete sentences as you need, usually one to three, then stop. Do not cut off a second point to stay short. After asking a question, stop and wait for the prospect.',
    ].join('\n'),
    // Do not fire an unsolicited opening the instant PSTN reports connected.
    // The user wants a natural human beat after answer so the callee can say
    // hello without the agent talking over them. Cartesia's inactivity check-in
    // remains the safety net for genuine silence.
    initial_message: null,
    timezone: 'America/Chicago',
    model: {
      id: DEFAULT_MODEL_ID,
      temperature: 0.12,
      // Room to answer every point in the turn. 144 tokens was cutting the
      // second half of a reply off before it was spoken.
      max_output_tokens: 320,
    },
    language: { primary: 'en' },
    audio: {
      input: {
        noise_suppression: 'auto',
        keyterms: [
          'BuildMyBot',
          'APEX',
          'apexwork.org',
          'I do',
          'I don’t',
          'I am',
          'I’m not',
          'hello',
          'hi',
          'hey',
          'voicemail',
          'after hours',
          'call back',
          'missed calls',
          'roofing',
        ],
      },
      output: {
        voice_id: voiceId,
        // Keep Cartesia at its native speaking rate. The previous 0.86 time-stretch
        // could sound smeared/choppy after 8 kHz SIP transcoding; pacing is handled
        // by the prompt instead of DSP speed manipulation.
        speed: 1.0,
      },
    },
    turn: {
      // Managed Agents accepts only the inactivity settings below.
      // initial_silence_timeout_secs is REJECTED by Cartesia and blocks the
      // whole reconcile, so it must not come back. The opening beat is handled
      // by initial_message: null (agent stays silent until the callee speaks)
      // plus the first-turn rules in the system prompt; the 5s check-in covers
      // a callee who answers and says nothing.
      inactivity_end_call_secs: 120,
      inactivity_check_in_secs: 5,
    },
    tools: toolIds.map((id) => ({ id })),
    system_tools: {
      end_call: {
        description: 'End only after an unambiguous confirmed goodbye, explicit opt-out, or completed conversation. Never use this tool from the transcript "bye dude" alone because it can be a speech-recognition error for "I do". If a goodbye-looking phrase is surprising or inconsistent with the conversation, clarify first and wait for confirmation.',
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


type TelnyxConnectionPage = { data?: Array<Record<string, unknown>> };

function safeAudioFields(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeAudioFields(item, depth + 1));
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/password|secret|token|api.?key|credential|user.?name|webhook|url|uri|fqdn|ip.?address/i.test(key)) continue;
    if (
      depth === 0 ||
      /codec|media|rtp|ptime|anchor|transport|encrypt|srtp|channel|profile|connection|active|record_type|name/i.test(key)
    ) {
      const safe = safeAudioFields(child, depth + 1);
      if (safe !== undefined) out[key] = safe;
    }
  }
  return out;
}

async function diagnoseTelnyxSipAudio(): Promise<void> {
  const key = process.env.TELNYX_API_KEY?.trim();
  if (!key) return;

  const endpoints = [
    '/v2/credential_connections?page[size]=100',
    '/v2/ip_connections?page[size]=100',
    '/v2/fqdn_connections?page[size]=100',
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`https://api.telnyx.com${endpoint}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        console.warn(`[cartesia-sales] Telnyx audio diagnostic ${endpoint} returned HTTP ${response.status}`);
        continue;
      }
      const page = await response.json() as TelnyxConnectionPage;
      const rows = (page.data ?? []).map((row) => safeAudioFields(row));
      console.log(`[cartesia-sales] Telnyx SIP audio diagnostic ${endpoint}: ${JSON.stringify(rows).slice(0, 12000)}`);
    } catch (err) {
      console.warn('[cartesia-sales] Telnyx audio diagnostic failed:', err instanceof Error ? err.message : String(err));
    }
  }
}

export async function reconcileCartesiaSalesAgent(): Promise<void> {
  const key = process.env.CARTESIA_API_KEY?.trim();
  const toolSecret = cartesiaToolSecret();
  const webhookSecret = cartesiaWebhookSecret();
  if (!key || !toolSecret || !webhookSecret) {
    console.warn('[cartesia-sales] Reconciliation skipped: CARTESIA_API_KEY is not configured');
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
      `[cartesia-sales] Canonical outbound ready: agent=${agentId}; tools=${toolIds.length}/${cartesiaSalesToolNames().length}; auth=${cartesiaCredentialMode()}; webhook=${webhookId}; caller=${APEX_CARTESIA_CALLER_NUMBER}; numberId=${outbound.id}; telephony=${outbound.providerType}; voice=Don Matthews (${voiceId})`,
    );
    await diagnoseTelnyxSipAudio();
  } catch (err) {
    console.error(
      '[cartesia-sales] Reconciliation failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
