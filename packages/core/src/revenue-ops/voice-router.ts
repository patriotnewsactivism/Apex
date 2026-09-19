// ─── Revenue Operations Voice Provider Router ───────────────────────────────────
//
// Selects an eligible voice AI provider for an outbound call, with circuit
// breakers, policy compatibility, and cost estimation. Provider-agnostic —
// concrete provider adapters are injected at runtime.
//
// Design:
//  - Eligible providers = provider_connections WHERE type=telephony AND status=connected
//    AND circuit_status != 'open'.
//  - Circuit open = provider recently returned 429/5xx or timed out. Cooldown
//    period before retry.
//  - Policy compatibility = provider supports the required dialect/language and
//    is not blocked by APEX policy.
//  - Selection = sort by priority, then health score, then latency; pick top.
//  - Failure classification:
//      transient  → retry with backoff
//      rate_limited → degrade circuit + fallback to next provider
//      permanent  → fail (no retry)
//  - Never retry a completed call.
//  - AI-session retry is separate from telephone-call retry.

import { db } from '@workspace/db';
import { providerConnections, calls } from '@workspace/db';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface VoiceProvider {
  id: string;
  provider: string;
  name: string;
  status: string;
  priority: number;
  healthScore: number; // 0-1, derived from recent success rate
  lastError: string | null;
  lastErrorAt: Date | null;
  circuitStatus: 'healthy' | 'degraded' | 'open';
  circuitCooldownUntil: Date | null;
}

export interface ProviderHealth {
  successCount: number;
  failureCount: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  averageLatencyMs: number | null;
}

export interface SelectProviderResult {
  provider: VoiceProvider | null;
  reason?: string;
  selectedProviderId?: string;
}

export interface VoiceAIProviderCapabilities {
  supportsTwoWayAudio: boolean;
  supportsStreaming: boolean;
  supportsBargeIn: boolean;
  maxSessionDurationSeconds: number;
  supportedDialects: string[];
  estimateCostPerMinuteCents: number;
}

// ─── Circuit breaker state ──────────────────────────────────────────────────────

const CIRCUITS = new Map<string, { status: 'healthy' | 'degraded' | 'open'; openedAt: number; failureCount: number }>();

const CIRCUIT_OPEN_DURATION_MS = 5 * 60 * 1000;   // 5 min circuit open
const CIRCUIT_COOLDOWN_MS = 30 * 1000;             // 30s cooldown before re-eval
const CIRCUIT_FAILURE_THRESHOLD = 5;               // failures before circuit opens
const CIRCUIT_SUCCESS_RESET = 10;                  // successes before circuit closes

function getCircuitStatus(provider: string): 'healthy' | 'degraded' | 'open' {
  const circuit = CIRCUITS.get(provider);
  if (!circuit) return 'healthy';

  if (circuit.status === 'open') {
    if (Date.now() > circuit.openedAt + CIRCUIT_OPEN_DURATION_MS) {
      circuit.status = 'degraded';
      circuit.failureCount = 0;
    } else {
      return 'open';
    }
  }

  return circuit.status;
}

function recordProviderSuccess(provider: string): void {
  let circuit = CIRCUITS.get(provider);
  if (!circuit) {
    circuit = { status: 'healthy', openedAt: 0, failureCount: 0 };
    CIRCUITS.set(provider, circuit);
  }

  if (circuit.status === 'degraded') {
    circuit.failureCount = Math.max(0, circuit.failureCount - 1);
    if (circuit.failureCount === 0) {
      circuit.status = 'healthy';
    }
  }
}

function recordProviderFailure(provider: string, failureType: 'transient' | 'rate_limited' | 'permanent'): void {
  let circuit = CIRCUITS.get(provider);
  if (!circuit) {
    circuit = { status: 'healthy', openedAt: 0, failureCount: 0 };
    CIRCUITS.set(provider, circuit);
  }

  if (failureType === 'rate_limited' || failureType === 'transient') {
    circuit.failureCount++;
    if (circuit.failureCount >= CIRCUIT_FAILURE_THRESHOLD) {
      circuit.status = 'open';
      circuit.openedAt = Date.now();
    } else if (circuit.failureCount >= 3) {
      circuit.status = 'degraded';
    }
  }
  // permanent failures don't trip the circuit — they're terminal for that call
}

// ─── Provider selection ─────────────────────────────────────────────────────────

