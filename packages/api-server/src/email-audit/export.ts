import type { ChainedRow } from './chain.js';

// Nightly export to a locked Google Sheet (EMAIL_AUDIT_EXPORT_ENABLED). Only
// metadata + hashes are exported, never bodies. The sheet writer is injected;
// the production adapter (service account with write access to that one
// sheet, Matthew owns it, agents get view/no access) is wired only after
// approval #5. Export is append-only: rows after the last exported seq.

export const EXPORT_HEADER = ['seq', 'id', 'created_at', 'agent', 'persona', 'from', 'to', 'cc', 'bcc', 'subject',
  'provider', 'policy_mode', 'body_hash', 'prev_hash', 'row_hash'] as const;

export function toSheetRows(rows: ChainedRow[], afterSeq: number): string[][] {
  return rows.filter((r) => r.seq > afterSeq).sort((a, b) => a.seq - b.seq).map((r) => [
    String(r.seq), r.id, r.createdAt, r.agent ?? '', r.persona ?? '', r.fromAddr ?? '', r.toAddrs.join(';'),
    r.ccAddrs.join(';'), r.bccAddrs.join(';'), sanitizeCell(r.subject ?? ''), r.provider ?? '', r.policyMode,
    r.bodyHash ?? '', r.prevHash, r.rowHash,
  ]);
}

/** Prevent formula injection in Sheets (=, +, -, @ leading chars). */
export function sanitizeCell(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export interface SheetWriter {
  lastExportedSeq(): Promise<number>;
  append(rows: string[][]): Promise<void>;
}

export async function runExport(deps: { enabled: boolean; rows: () => Promise<ChainedRow[]>; sheet: SheetWriter }) {
  if (!deps.enabled) return { status: 'disabled' as const };
  const after = await deps.sheet.lastExportedSeq();
  const out = toSheetRows(await deps.rows(), after);
  if (out.length) await deps.sheet.append(out);
  return { status: 'ok' as const, exported: out.length, fromSeq: after + 1 };
}
