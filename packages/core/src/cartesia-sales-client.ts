import { markLineBusy } from './line-activity.js';
const CARTESIA_API = 'https://api.cartesia.ai';
export const CARTESIA_API_VERSION = '2026-08-14';
export const CARTESIA_SALES_AGENT_NAME = 'APEX Sales — BuildMyBot';
export const CARTESIA_SALES_VOICE_NAME = 'Don Matthews';
export const APEX_CARTESIA_CALLER_NUMBER = '+18329757665';

const RESOLUTION_TTL_MS = 5 * 60_000;

type CachedValue = { value: string; expiresAt: number } | null;
let agentIdCache: CachedValue = null;
let outboundNumberIdCache: CachedValue = null;
let salesVoiceIdCache: CachedValue = null;

type CartesiaAgentSummary = {
  id?: string;
  name?: string;
};
type CartesiaVoice = { id?: string; name?: string; status?: string; is_owner?: boolean };
type CartesiaVoicePage = { data?: CartesiaVoice[]; has_more?: boolean };

type CartesiaAgentPage = {
  data?: CartesiaAgentSummary[];
};

type CartesiaPhoneNumber = {
  id?: string;
  number?: string;
  label?: string | null;
  provider?: { type?: string; id?: string; label?: string | null } | null;
};

type CartesiaPhoneNumberPage = {
  data?: CartesiaPhoneNumber[];
};

export type CartesiaCall = {
  id: string;
  agent_id?: string;
  agent_name?: string;
  status?: 'created' | 'started' | 'completed' | 'failed' | string;
  start_time?: string | null;
  end_time?: string | null;
  transcript?: Array<{ role?: string; text?: string; start_timestamp?: number; end_timestamp?: number }> | null;
  telephony_params?: {
    to?: string;
    from?: string;
    direction?: string;
    call_sid?: string;
    connection_type?: string;
  } | null;
  telephony_account_type?: string | null;
  summary?: string | null;
  error_message?: string | null;
  end_reason?: string | null;
  dynamic_variables?: Record<string, unknown>;
};

function apiKey(): string {
  const key = process.env.CARTESIA_API_KEY?.trim();
  if (!key) throw new Error('CARTESIA_API_KEY is not configured.');
  return key;
}

function normalizeE164(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  const normalized = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

async function managementRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    throw new Error(`Cartesia API request failed: ${message}`);
  }
  return data as T;
}

export function clearCartesiaSalesResolutionCache(): void {
  agentIdCache = null;
  outboundNumberIdCache = null;
  salesVoiceIdCache = null;
}

/** The sales agent must use the operator's owned voice, never a generic fallback. */
export async function resolveCartesiaSalesVoiceId(): Promise<string> {
  if (salesVoiceIdCache && salesVoiceIdCache.expiresAt > Date.now()) return salesVoiceIdCache.value;

  const configuredId = process.env.CARTESIA_SALES_VOICE_ID?.trim();
  const page = configuredId
    ? { data: [await managementRequest<CartesiaVoice>(`/voices/${encodeURIComponent(configuredId)}`)], has_more: false }
    : await managementRequest<CartesiaVoicePage>(
        `/voices?q=${encodeURIComponent(CARTESIA_SALES_VOICE_NAME)}&is_owner=true&limit=100`,
      );
  if (page.has_more) throw new Error('Cartesia owned-voice search was truncated; refusing to guess.');
  const matches = (page.data ?? []).filter((voice) =>
    voice.id && voice.name?.trim().toLowerCase() === CARTESIA_SALES_VOICE_NAME.toLowerCase() &&
    voice.status === 'active' && voice.is_owner !== false,
  );
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `The active owned Cartesia voice "${CARTESIA_SALES_VOICE_NAME}" is not available; sales dialing is blocked.`
      : `Multiple active owned Cartesia voices are named "${CARTESIA_SALES_VOICE_NAME}"; set CARTESIA_SALES_VOICE_ID.`);
  }
  const value = matches[0]!.id!;
  salesVoiceIdCache = { value, expiresAt: Date.now() + RESOLUTION_TTL_MS };
  return value;
}


