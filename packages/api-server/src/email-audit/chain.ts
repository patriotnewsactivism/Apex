import crypto from 'crypto';

export const GENESIS_PREV_HASH = '0'.repeat(64);
export const CHAIN_VERSION = 1;

/** Fields covered by row_hash. Order is fixed; changing it requires CHAIN_VERSION++. */
export type ChainFields = {
  id: string;
  seq: number;
  createdAt: string; // ISO-8601 UTC, millisecond precision
  projectId: string;
  toolName: string;
  agent: string | null;
  persona: string | null;
  fromAddr: string | null;
  toAddrs: string[];
  ccAddrs: string[];
  bccAddrs: string[];
  subject: string | null;
  bodyHash: string | null;
  bodyRef: string | null;
  provider: string | null;
  policyMode: string;
  detail: string | null;
};

export type ChainedRow = ChainFields & { prevHash: string; rowHash: string };

const FIELD_ORDER: (keyof ChainFields)[] = [
  'id', 'seq', 'createdAt', 'projectId', 'toolName', 'agent', 'persona', 'fromAddr',
  'toAddrs', 'ccAddrs', 'bccAddrs', 'subject', 'bodyHash', 'bodyRef', 'provider', 'policyMode', 'detail',
];

/** Deterministic JSON: fixed key order, arrays normalised (lowercased, sorted). */
export function canonicalize(f: ChainFields): string {
  const norm = (a: string[]) => [...a].map((s) => s.trim().toLowerCase()).sort();
  const obj: Record<string, unknown> = {};
  for (const k of FIELD_ORDER) {
    const v = f[k];
    obj[k] = Array.isArray(v) ? norm(v) : v ?? null;
  }
  return JSON.stringify(obj);
}

export function sha256Hex(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function computeRowHash(f: ChainFields, prevHash: string): string {
  return sha256Hex(`v${CHAIN_VERSION}\n${canonicalize(f)}\n${prevHash}`);
}

export function linkRow(f: ChainFields, prevHash: string): ChainedRow {
  return { ...f, prevHash, rowHash: computeRowHash(f, prevHash) };
}

export type ChainProblem = { seq: number; id: string; kind: 'hash_mismatch' | 'prev_mismatch' | 'seq_gap' | 'bad_genesis' };

/** Verify an ordered (by seq) list of chained rows. Empty list is valid. */
export function verifyChain(rows: ChainedRow[]): { ok: boolean; problems: ChainProblem[] } {
  const problems: ChainProblem[] = [];
  let prev = GENESIS_PREV_HASH;
  let prevSeq: number | null = null;
  rows.forEach((r, i) => {
    if (i === 0 && r.prevHash !== GENESIS_PREV_HASH) problems.push({ seq: r.seq, id: r.id, kind: 'bad_genesis' });
    else if (i > 0 && r.prevHash !== prev) problems.push({ seq: r.seq, id: r.id, kind: 'prev_mismatch' });
    if (prevSeq !== null && r.seq !== prevSeq + 1) problems.push({ seq: r.seq, id: r.id, kind: 'seq_gap' });
    const { prevHash, rowHash, ...fields } = r;
    if (computeRowHash(fields, prevHash) !== rowHash) problems.push({ seq: r.seq, id: r.id, kind: 'hash_mismatch' });
    prev = rowHash;
    prevSeq = r.seq;
  });
  return { ok: problems.length === 0, problems };
}

/** Legacy (pre-chain) outbound_audit rows, as stored today. */
export type LegacyAuditRow = {
  id: string; projectId: string; toolName: string; destination: string | null; leadId: string | null;
  policyMode: string; providerId: string | null; rehearsal: boolean; detail: string | null; createdAt: string;
};

/** Digest over all legacy rows ordered by (createdAt, id). The genesis row commits to it. */
export function legacyDigest(rows: LegacyAuditRow[]): { count: number; digest: string } {
  const sorted = [...rows].sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
  const h = crypto.createHash('sha256');
  for (const r of sorted) {
    h.update(JSON.stringify([r.id, r.projectId, r.toolName, r.destination, r.leadId, r.policyMode, r.providerId, r.rehearsal, r.detail, r.createdAt]));
    h.update('\n');
  }
  return { count: rows.length, digest: h.digest('hex') };
}

export function genesisFields(args: { id: string; createdAt: string; projectId: string; legacy: { count: number; digest: string } }): ChainFields {
  return {
    id: args.id, seq: 1, createdAt: args.createdAt, projectId: args.projectId, toolName: 'audit_genesis',
    agent: null, persona: null, fromAddr: null, toAddrs: [], ccAddrs: [], bccAddrs: [], subject: null,
    bodyHash: null, bodyRef: null, provider: null, policyMode: 'genesis',
    detail: JSON.stringify({ legacy_count: args.legacy.count, legacy_digest: args.legacy.digest }),
  };
}
