// ─── Encrypted Provider Connections Migration ──────────────────────────────
//
// Idempotent migration for the provider_connections table (revenue-ops Phase 1).
// Stores encrypted credentials for external providers (Telnyx, Google, Microsoft,
// HubSpot, etc.) so API keys are never stored in plaintext in integration_settings.
//
// Run:  pnpm --filter @workspace/db exec tsx lib/db/src/migrate-provider-connections.ts
// Requires: DATABASE_URL, APEX_ENCRYPTION_KEY (32-byte hex or base64)
//
// Idempotent: safe to run on every boot. Mirrors schema-revenue-ops.ts exactly.
// Additive + IF NOT EXISTS: a no-op against a database that already has the table.
import postgres from 'postgres';
import { decrypt, encrypt } from './crypto.js';
const connectionString = process.env.DATABASE_URL || 'postgres://postgres:***@localhost:5432/apex';
const client = postgres(connectionString, {
    prepare: false,
    max: 20,
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    connect_timeout: 15,
});
async function migrate() {
    console.log('═══ Encrypted Provider Connections Migration ═══');
    console.log('');
    // ── 1. Create provider_connections table ────────────────────────────────
    console.log('1. Creating provider_connections table...');
    await client `
    CREATE TABLE IF NOT EXISTS provider_connections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id text NOT NULL,
      provider text NOT NULL,
      type text NOT NULL,
      name text NOT NULL,
      encrypted_credentials jsonb NOT NULL,
      external_account_id text,
      status text NOT NULL DEFAULT 'connected',
      configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
      last_health_check_at timestamptz,
      last_error jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
    // ── 2. Unique constraint: one connection per (org, provider, type) ──────
    console.log('2. Creating unique constraint on (organization_id, provider, type)...');
    await client `
    CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_org_provider_type_unique
    ON provider_connections (organization_id, provider, type)
  `;
    // ── 3. Indexes for common query patterns ────────────────────────────────
    console.log('3. Creating indexes...');
    await client `
    CREATE INDEX IF NOT EXISTS provider_connections_status_idx
    ON provider_connections (status)
  `;
    await client `
    CREATE INDEX IF NOT EXISTS provider_connections_organization_id_idx
    ON provider_connections (organization_id)
  `;
    // ── 4. Validation: encrypt/decrypt round-trip ───────────────────────────
    console.log('4. Validating encryption round-trip...');
    const encryptionKey = process.env.APEX_ENCRYPTION_KEY;
    if (!encryptionKey) {
        console.warn('⚠️  APEX_ENCRYPTION_KEY not set — skipping encryption validation');
        console.warn('   Provider connections will be created but credentials will NOT be encrypted.');
        console.warn('   Set APEX_ENCRYPTION_KEY to a 32-byte hex or base64 value for production.');
    }
    else {
        const testPayload = { apiKey: 'sk-test-1234567890', refreshToken: 'test-refresh' };
        const encrypted = await encrypt(testPayload, encryptionKey);
        const decrypted = await decrypt(encrypted, encryptionKey);
        if (JSON.stringify(decrypted) === JSON.stringify(testPayload)) {
            console.log('   ✓ Encryption round-trip OK');
        }
        else {
            console.error('   ✗ Encryption round-trip FAILED');
            console.error('   Encrypted:', encrypted);
            console.error('   Decrypted:', decrypted);
            throw new Error('Encryption validation failed — provider_connections cannot be used safely');
        }
    }
    // ── 5. Dry-run: insert a test connection (will be deleted) ──────────────
    console.log('5. Dry-run: inserting and reading a test connection...');
    const testOrgId = 'test-org-' + Date.now();
    const testConnection = {
        organization_id: testOrgId,
        provider: 'telnyx',
        type: 'telephony',
        name: 'Test Telnyx Connection',
        encrypted_credentials: '{"apiKey":"sk-test-encrypted"}',
        external_account_id: 'test-acct-' + Date.now(),
        status: 'connected',
        configuration: '{"sampleRate":8000,"maxDurationSeconds":300}',
    };
    await client `
    INSERT INTO provider_connections
      (organization_id, provider, type, name, encrypted_credentials, external_account_id, status, configuration)
    VALUES
      (${testConnection.organization_id}, ${testConnection.provider}, ${testConnection.type},
       ${testConnection.name}, ${testConnection.encrypted_credentials}, ${testConnection.external_account_id},
       ${testConnection.status}, ${testConnection.configuration})
    ON CONFLICT (organization_id, provider, type) DO NOTHING
  `;
    const rows = await client `
    SELECT id, provider, type, name, status, created_at
    FROM provider_connections
    WHERE organization_id = ${testOrgId}
      AND provider = 'telnyx'
      AND type = 'telephony'
    LIMIT 1
  `;
    if (rows.length === 1) {
        console.log(`   ✓ Test connection created: ${rows[0].name} (${rows[0].provider}/${rows[0].type})`);
    }
    else {
        console.warn('   ⚠ Test connection not found — ON CONFLICT may have prevented insert');
    }
    // Clean up test row
    await client `
    DELETE FROM provider_connections
    WHERE organization_id = ${testOrgId}
  `;
    console.log('   ✓ Test connection cleaned up');
    // ── 6. Migration complete ────────────────────────────────────────────────
    console.log('');
    console.log('═══ Migration complete ═══');
    console.log('');
    console.log('provider_connections table is ready.');
    console.log('Next step: wire encrypted credential storage into the provider connection tools.');
}
migrate().catch(err => {
    console.error('Migration failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
}).finally(() => {
    client.end();
});