export interface CartesiaSpeechResult {
  audio: Uint8Array;
  contentType: 'audio/wav';
  voiceId: string;
  modelId: string;
}

/**
 * Render short webinar/co-host speech with the exact same owned "Don Matthews"
 * voice used by APEX sales. This intentionally fails closed if the owned voice
 * cannot be resolved; callers can then choose an explicit UI fallback rather
 * than silently switching identities.
 */
export async function synthesizeCartesiaSalesSpeech(
  transcriptInput: string,
): Promise<CartesiaSpeechResult> {
  const transcript = transcriptInput.trim();
  if (!transcript) throw new Error('Speech transcript is required.');
  if (transcript.length > 4000) throw new Error('Speech transcript exceeds the 4,000 character live limit.');

  const voiceId = await resolveCartesiaSalesVoiceId();
  const modelId = process.env.CARTESIA_WEBINAR_TTS_MODEL?.trim() || 'sonic-3.6';
  const response = await fetch(`${CARTESIA_API}/tts/bytes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Cartesia-Version': CARTESIA_API_VERSION,
      'Content-Type': 'application/json',
      Accept: 'audio/wav',
    },
    body: JSON.stringify({
      model_id: modelId,
      transcript,
      voice: voiceId,
      language: 'en',
      normalization: 'auto',
      output_format: {
        container: 'wav',
        encoding: 'pcm_s16le',
        sample_rate: 44100,
      },
      generation_config: {
        volume: 1,
        speed: 1,
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Cartesia webinar speech failed (HTTP ${response.status})${body ? `: ${body.slice(0, 240)}` : ''}`,
    );
  }

  return {
    audio: new Uint8Array(await response.arrayBuffer()),
    contentType: 'audio/wav',
    voiceId,
    modelId,
  };
}

export async function resolveCartesiaSalesAgentId(): Promise<string> {
  if (agentIdCache && agentIdCache.expiresAt > Date.now()) return agentIdCache.value;

  const page = await managementRequest<CartesiaAgentPage>('/v1/agents?limit=100');
  const matches = (page.data ?? []).filter((agent) => agent.name === CARTESIA_SALES_AGENT_NAME && agent.id);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Canonical Cartesia sales agent "${CARTESIA_SALES_AGENT_NAME}" is not provisioned.`
        : `Multiple Cartesia agents are named "${CARTESIA_SALES_AGENT_NAME}"; refusing to guess.`,
    );
  }
  const value = matches[0]!.id!;
  const [agent, voiceId] = await Promise.all([
    managementRequest<{ config?: { audio?: { output?: { voice_id?: string } } } }>(
      `/v1/agents/${encodeURIComponent(value)}`,
    ),
    resolveCartesiaSalesVoiceId(),
  ]);
  if (agent.config?.audio?.output?.voice_id !== voiceId) {
    throw new Error(`Canonical Cartesia sales agent is not using the "${CARTESIA_SALES_VOICE_NAME}" voice; dialing is blocked.`);
  }
  agentIdCache = { value, expiresAt: Date.now() + RESOLUTION_TTL_MS };
  return value;
}

export async function resolveCartesiaOutboundNumberId(): Promise<string> {
  if (outboundNumberIdCache && outboundNumberIdCache.expiresAt > Date.now()) {
    return outboundNumberIdCache.value;
  }

  const digits = APEX_CARTESIA_CALLER_NUMBER.replace(/\D/g, '');
  const page = await managementRequest<CartesiaPhoneNumberPage>(
    `/agents/phone-numbers?q=${encodeURIComponent(digits)}&limit=100`,
  );
  const matches = (page.data ?? []).filter(
    (phone) => phone.id && normalizeE164(phone.number) === APEX_CARTESIA_CALLER_NUMBER,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Approved APEX caller ID ${APEX_CARTESIA_CALLER_NUMBER} is not connected to Cartesia.`
        : `Approved APEX caller ID ${APEX_CARTESIA_CALLER_NUMBER} appears more than once in Cartesia; refusing to guess.`,
    );
  }
  const value = matches[0]!.id!;
  outboundNumberIdCache = { value, expiresAt: Date.now() + RESOLUTION_TTL_MS };
  return value;
}

