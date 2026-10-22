# BUILD PLAN: APEX Email Audit Gateway (memo "Logging Every Email Marcus Cole Sends", Option 3)

Owner: Forge (lead developer) for Matthew Reardon. Date: 2026-10-21. Status: **draft PR, nothing deployed, no migration run, no DB written, no webhook created, no email sent.**

Source memo: https://docs.google.com/document/d/14cnqn4EXJWfF2OQMY2_6BbviUD90w97K_i-4WGxHf-Y/edit

## 1. Goal

Every email any APEX agent (Marcus Cole first) sends has a tamper-evident record written **before** the provider sees it. Independent witnesses (provider webhooks, provider logs) are checked against that record every night, and a copy goes somewhere the agents can't write.

## 2. Architecture

```
agent (Marcus via Telnyx -> marcus-email draft/confirm)        APEX tools (send_email ...)
            \                                                   /
             +--> sendViaGateway()  [EMAIL_AUDIT_GATEWAY_ENABLED]
                    1. sender policy (wtpnews.org blocked on Resend until verified)
                    2. INSERT hash-chained row -> outbound_audit   (apex_audit_writer, INSERT-only)
                       fails closed: no row, no send
                    3. provider.send()  [EMAIL_AUDIT_PROVIDER_SEND_ENABLED, else dry run]
                    4. INSERT 'accepted' / 'failed' -> email_events
Resend (Svix HMAC) --+
Brevo (bearer+IP) ---+--> /api/email-audit/webhooks/{resend,brevo,ses} -> email_events (dedup on provider event id)
SES -> SNS (RSA) ----+     [EMAIL_AUDIT_WEBHOOKS_ENABLED]
Nightly cron: reconcile (chain verify + provider logs vs audit) -> email_reconciliation_* + alert to Matthew
Nightly cron: export new rows (metadata + hashes, no bodies) -> locked Google Sheet (Matthew owns)
Dashboard: GET /api/email-audit/{sends,agents,chain} behind requireAdminAuth, apex_audit_reader connection
```

Code (this PR): `packages/api-server/src/email-audit/`
| File | Purpose |
|---|---|
| `flags.ts` | Six flags, all default off (only exact `"true"` enables) |
| `chain.ts` | Canonical form, `row_hash = sha256("v1\n" + canonical_json + "\n" + prev_hash)`, chain verify, legacy digest, genesis |
| `gateway.ts` | `sendViaGateway` (audit-first, fail-closed), sender-domain policy, provider + store ports |
| `store-pg.ts` | Postgres store (advisory-locked append) and read-only reader |
| `webhooks.ts` | Resend / Brevo / SES(SNS) verification + normalisation into `email_events` |
| `reconcile.ts` | Pure reconciliation logic |
| `export.ts` | Sheet row builder, formula-injection guard, incremental export |
| `dashboard.ts` | Read-only API (non-GET -> 405) |
| `mount.ts` | Flag- and URL-gated mounting in `index.ts` |
| `genesis-cli.ts` | One-time genesis writer, `--dry-run` by default |
| `lib/db/src/audit-client.ts` | Separate least-privilege postgres connection factory |

Marcus prototype (`/workspace/marcus-email`, Python, draft/confirm, owner token, `SEND_ENABLED=false`) is **referenced, not merged**. Phase 2 change: its `confirm_email` stops calling Resend directly and instead POSTs the confirmed draft to an APEX gateway endpoint; its JSONL audit becomes secondary. It keeps its gates (owner caller, PBKDF2 token, 15-minute expiry, SEND_ENABLED). Marcus's Resend key is then held only by APEX (memo step 2, approval-gated).

**Sender constraint:** wtpnews.org is not verified in our Resend account. `senderAllowed()` rejects any Resend send from an unverified domain (list from `EMAIL_AUDIT_RESEND_VERIFIED_DOMAINS`; today only `donmatthews.live`). Marcus sends as `marcus@wtpnews.org` therefore need either (a) Resend domain verification for wtpnews.org (DNS change, approval), or (b) the Brevo/SES path already in the SPF record. Until then Marcus gateway sends run as dry runs.

## 3. Schema