export async function selectVoiceProvider(
  organizationId: string,
  desiredProvider?: string,
  context?: { dialect?: string; language?: string },
): Promise<SelectProviderResult> {
  // 1. Get eligible providers from provider_connections
  const connections = await db
    .select({
      id: providerConnections.id,
      provider: providerConnections.provider,
      name: providerConnections.name,
      status: providerConnections.status,
      configuration: providerConnections.configuration,
      type: providerConnections.type,
    })
    .from(providerConnections)
    .where(and(
      eq(providerConnections.organizationId, organizationId),
      eq(providerConnections.status, 'connected'),
    ))
    .limit(50);

  // Filter to telephony-type providers only. provider_connections has no
  // dedicated priority column; Revenue Ops stores optional routing preference
  // in configuration.priority and defaults to 50 when absent.
  const telephonyConnections = connections
    .filter(c =>
      c.type === 'telephony' || c.provider === 'telnyx' || c.provider === 'vapi' || c.provider === 'retell'
    )
    .map(c => ({
      ...c,
      priority:
        typeof c.configuration.priority === 'number' && Number.isFinite(c.configuration.priority)
          ? c.configuration.priority
          : 50,
    }));

  if (telephonyConnections.length === 0) {
    return { provider: null, reason: 'No connected telephony providers available.' };
  }

  // 2. Remove circuit-open providers
  const eligible = telephonyConnections.filter(c => {
    const circuitStatus = getCircuitStatus(c.provider);
    if (circuitStatus === 'open') return false;
    return true;
  });

  if (eligible.length === 0) {
    const openProviders = telephonyConnections.filter(c => getCircuitStatus(c.provider) === 'open');
    return {
      provider: null,
      reason: `All telephony providers have open circuits. ` +
        `Affected: ${openProviders.map(c => c.provider).join(', ') || 'none'}. ` +
        `Cooldown ends in ${(CIRCUIT_OPEN_DURATION_MS / 1000)}s.`,
    };
  }

  // 3. Policy compatibility — filter out providers that don't support the
  //    required dialect/language. For now, this is a no-op until we model
  //    provider capabilities. Defer to provider capability registry.
  //    (TODO: integrate with provider capability registry)

  // 4. If a specific provider was requested, try it first
  if (desiredProvider) {
    const desired = eligible.find(c => c.provider === desiredProvider);
    if (desired && getCircuitStatus(desired.provider) !== 'open') {
      return {
        provider: mapConnectionToProvider(desired),
        selectedProviderId: desired.id,
      };
    }
  }

  // 5. Sort by priority, then health score, then latency
  //    For now, priority is the tiebreaker; health is computed from circuit state.
  const sorted = eligible.sort((a, b) => {
    // Priority first (lower = higher priority)
    if (a.priority !== b.priority) return a.priority - b.priority;
    // Circuit state: healthy > degraded
    const aCircuit = getCircuitStatus(a.provider);
    const bCircuit = getCircuitStatus(b.provider);
    if (aCircuit !== bCircuit) {
      return aCircuit === 'healthy' ? -1 : 1;
    }
    // Name as final tiebreaker
    return a.provider.localeCompare(b.provider);
  });

  const selected = sorted[0];
  return {
    provider: mapConnectionToProvider(selected),
    selectedProviderId: selected.id,
  };
}

function mapConnectionToProvider(conn: {
  id: string; provider: string; name: string; status: string; priority: number;
}): VoiceProvider {
  return {
    id: conn.id,
    provider: conn.provider,
    name: conn.name ?? conn.provider,
    status: conn.status,
    priority: conn.priority ?? 50,
    healthScore: getCircuitStatus(conn.provider) === 'healthy' ? 1.0 : 0.5,
    lastError: null,
    lastErrorAt: null,
    circuitStatus: getCircuitStatus(conn.provider),
    circuitCooldownUntil: CIRCUITS.get(conn.provider)?.openedAt
      ? new Date(CIRCUITS.get(conn.provider)!.openedAt + CIRCUIT_OPEN_DURATION_MS)
      : null,
  };
}

// ─── Cost estimation ────────────────────────────────────────────────────────────

export function estimateVoiceCost(
  durationSeconds: number,
  provider: string,
  capabilities: VoiceAIProviderCapabilities | undefined,
): { costCents: number; ratePerMinuteCents: number } {
  // Default rate: $0.05/minute = 5 cents/minute = ~0.083 cents/second
  // Real provider rates vary; this is a placeholder until we have live rate data.
  const ratePerMinuteCents = capabilities?.estimateCostPerMinuteCents ?? 5;
  const costCents = Math.round((durationSeconds / 60) * ratePerMinuteCents);
  return { costCents, ratePerMinuteCents };
}

// ─── Outbound call initiation (orchestrator, not provider-specific) ────────────

