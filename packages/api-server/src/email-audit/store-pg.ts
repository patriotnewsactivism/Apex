import type { AuditStore, EmailEventInsert } from './gateway.js';
import type { ChainedRow, LegacyAuditRow } from './chain.js';

/** Minimal surface of a postgres.js client so this file stays testable. */
export type PgLike = {
  unsafe(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  begin<T>(fn: (tx: PgLike) => Promise<T>): Promise<T>;
};

const toIso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export function rowFromDb(r: Record<string, unknown>): ChainedRow {
  return {
    id: String(r.id), seq: Number(r.seq), createdAt: toIso(r.created_at), projectId: String(r.project_id),
    toolName: String(r.tool_name), agent: (r.agent as string) ?? null, persona: (r.persona as string) ?? null,
    fromAddr: (r.from_addr as string) ?? null, toAddrs: (r.to_addrs as string[]) ?? [], ccAddrs: (r.cc_addrs as string[]) ?? [],
    bccAddrs: (r.bcc_addrs as string[]) ?? [], subject: (r.subject as string) ?? null, bodyHash: (r.body_hash as string) ?? null,
    bodyRef: (r.body_ref as string) ?? null, provider: (r.provider as string) ?? null, policyMode: String(r.policy_mode),
    detail: (r.detail as string) ?? null, prevHash: String(r.prev_hash), rowHash: String(r.row_hash),
  };
}

/** Writer store: uses only INSERT + column-limited SELECT (apex_audit_writer). */
export function createPgAuditStore(sql: PgLike): AuditStore {
  return {
    async appendChained(build) {
      return sql.begin(async (tx) => {
        await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('outbound_audit_chain'))`);
        const [tail] = await tx.unsafe(
          `SELECT seq, row_hash FROM outbound_audit WHERE chain_version IS NOT NULL ORDER BY seq DESC LIMIT 1`,
        );
        const row = build(tail ? { seq: Number(tail.seq), rowHash: String(tail.row_hash) } : null);
        // Timestamp is written exactly as hashed, so verification can recompute it.
        await tx.unsafe(
          `INSERT INTO outbound_audit (id, project_id, tool_name, destination, policy_mode, rehearsal, detail, created_at,
             seq, chain_version, agent, persona, from_addr, to_addrs, cc_addrs, bcc_addrs, subject, body_hash, body_ref,
             provider, prev_hash, row_hash)
           VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8,1,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [row.id, row.projectId, row.toolName, row.toAddrs[0] ?? null, row.policyMode, row.detail, row.createdAt,
            row.seq, row.agent, row.persona, row.fromAddr, row.toAddrs, row.ccAddrs, row.bccAddrs, row.subject,
            row.bodyHash, row.bodyRef, row.provider, row.prevHash, row.rowHash],
        );
        return row;
      });
    },
    async insertEvent(ev: EmailEventInsert) {
      const res = await sql.unsafe(
        `INSERT INTO email_events (id, provider, provider_event_id, provider_msg_id, audit_id, event_type, raw_type,
           occurred_at, signature_verified, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
        [ev.id, ev.provider, ev.providerEventId, ev.providerMsgId, ev.auditId, ev.eventType, ev.rawType,
          ev.occurredAt, ev.signatureVerified, JSON.stringify(ev.payload ?? {})],
      );
      return res.length ? 'inserted' : 'duplicate';
    },
  };
}

/** Reader queries (apex_audit_reader): dashboard, reconciliation, export. */
export function createPgAuditReader(sql: PgLike) {
  return {
    async chainedRows(): Promise<ChainedRow[]> {
      return (await sql.unsafe(`SELECT * FROM outbound_audit WHERE chain_version IS NOT NULL ORDER BY seq ASC`)).map(rowFromDb);
    },
    async legacyRows(): Promise<LegacyAuditRow[]> {
      const rows = await sql.unsafe(`SELECT * FROM outbound_audit WHERE chain_version IS NULL ORDER BY created_at, id`);
      return rows.map((r) => ({
        id: String(r.id), projectId: String(r.project_id), toolName: String(r.tool_name),
        destination: (r.destination as string) ?? null, leadId: (r.lead_id as string) ?? null,
        policyMode: String(r.policy_mode), providerId: (r.provider_id as string) ?? null, rehearsal: Boolean(r.rehearsal),
        detail: (r.detail as string) ?? null, createdAt: toIso(r.created_at),
      }));
    },
    async eventsBetween(start: Date, end: Date) {
      return sql.unsafe(`SELECT * FROM email_events WHERE received_at >= $1 AND received_at < $2 ORDER BY received_at`, [start, end]);
    },
    async search(q: { agent?: string; to?: string; since?: Date; limit: number }) {
      return sql.unsafe(
        `SELECT id, seq, created_at, agent, persona, from_addr, to_addrs, subject, provider, policy_mode, row_hash
           FROM outbound_audit
          WHERE chain_version IS NOT NULL
            AND ($1::text IS NULL OR agent = $1)
            AND ($2::text IS NULL OR $2 = ANY(to_addrs))
            AND ($3::timestamptz IS NULL OR created_at >= $3)
          ORDER BY seq DESC LIMIT $4`,
        [q.agent ?? null, q.to?.toLowerCase() ?? null, q.since ?? null, q.limit],
      );
    },
    async perAgentCounts(since: Date) {
      return sql.unsafe(
        `SELECT coalesce(agent,'(legacy)') AS agent, count(*)::int AS sends FROM outbound_audit
          WHERE created_at >= $1 GROUP BY 1 ORDER BY 2 DESC`, [since]);
    },
  };
}
export type PgAuditReader = ReturnType<typeof createPgAuditReader>;
