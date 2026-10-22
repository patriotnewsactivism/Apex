// One-time genesis writer (approval #2). Default is --dry-run: prints the
// legacy row count + digest and the genesis row hash, writes nothing.
// Usage: EMAIL_AUDIT_WRITER_DATABASE_URL=... tsx src/email-audit/genesis-cli.ts [--execute]
import crypto from 'crypto';
import { GENESIS_PREV_HASH, genesisFields, legacyDigest, linkRow } from './chain.js';
import { createPgAuditReader, createPgAuditStore, type PgLike } from './store-pg.js';

async function main() {
  const execute = process.argv.includes('--execute');
  const readUrl = process.env.EMAIL_AUDIT_READER_DATABASE_URL;
  const writeUrl = process.env.EMAIL_AUDIT_WRITER_DATABASE_URL;
  if (!readUrl || (execute && !writeUrl)) throw new Error('EMAIL_AUDIT_READER_DATABASE_URL (and WRITER for --execute) required');
  const { createAuditSql } = await import('@workspace/db');
  const reader = createPgAuditReader(createAuditSql(readUrl) as unknown as PgLike);
  const legacy = legacyDigest(await reader.legacyRows());
  const existing = await reader.chainedRows();
  if (existing.length) { console.log(`chain already has ${existing.length} rows; genesis exists. Nothing to do.`); return; }
  const fields = genesisFields({ id: `oa_genesis_${crypto.randomUUID()}`, createdAt: new Date().toISOString(), projectId: 'apex', legacy });
  const row = linkRow(fields, GENESIS_PREV_HASH);
  console.log(JSON.stringify({ legacy_count: legacy.count, legacy_digest: legacy.digest, genesis_row_hash: row.rowHash, execute }));
  if (!execute) return;
  await createPgAuditStore(createAuditSql(writeUrl!) as unknown as PgLike).appendChained(() => row);
  console.log('genesis written');
}
main().then(() => process.exit(0), (e) => { console.error((e as Error).message); process.exit(1); });