export interface StartCartesiaSalesCallInput {
  toNumber: string;
  customerName?: string | null;
  assistantPrompt: string;
  firstMessage: string;
  leadId?: string | null;
  campaignId?: string | null;
  playbookId?: string | null;
  createdByAgentId?: string | null;
  ringingTimeoutSeconds?: number;
  sendJobId?: string | null;
  /**
   * Operator-started rehearsal or test call. Applied only when the
   * surrounding caller is the operator dashboard, and only then does the
   * call skip the two confirmations and the volume code.
   */
  operatorDirect?: boolean;
}

export interface StartCartesiaSalesCallResult {
  callId: string;
  provider: 'cartesia';
  agentId: string;
  fromNumberId: string;
  fromNumber: string;
  toNumber: string;
}

export async function startCartesiaSalesCall(
  input: StartCartesiaSalesCallInput,
): Promise<StartCartesiaSalesCallResult> {
  const toNumber = normalizeE164(input.toNumber);
  if (!toNumber) throw new Error('Destination phone number is invalid.');
  const { assertSendAllowed, currentSendCaller, openOutboundSendJob, recordOutboundSendResult, SendSafeguardError } = await import('./send-safeguard.js');
  let sendJobId = input.sendJobId ?? null;
  let safeguardRecipientId: string | null = null;
  try {
    if (!sendJobId) {
      const operatorDirect = input.operatorDirect === true && currentSendCaller() === 'operator-dashboard';
      const opened = await openOutboundSendJob({
        caller: operatorDirect ? 'operator-dashboard' : 'tool',
        operatorDirect,
        createdBy: input.createdByAgentId ?? 'cartesia-sales',
        campaignKey: input.campaignId ?? null,
        recipients: [{
          channel: 'phone',
          destination: toNumber,
          messageText: `${input.firstMessage}\n${input.assistantPrompt}`,
          payload: {
            kind: 'cartesia_call',
            customerName: input.customerName ?? null,
            assistantPrompt: input.assistantPrompt,
            firstMessage: input.firstMessage,
            leadId: input.leadId ?? null,
            campaignId: input.campaignId ?? null,
            playbookId: input.playbookId ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
          },
        }],
      });
      sendJobId = opened.jobId;
    }
    const cleared = await assertSendAllowed(sendJobId, toNumber, 'phone');
    safeguardRecipientId = cleared.id;
  } catch (error) {
    if (error instanceof SendSafeguardError) throw error;
    console.error(`[send-safeguard] blocked job=${sendJobId ?? 'none'} channel=phone reason=safeguard_error`);
    throw new SendSafeguardError('Send safeguard failed closed.', 'safeguard_error', sendJobId, 'phone');
  }
  const markSafeguardFailed = async () => {
    if (sendJobId && safeguardRecipientId) {
      await recordOutboundSendResult(sendJobId, safeguardRecipientId, 'failed', null).catch(() => undefined);
    }
  };
  const assistantPrompt = input.assistantPrompt.trim();
  const firstMessage = input.firstMessage.trim();
  if (!assistantPrompt) {
    await markSafeguardFailed();
    throw new Error('assistantPrompt is required.');
  }
  if (!firstMessage) {
    await markSafeguardFailed();
    throw new Error('firstMessage is required.');
  }

  const [agentId, fromNumberId] = await Promise.all([
    resolveCartesiaSalesAgentId(),
    resolveCartesiaOutboundNumberId(),
  ]);

  const customerName = input.customerName?.trim() || 'there';
  const customerFirstName =
    customerName === 'there'
      ? 'there'
      : customerName.replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, '').split(/\s+/)[0] || customerName;

  const dynamicVariables: Record<string, string> = {
    customer_name: customerName,
    customer_first_name: customerFirstName,
    campaign_prompt: assistantPrompt,
    campaign_first_message: firstMessage,
  };
  if (input.leadId) dynamicVariables.apex_lead_id = input.leadId;
  if (input.campaignId) dynamicVariables.apex_campaign_id = input.campaignId;
  if (input.playbookId) dynamicVariables.apex_playbook_id = input.playbookId;
  if (input.createdByAgentId) dynamicVariables.apex_created_by_agent_id = input.createdByAgentId;

  const response = await fetch(`${CARTESIA_API}/agents/calls`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey(),
      'Cartesia-Version': CARTESIA_API_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      // NOTE: the live APEX Cartesia account currently accepts these telephony
      // controls at the request level. Moving them into outbound_calls[] caused
      // the live endpoint to reject rehearsal calls with HTTP 400.
      from_number_id: fromNumberId,
      agent_id: agentId,
      ringing_timeout_seconds: Math.max(5, Math.min(80, Math.round(input.ringingTimeoutSeconds ?? 30))),
      outbound_calls: [{
        to_number: toNumber,
        dynamic_variables: dynamicVariables,
      }],
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const rawBody = await response.text();
  let body: {
    calls?: Array<{ number?: string; agent_call_id?: string; error?: unknown }>;
    message?: string;
    detail?: unknown;
    error?: unknown;
    errors?: unknown;
  } = {};
  try {
    body = rawBody ? JSON.parse(rawBody) as typeof body : {};
  } catch {
    body = {};
  }

  if (!response.ok) {
    const providerDetail =
      body.message ??
      (typeof body.detail === 'string' ? body.detail : undefined) ??
      (typeof body.error === 'string' ? body.error : undefined) ??
      (body.detail ? JSON.stringify(body.detail) : undefined) ??
      (body.error ? JSON.stringify(body.error) : undefined) ??
      (body.errors ? JSON.stringify(body.errors) : undefined) ??
      (rawBody ? rawBody.slice(0, 1000) : undefined) ??
      `HTTP ${response.status}`;
    await markSafeguardFailed();
    throw new Error(`Cartesia outbound call request failed (HTTP ${response.status}): ${providerDetail}`);
  }
  const call = body.calls?.[0];
  if (!call?.agent_call_id || call.error) {
    const detail = typeof call?.error === 'string' ? call.error : 'Cartesia did not issue a call ID.';
    await markSafeguardFailed();
    throw new Error(`Cartesia outbound call could not start: ${detail}`);
  }

  // Light the line lamp. Keyed on the same id the webhook uses to close it.
  await markLineBusy({
    lineNumber: APEX_CARTESIA_CALLER_NUMBER,
    direction: 'outbound',
    source: 'cartesia-dial',
    remoteNumber: toNumber,
    remoteName: input.customerName ?? null,
    callId: `cartesia:${call.agent_call_id}`,
  });

  if (safeguardRecipientId) {
    await recordOutboundSendResult(sendJobId, safeguardRecipientId, 'sent', call.agent_call_id);
  }
  return {
    callId: call.agent_call_id,
    provider: 'cartesia',
    agentId,
    fromNumberId,
    fromNumber: APEX_CARTESIA_CALLER_NUMBER,
    toNumber,
  };
}

export async function getCartesiaSalesCall(callId: string): Promise<CartesiaCall> {
  if (!/^ac_[A-Za-z0-9_-]+$/.test(callId)) throw new Error('Invalid Cartesia call ID.');
  return managementRequest<CartesiaCall>(`/agents/calls/${encodeURIComponent(callId)}`);
}
