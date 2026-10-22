import { verifyChain, type ChainedRow } from './chain.js';

// Nightly reconciliation (Railway cron, EMAIL_AUDIT_RECONCILE_ENABLED). Pure
// comparison logic; provider log fetchers are injected so tests never hit a
// network and the job is read-only against providers.

export type ProviderLogEntry = { provider: string; providerMsgId: string; from: string; to: string[]; sentAt: string; status?: string };
export type AcceptedEvent = { provider: string; providerMsgId: string | null; auditId: string | null; eventType: string };

export type Finding =
  | { kind: 'provider_only'; provider: string; providerMsgId: string; detail: { from: string; to: string[]; sentAt: string } }
  | { kind: 'audit_only'; auditId: string; provider: string | null }
  | { kind: 'status_mismatch'; provider: string; providerMsgId: string; detail: { provider: string; ours: string } }
  | { kind: 'chain_break' | 'seq_gap'; auditId: string; detail: { seq: number; problem: string } }
  | { kind: 'unchained_insert'; auditId: string };

export function reconcile(input: {
  chained: ChainedRow[];              // all chained rows (verify the whole chain every night)
  windowAuditIds: Set<string>;        // chained send rows created in the window
  unchainedSinceGenesis: string[];    // ids of chain_version IS NULL rows created after genesis
  events: AcceptedEvent[];            // email_events in the window (+ lookback)
  providerLogs: ProviderLogEntry[];   // provider list APIs for the window
  latestStatus: Map<string, string>;  // key provider:msgId -> our latest normalised status
  dryRunIds?: Set<string>;
}): { chainOk: boolean; findings: Finding[] } {
  const findings: Finding[] = [];
  const chain = verifyChain(input.chained);
  for (const p of chain.problems) {
    findings.push({ kind: p.kind === 'seq_gap' ? 'seq_gap' : 'chain_break', auditId: p.id, detail: { seq: p.seq, problem: p.kind } });
  }
  for (const id of input.unchainedSinceGenesis) findings.push({ kind: 'unchained_insert', auditId: id });

  const accepted = new Map<string, string | null>(); // provider:msgId -> auditId
  const auditWithAccept = new Set<string>();
  for (const e of input.events) {
    if (e.eventType === 'accepted' && e.providerMsgId) {
      accepted.set(`${e.provider}:${e.providerMsgId}`, e.auditId);
      if (e.auditId) auditWithAccept.add(e.auditId);
    }
    if (e.eventType === 'failed' && e.auditId) auditWithAccept.add(e.auditId);
  }
  const sendRows = new Map(input.chained.filter((r) => r.toolName === 'email_gateway_send').map((r) => [r.id, r]));

  for (const log of input.providerLogs) {
    const key = `${log.provider}:${log.providerMsgId}`;
    if (!accepted.has(key)) {
      findings.push({ kind: 'provider_only', provider: log.provider, providerMsgId: log.providerMsgId, detail: { from: log.from, to: log.to, sentAt: log.sentAt } });
      continue;
    }
    const ours = input.latestStatus.get(key);
    if (log.status && ours && log.status !== ours) {
      findings.push({ kind: 'status_mismatch', provider: log.provider, providerMsgId: log.providerMsgId, detail: { provider: log.status, ours } });
    }
  }
  for (const id of input.windowAuditIds) {
    if (input.dryRunIds?.has(id)) continue;
    if (sendRows.has(id) && !auditWithAccept.has(id)) findings.push({ kind: 'audit_only', auditId: id, provider: sendRows.get(id)!.provider });
  }
  return { chainOk: chain.ok, findings };
}