export interface InitiateCallInput {
  organizationId: string;
  contactId: string;
  missionId?: string;
  campaignId?: string;
  toNumber: string;
  fromNumber?: string;
  providerConnectionId?: string;
  strategyId?: string;
  steps?: Array<{ channel: string; content?: string }>;
}

export interface InitiateCallResult {
  success: boolean;
  callId?: string;
  providerId?: string;
  provider?: string;
  error?: string;
  cleanupAction?: string; // if call was queued but not started, what to do
}

export async function initiateOutboundCall(input: InitiateCallInput): Promise<InitiateCallResult> {
  // 1. Select provider
  const selection = await selectVoiceProvider(input.organizationId, undefined, {});
  if (!selection.provider) {
    return { success: false, error: selection.reason };
  }

  // 2. If a specific provider connection was requested, verify it exists and is eligible
  if (input.providerConnectionId) {
    const [conn] = await db
      .select()
      .from(providerConnections)
      .where(and(
        eq(providerConnections.id, input.providerConnectionId),
        eq(providerConnections.organizationId, input.organizationId),
        eq(providerConnections.status, 'connected'),
      ))
      .limit(1);

    if (!conn) {
      return { success: false, error: 'Requested provider connection not found or not connected.' };
    }

    const circuitStatus = getCircuitStatus(conn.provider);
    if (circuitStatus === 'open') {
      return { success: false, error: `Provider ${conn.provider} has an open circuit.`, cleanupAction: 'circuit_open' };
    }
  }

  // 3. Create the call record
  const callId = randomUUID();
  const now = new Date();

  try {
    await db.insert(calls).values({
      id: callId,
      organizationId: input.organizationId,
      missionId: input.missionId ?? null,
      campaignId: input.campaignId ?? null,
      contactId: input.contactId,
      providerConnectionId: input.providerConnectionId ?? selection.selectedProviderId ?? null,
      externalCallId: null,
      callControlId: null,
      callSessionId: null,
      fromNumber: input.fromNumber ?? null,
      toNumber: input.toNumber,
      direction: 'outbound',
      status: 'requested',
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    return { success: false, error: `Failed to create call record: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 4. Dispatch to the provider adapter (provider-specific)
  //    This is a no-op stub — real dispatch happens in the provider adapter layer.
  //    The call is now in 'requested' status; the provider adapter picks it up.
  console.info(`[Voice Router] Call ${callId} queued for provider ${selection.provider.provider} to ${input.toNumber}`);

  return {
    success: true,
    callId,
    providerId: selection.selectedProviderId,
    provider: selection.provider.provider,
  };
}

// ─── Call state transitions ─────────────────────────────────────────────────────

export type CallDisposition = 'human' | 'voicemail' | 'no_answer' | 'busy' | 'wrong_number' | 'interested' | 'not_interested' | 'callback' | 'qualified' | 'booked' | 'dnc' | 'failed';

export async function updateCallStatus(callId: string, status: string): Promise<boolean> {
  const result = await db
    .update(calls)
    .set({ status, updatedAt: new Date() })
    .where(eq(calls.id, callId))
    .returning({ id: calls.id });

  return result.length > 0;
}

export async function recordCallCompletion(
  callId: string,
  disposition: CallDisposition,
  durationSeconds: number | null,
  errorCode: string | null,
  costCents: number | null,
  recordingUri: string | null,
  transcriptId: string | null,
): Promise<boolean> {
  const result = await db
    .update(calls)
    .set({
      status: 'completed',
      disposition,
      durationSeconds,
      errorCode,
      costCents: costCents ?? 0,
      recordingUri: recordingUri ?? null,
      transcriptId: transcriptId ?? null,
      endedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(calls.id, callId))
    .returning({ id: calls.id });

  if (result.length > 0) {
    recordProviderSuccess('default'); // generic success tracking
  }

  return result.length > 0;
}

export async function recordCallFailure(
  callId: string,
  disposition: CallDisposition,
  errorCode: string,
  errorDetail: Record<string, unknown> | null,
  failureType: 'transient' | 'rate_limited' | 'permanent',
): Promise<boolean> {
  const result = await db
    .update(calls)
    .set({
      status: 'failed',
      disposition,
      errorCode,
      errorDetail: errorDetail ?? null,
      endedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(calls.id, callId))
    .returning({ id: calls.id });

  if (result.length > 0) {
    // Determine provider from the call to record failure against the right circuit
    const [call] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
    if (call?.providerConnectionId) {
      const [conn] = await db
        .select({ provider: providerConnections.provider })
        .from(providerConnections)
        .where(eq(providerConnections.id, call.providerConnectionId))
        .limit(1);

      if (conn) {
        recordProviderFailure(conn.provider, failureType);
      }
    }
  }

  return result.length > 0;
}