### 3.1 `outbound_audit` (existing, ~190 rows), new **nullable** columns
`seq bigint, chain_version smallint, agent, persona, from_addr, to_addrs text[], cc_addrs text[], bcc_addrs text[], subject, body_hash, body_ref, provider, prev_hash, row_hash`. Existing columns (`id, project_id, tool_name, destination, lead_id, policy_mode, provider_id, rehearsal, detail, created_at`) unchanged. Unique partial indexes on `seq` and `row_hash`. Bodies are not stored, only `body_hash` (sha256 of html NUL text) and an optional `body_ref` (S3/Drive pointer).

Provider message id is **not** written back into `outbound_audit` (that would be an UPDATE); it lives in the `accepted` row of `email_events`, linked by `audit_id`.

### 3.2 `email_events` (new)
`id, provider, provider_event_id, provider_msg_id, audit_id, event_type (normalised), raw_type, occurred_at, received_at, signature_verified, payload jsonb`. Unique `(provider, provider_event_id)` so webhook retries are idempotent. UPDATE/DELETE blocked by trigger.

### 3.3 `email_reconciliation_runs`, `email_reconciliation_findings` (new)
Findings kinds: `provider_only` (provider sent something we never audited: the important one), `audit_only` (we audited, provider has no record and no failure event), `status_mismatch`, `chain_break`, `seq_gap`, `unchained_insert` (an old code path inserted without chaining after genesis).

### 3.4 Triggers
- `outbound_audit_no_update` / `_no_truncate`: block UPDATE, DELETE and TRUNCATE for **every** role, owner included.
- `outbound_audit_chain_check`: for `chain_version IS NOT NULL` inserts, takes `pg_advisory_xact_lock`, requires `prev_hash` = current tail `row_hash` (or 64 zeros for the first row) and a 64-char `row_hash`. Legacy-style inserts (`chain_version IS NULL`) from existing code (`outbound-policy-store.ts`, `send-safeguard-store.ts`) still succeed, so nothing breaks, and reconciliation flags them.

## 4. Migration plan (additive only)

Files (in PR, **not run**):
1. `lib/db/drizzle/20261021_email_audit_chain.sql`: columns, sequence, indexes, triggers, new tables. One transaction. No row rewrites, no drops.
2. `lib/db/drizzle/20261021_email_audit_roles.sql`: roles and grants.
3. `lib/db/drizzle/email-audit/20261021_email_audit_chain.down.sql`: rollback.

Neither file is referenced by `migrate-production.ts`, `crm-migration.ts` or `client.ts`, so a deploy of this PR does **not** apply them. `schema.ts` is untouched, so no Drizzle drift.

### 4.1 Order
1. Snapshot: `pg_dump -t outbound_audit -t email_sends` to the backup bucket; record `count(*)` for both (expect ~190 / ~161).
2. Apply migration 1 as the table owner in a maintenance window (DDL only; `ALTER TABLE ADD COLUMN` nullable without default is metadata-only, so no lock on reads).
3. Apply migration 2 (roles). Create LOGIN users interactively; passwords go into Railway/VPS secrets, never git.
4. Genesis (below).
5. Set `EMAIL_AUDIT_WRITER_DATABASE_URL` / `EMAIL_AUDIT_READER_DATABASE_URL`; flags still off.

### 4.2 Existing rows
The ~190 legacy rows are **not modified** (an UPDATE backfill would contradict append-only and change rows that may already be evidence). They are sealed by the genesis row instead.

### 4.3 Genesis row
`genesis-cli.ts` (reader URL) computes `legacy_digest = sha256` over every legacy row (ordered by `created_at, id`, fixed field order) and prints `{legacy_count, legacy_digest, genesis_row_hash}` in dry run. Matthew records the digest (in the Drive doc). With `--execute` (writer URL) it inserts `seq=1, tool_name='audit_genesis', policy_mode='genesis', prev_hash=000…0, detail={legacy_count, legacy_digest}`. Any later edit to a legacy row changes the recomputed digest, and the reconciliation job and dashboard check it nightly. `email_sends` (~161 rows) stays the campaign working table and is not chained. Its sends are reconciled against provider logs, and those that predate genesis show up as `provider_only` history for the first run only (the window starts at genesis).

### 4.4 Roles and grants
- `apex_audit_writer` (NOLOGIN): `INSERT` on `outbound_audit`, `email_events` and the reconciliation tables. Column-limited `SELECT (id, seq, row_hash, chain_version, provider, provider_id)` to read the tail, plus `USAGE` on the sequence. No UPDATE, DELETE or TRUNCATE.
- `apex_audit_reader` (NOLOGIN): `SELECT` on all four tables.
- `REVOKE UPDATE, DELETE, TRUNCATE … FROM PUBLIC`.
- LOGIN users `apex_audit_gateway` and `apex_audit_viewer` are members. The main app owner credentials keep working for existing code, but the triggers still stop them from mutating rows.

