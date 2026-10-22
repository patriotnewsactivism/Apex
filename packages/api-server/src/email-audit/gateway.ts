import crypto from 'crypto';
import type { EmailAuditFlags } from './flags.js';
import { CHAIN_VERSION, linkRow, sha256Hex, type ChainedRow, type ChainFields } from './chain.js';

export type GatewaySendInput = {
  projectId: string;
  agent: string;          // e.g. 'marcus-cole'
  persona: string | null; // e.g. 'Marcus Cole'
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  provider: 'resend' | 'brevo' | 'ses';
  policyMode: string;     // e.g. 'owner_confirmed' (Marcus draft/confirm)
  bodyRef?: string | null;
};

export type ProviderResult = { providerMsgId: string };
export interface EmailProvider {
  send(input: GatewaySendInput): Promise<ProviderResult>;
}

/** Storage port. Production implementation uses the INSERT-only role (store-pg.ts). */
export interface AuditStore {
  /** In ONE transaction: lock chain, read tail, let caller build the row, insert it. */
  appendChained(build: (tail: { seq: number; rowHash: string } | null) => ChainedRow): Promise<ChainedRow>;
  insertEvent(ev: EmailEventInsert): Promise<'inserted' | 'duplicate'>;
}

export type EmailEventInsert = {
  id: string; provider: string; providerEventId: string; providerMsgId: string | null; auditId: string | null;
  eventType: string; rawType: string | null; occurredAt: string | null; signatureVerified: boolean; payload: unknown;
};

export type GatewayResult =
  | { status: 'disabled' }
  | { status: 'dry_run'; auditId: string; rowHash: string }
  | { status: 'sent'; auditId: string; rowHash: string; providerMsgId: string }
  | { status: 'provider_failed'; auditId: string; rowHash: string; error: string };

export class AuditWriteError extends Error {}

/** Allowed senders. wtpnews.org is NOT verified in our Resend account, so it is
 * excluded from Resend until DNS verification is approved and completed. */
export function senderAllowed(from: string, provider: GatewaySendInput['provider'], verifiedResendDomains: string[]): boolean {
  const domain = from.split('@')[1]?.toLowerCase().replace(/>$/, '');
  if (!domain) return false;
  if (provider === 'resend') return verifiedResendDomains.map((d) => d.toLowerCase()).includes(domain);
  return true;
}

/**
 * The single send path. Order is the whole point:
 *   1. write the hash-chained outbound_audit row (fails closed: no row, no send)
 *   2. hand to provider (only if flags.providerSend)
 *   3. record the provider's acceptance as an email_events row
 */
export async function sendViaGateway(
  input: GatewaySendInput,
  deps: { flags: EmailAuditFlags; store: AuditStore; provider: EmailProvider; now?: () => Date; verifiedResendDomains: string[] },
): Promise<GatewayResult> {
  if (!deps.flags.gateway) return { status: 'disabled' };
  if (!senderAllowed(input.from, input.provider, deps.verifiedResendDomains)) {
    throw new Error(`sender domain not verified for ${input.provider}`);
  }
  const now = (deps.now ?? (() => new Date()))();
  const id = `oa_${crypto.randomUUID()}`;
  const body = `${input.html ?? ''}\u0000${input.text ?? ''}`;
  const base: Omit<ChainFields, 'seq'> = {
    id, createdAt: now.toISOString(), projectId: input.projectId, toolName: 'email_gateway_send',
    agent: input.agent, persona: input.persona, fromAddr: input.from, toAddrs: input.to,
    ccAddrs: input.cc ?? [], bccAddrs: input.bcc ?? [], subject: input.subject, bodyHash: sha256Hex(body),
    bodyRef: input.bodyRef ?? null, provider: input.provider, policyMode: input.policyMode,
    detail: deps.flags.providerSend ? null : 'dry_run',
  };

  let row: ChainedRow;
  try {
    row = await deps.store.appendChained((tail) => {
      if (!tail) throw new AuditWriteError('audit chain has no genesis row; refusing to send');
      return linkRow({ ...base, seq: tail.seq + 1 }, tail.rowHash);
    });
  } catch (err) {
    throw err instanceof AuditWriteError ? err : new AuditWriteError(`audit write failed: ${(err as Error).message}`);
  }

  if (!deps.flags.providerSend) return { status: 'dry_run', auditId: row.id, rowHash: row.rowHash };

  let result: ProviderResult;
  try {
    result = await deps.provider.send(input);
  } catch (err) {
    await deps.store.insertEvent({
      id: `ev_${crypto.randomUUID()}`, provider: input.provider, providerEventId: `gateway-fail:${row.id}`,
      providerMsgId: null, auditId: row.id, eventType: 'failed', rawType: 'gateway.provider_error',
      occurredAt: new Date().toISOString(), signatureVerified: false, payload: { error: (err as Error).message },
    });
    return { status: 'provider_failed', auditId: row.id, rowHash: row.rowHash, error: (err as Error).message };
  }
  await deps.store.insertEvent({
    id: `ev_${crypto.randomUUID()}`, provider: input.provider, providerEventId: `gateway-accept:${row.id}`,
    providerMsgId: result.providerMsgId, auditId: row.id, eventType: 'accepted', rawType: 'gateway.accepted',
    occurredAt: new Date().toISOString(), signatureVerified: false, payload: {},
  });
  return { status: 'sent', auditId: row.id, rowHash: row.rowHash, providerMsgId: result.providerMsgId };
}

export const CHAIN_VERSION_USED = CHAIN_VERSION;