### 4.5 Rollback
- Code: all flags off. That restores today's behaviour exactly, because nothing is mounted and nothing calls the gateway.
- DB: export first, then run the `.down.sql`. It drops the triggers and functions, **renames** the new tables to `*_retired` (it doesn't drop them, so the evidence survives), revokes the role grants and leaves the nullable columns in place. Legacy rows are untouched in both directions.

## 5. Webhook verification plan
| Provider | Mechanism | Env | Failure |
|---|---|---|---|
| Resend | Svix HMAC-SHA256 over `id.timestamp.rawBody`, key = base64 after `whsec_`, ±5 min tolerance, multiple `v1,` sigs (rotation). Reuses the fixed `verifySvixSignature`. | `EMAIL_AUDIT_RESEND_WEBHOOK_SECRET` (a new endpoint, separate from the existing `/api/resend/webhook`) | 403, nothing written |
| Brevo | Brevo doesn't HMAC-sign. Requires `Authorization: Bearer <token>` (constant-time compare) configured on the webhook, plus an optional source-IP/CIDR allowlist of Brevo's published ranges | `EMAIL_AUDIT_BREVO_WEBHOOK_TOKEN`, `EMAIL_AUDIT_BREVO_ALLOWED_CIDRS` | 403 |
| SES | SES event publishing to an SNS topic to an HTTPS subscription. SNS RSA signature (SigV1 SHA1 / SigV2 SHA256) verified against a cert fetched only from `https://sns.<region>.amazonaws.com/*.pem` (cached). `TopicArn` pinned. SubscriptionConfirmation is **not** auto-confirmed (returns 202). The operator confirms it by hand. | `EMAIL_AUDIT_SES_TOPIC_ARN` | 403 / 502 |

All three fail closed (503) when their secret is unset, dedupe on the provider event id, store the payload in `email_events` and never touch `outbound_audit`. Secrets are read from env and never logged.

## 6. Reconciliation job (nightly, Railway cron or VPS cron)
Flag `EMAIL_AUDIT_RECONCILE_ENABLED`. Window: the previous 24 h plus a 48 h lookback for late events.
1. Verify the **whole** chain (`verifyChain`) and recompute the legacy digest against genesis.
2. Pull provider logs read-only: Resend `GET /emails` (list), Brevo `GET /smtp/statistics/events`, SES via the event-destination archive (SNS to S3/Firehose, or CloudWatch). IMAP Sent-folder sync for marcus@wtpnews.org is memo Layer C, phase 3.
3. `reconcile()` produces the findings, which are written to `email_reconciliation_*`.
4. If there are any `provider_only`, `chain_break`, `seq_gap` or `unchained_insert` findings, send Matthew one digest alert. The alert is itself sent through the gateway and audited, and it needs the notification approval.
Cost: free API calls, and a few seconds of runtime on infrastructure that already exists.

## 7. Nightly export
Flag `EMAIL_AUDIT_EXPORT_ENABLED`. Appends rows with `seq > last exported seq` to a Google Sheet that **Matthew owns**. A dedicated service account has edit access to that one sheet, agents get view-only or no access, and the sheet is locked (Drive "read-only" lock plus protected ranges). Columns: seq, id, created_at, agent, persona, from, to, cc, bcc, subject, provider, policy_mode, body_hash, prev_hash, row_hash. No bodies. Cells that start with `= + - @` are prefixed with `'` to block formula injection. Because the sheet holds `row_hash`, it is an off-database witness: if anyone rewrote the DB chain, it would no longer match the sheet.

## 8. Dashboard
`GET /api/email-audit/sends?agent=&to=&since=&limit=`, `GET /api/email-audit/agents?days=`, `GET /api/email-audit/chain`. These are mounted after `requireAdminAuth` (Matthew's operator login), only when `EMAIL_AUDIT_DASHBOARD_ENABLED=true` and the reader URL is set. Non-GET requests return 405. A small React page in `@workspace/dashboard` is phase 2. It shows search, filters, per-agent counts, chain status and the latest reconciliation findings.

## 9. Flags (all default off)
`EMAIL_AUDIT_GATEWAY_ENABLED`, `EMAIL_AUDIT_PROVIDER_SEND_ENABLED`, `EMAIL_AUDIT_WEBHOOKS_ENABLED`, `EMAIL_AUDIT_RECONCILE_ENABLED`, `EMAIL_AUDIT_EXPORT_ENABLED`, `EMAIL_AUDIT_DASHBOARD_ENABLED`. Rollout: webhooks first (passive), then the dashboard, then the gateway in dry run (`PROVIDER_SEND` off), then reconcile and export, then live provider send for Marcus, and finally all agents moved onto the gateway with direct provider keys revoked.

## 10. Test plan
- **Unit/integration (in PR, `src/__tests__/email-audit.test.ts`, 21 tests):**
  - flags default off, and nothing is mounted without flags and DB URLs
  - canonicalisation
  - chain verification catches tampering, gaps, a bad genesis and prev mismatches
  - the legacy digest is stable regardless of row order and changes on any edit
  - the gateway writes its audit row before the provider call
  - the gateway fails closed on an audit-write failure and refuses to send without a genesis row
  - dry run audits without sending, and provider failures are recorded
  - wtpnews.org is blocked on Resend
  - Resend: good and bad signatures, plus dedupe
  - Brevo: token check and CIDR allowlist
  - SES: a real RSA-signed SNS message, topic pinning, cert-host pinning, and no auto-confirm
  - every provider returns 503 when unconfigured
  - reconciliation produces each finding kind
  - export is incremental and blocks formula injection
  - the dashboard is read-only
- **Pre-prod DB test (after approval #1, on a Neon branch or local Postgres, never prod):** apply the up migration, then confirm:
  - UPDATE, DELETE and TRUNCATE all raise
  - a wrong `prev_hash` insert raises
  - concurrent appends serialise
  - `apex_audit_writer` can't UPDATE or SELECT bodies
  - genesis dry run and execute both work
  - after the down migration, legacy rows are byte-identical (compare against the pre-migration digest)
- **Staging smoke test:** turn on webhooks only. Send provider "test event" webhooks (no real email). Check that `email_events` rows land and that a bad signature gets a 403.

## 11. Approvals Matthew must give (numbered)
1. **Run migration 1** (`20261021_email_audit_chain.sql`) on production Postgres. Snapshot first, maintenance window.
2. **Write the genesis row**: review the dry-run `legacy_count` / `legacy_digest`, then authorise `--execute`.
3. **Create the DB roles** (`20261021_email_audit_roles.sql`) and the two LOGIN users. Passwords go into the hosting secret store.
4. **Provider webhooks and secrets:** (a) a new Resend webhook pointed at `/api/email-audit/webhooks/resend` and its signing secret; (b) a Brevo transactional webhook with a bearer token; (c) an SES configuration set, an SNS topic and an HTTPS subscription that is confirmed by hand. Store each secret in env.
5. **Google Drive Sheet:** create the locked export Sheet owned by Matthew, a service account with edit access to that sheet only, and the agents' access level (view or none).
6. **Deploy:** merge this PR and deploy (flags off), then each flag flip in the rollout order in §9 is its own go-ahead, including `EMAIL_AUDIT_PROVIDER_SEND_ENABLED`, which turns real sending on.
7. **Cron jobs:** schedule the reconciliation and export jobs, and approve the alert email to Matthew.
8. **Marcus integration:** point marcus-email `confirm_email` at the gateway, and keep its `SEND_ENABLED=false` until it's tested.
9. **Sender domain:** verify wtpnews.org in Resend (DNS records on Namecheap), or approve Brevo/SES as Marcus's provider.
10. **Key rotation (memo step 2):** make APEX the only holder of Marcus's provider keys and revoke the rest. This changes how live agents send.
11. **Retention and access:** set the retention period (memo suggests 2 years), who can view the log, and the privacy note in the AI-persona policy.
12. **Spend:** expected **$0 to $10/mo**: no new paid services. Resend, Brevo and SNS webhooks are free at this volume, and SNS/S3 for SES events is pennies. Any spend above $0 needs your explicit OK.

## 12. Out of scope here
IMAP Sent sync (memo Layer C), SPF/DMARC changes, the dashboard UI page, the provider log fetchers (the interfaces are defined, and the adapters are phase 2), and migrating existing `send_email` tool paths onto the gateway.
