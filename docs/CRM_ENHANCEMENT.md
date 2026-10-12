# Enhanced operator CRM — scope and task decomposition

Status: **proposal for APEX CEO decomposition.** Extends `docs/CRM.md`; does not replace it.
Author: Hermes (operator session), 2026-10-12.

## 0. Why this is an extension, not a build

The operator CRM already ships: contacts + insert-only `contact_timeline`, full-text
`searchContacts` with tag/city/state/dnc/owner/replied/campaign filters, lifecycle stages,
tags, do-not-contact, `suppressions` with lift, duplicate detection + human merge,
`crm_tasks` follow-ups, the pipeline board (`pipeline_stages` / `sales_opportunities`),
companies, deal lifecycle with operator-session-gated wins, inbound mail/SMS capture,
Gmail readonly sync, lead import preview/import/undo, calendar booking, sequences, and a
knowledge base. Routes: `packages/api-server/src/routes/crm.ts`. Dashboard: `ContactsPanel`,
`CrmPipelinePanels`, `CrmOperatorPanels`, `PipelinePanel`.

**Do not re-build any of the above.** The four sections below are the genuine gaps.

---

## 1. Reporting & analytics layer  *(module: reporting)*

**Gap.** There is no `/api/crm/reports/*` route and no analytics screen. The pipeline board
shows current state only. Nothing answers: what converts, how fast, from where, and who.

**Scope**
- `GET /api/crm/reports/funnel` — stage-to-stage conversion and median/mean dwell time per
  stage, from `sales_opportunities` (`createdAt` → stage rows → `closedAt`). Read-only.
- `GET /api/crm/reports/velocity` — deals opened / won / lost / slipped per week, with the
  open total and weighted forecast, reuse figurers from `GET /api/crm/pipeline`.
- `GET /api/crm/reports/sources` — contacts and won value grouped by contact `source`
  (`researched-leads`, `newsroom`, `researched-lead` tag, campaign), i.e. which intake actually
  produces clients. This is the number that should drive lead-search spend.
- `GET /api/crm/reports/activity` — timeline volume by `eventKind` / `channel` / `actorType`
  over a window, from `contact_timeline`. Answers "is the swarm actually touching the book".
- `GET /api/crm/reports/winloss` — roll-up of `won_reason` / `lost_reason` counts and value.
- Dashboard: one `CrmReportsPanel.tsx` with the five views, honouring the existing
  America/Chicago display convention.

**Constraints**
- Read-only. Must not import or call any privileged write path.
- All queries bounded by `?from` / `?to` with a default window; no unbounded table scans.
- Add a `verify-crm.ts` assertion that the reporting routes are GET-only and touch no
  write function.

**Done when** each route returns real numbers against production data and the panel renders
them; a fixture-free smoke check exists.

---

## 2. Automation rules engine  *(module: automation rules)*

**Gap.** `sequences` / `sequence_steps` / `campaign_enrollments` exist, but they are
campaign-shaped. There is no operator-defined, general `when <trigger> then <action>` layer,
so every new behaviour is a code change.

**Scope**
- New tables `crm_rules` and `crm_rule_runs` in `schema-revenue-ops.ts`, plus a new
  idempotent migration file registered in `CRM_MIGRATION_FILES`.
- Trigger set (closed, enum-validated): `lifecycle_stage_changed`, `deal_stage_moved`,
  `reply_received`, `no_reply_after_days`, `task_due`, `opt_out_recorded`, `import_completed`.
- Action set (all must route through EXISTING guarded paths, never re-implement them):
  `create_task`, `set_tag`, `set_owner`, `enroll_in_sequence`, `notify_operator`.
  **Deliberately excluded from v1: any send action.** A rule may never originate an outbound
  send; that stays behind the send safeguard and a human.
- `crm_rule_runs` records rule id, trigger event, action taken, and outcome, so a rule that
  fires wrong is diagnosable rather than invisible.
- Evaluation is a background job in `packages/background-jobs/`, triggered off the same
  events that already write `contact_timeline` — do not add a second event bus.
- Loop guard: a rule action may not re-trigger the rule that produced it (depth cap of 1),
  recorded in `crm_rule_runs`.

**Constraints**
- A rule that would `opt_out_recorded` → anything must be refused at write time; opt-outs are
  terminal except for an explicit human lift.
- Rules must never bypass `assertContactSendable` or the send safeguard — enforced by simply
  not offering send actions.
- Every rule firing appends to the affected contact's timeline.
- Operator-session required to create/edit/enable a rule (`X-Apex-Operator-Session`), the
  same gate as merge and do-not-contact.

---

## 3. Agent-assisted CRM tools  *(module: integrations / automation)*

**Gap.** Agents hold exactly three read-only CRM tools (`crm_search_contacts`,
`crm_get_contact`, `crm_get_timeline`). They cannot log an activity, open a follow-up, or
draft a next action — so every agent observation dies in a log line.

**Scope** — add, in `packages/core/src/crm/tools.ts` only, all **audited and reversible**:
- `crm_log_activity` — append a timeline row for an observation (call attempted, research
  note). Append-only, so it composes with the insert-only invariant.
- `crm_create_followup` — create a `crm_tasks` row. Reversible (`POST /api/crm/tasks/:id/cancel`).
- `crm_suggest_lifecycle_change` — **write a suggestion, never the change.** Lifecycle stays
  hand-only (`lifecycleStageChangeAllowed`). The suggestion surfaces in the existing
  Approvals queue for a human.
- `crm_set_tag` — additive tags only; no tag removal.

**Explicitly still forbidden to agents** (verify-crm must keep asserting this): merge,
do-not-contact clear, suppression lift, lifecycle stage write, deal win, lead import,
rule authoring.

**Constraints**
- No new tool may appear in the privileged list; `verify-crm.ts` already asserts the
  privileged write function names never appear in `tools.ts` — extend that table.
- Every new tool is `sideEffect`-tagged in the registry so the turn-economy counters stay honest.

---

## 4. Data-hygiene / linkage pass  *(module: contact management)*

**Gap (measured, not assumed).** Contacts exist in `researched_leads` that never appear in
the book — that is a `crm_legacy_links` backfill linkage gap, **not a missing table**.
Separately, `pendingOrUnverified` is a frozen backlog: rows stamped `contactScanVersion` after
a transport failure are permanently unselectable, and the import lane can auto-**reject** on
`industryAffinity` mismatch rather than skip.

**Scope**
- Report route `GET /api/crm/reports/linkage` — count of `researched_leads` with no
  `crm_legacy_links` row, bucketed by campaign and age, so size is known before any fix.
- One-off, marker-guarded backfill for the misses (`crm_migration_markers`), dry-run first.
- Diagnose the frozen `contactScanVersion` bucket with SQL and report the bucket counts;
  **do not** silently widen the identity lane.

**Constraints — these are the traps that already cost hours**
- Never widen the import lane on industry affinity; identity tests only (name vs site domain /
  published canonical name). An import lane must never auto-reject.
- `researched_leads.id` is **TEXT**, not uuid — a uuid join silently drops every non-uuid id.
- Prove selector changes on a `CREATE TEMP TABLE` mirror then `rollback()`; never mutate a
  production row to test a selector.
- Read production through the Railway Postgres TCP proxy; `railway connect --ssh` does not
  work on this host.

---

## 5. Invariants every task must preserve

A task that violates any of these is wrong even if it works.

1. `contact_timeline` is **insert-only** — a DB trigger rejects UPDATE/DELETE, and
   `scripts/verify-crm.ts` asserts no file under `packages/core/src/crm/` contains
   `.update(contactTimeline)` / `.delete(contactTimeline)`. Reversals are new rows.
2. Privileged actions require the admin bearer **and** `X-Apex-Operator-Session`, checked in
   the **write path** (`lifecycleStageChangeAllowed(actor)` in `pure.ts`), not only at the route.
3. Privileged write functions must never appear in `tools.ts`; `tools.ts` must not import
   `operator.js`.
4. An opt-out is **lifted, never deleted**. Every `suppressions` reader must filter
   `isNull(liftedAt)`.
5. `contacts.lifecycle_stage` (prospect|lead|qualified|client|churned) is NOT `contacts.status`
   (record state).
6. `researched_leads.id` is TEXT.
7. A new CRM migration is a **new file** in `lib/db/drizzle/`, registered in
   `CRM_MIGRATION_FILES`, every statement idempotent, exactly-once work recorded in
   `crm_migration_markers`. Any `schema-revenue-ops.ts` change needs a matching `.sql` change
   or `verify-schema-migration-drift.mjs` fails the PR.
8. Source-structure guards match literal code — keep the words "DROP TABLE"/"DROP COLUMN" out
   of migration prose.
9. Typecheck **both** `packages/core/tsconfig.json` and `packages/api-server/tsconfig.json`.
10. Cloud agents must not wholesale-touch `lib/db/src/schema.ts`; verify the premise against
    `~/apex`, never against an agent's sandbox tree. A 1,323-line schema collapsing to ~40
    lines in one merge is the corruption signature, and the provenance gate exists for it.

## 6. Sequencing (what to do in what order)

1. **A1 reporting routes + panel** — read-only, zero risk, immediately useful. Start here.
2. **A4 linkage report route** — read-only; produces the number that scopes A4's backfill.
3. **A3 agent tools** — small, contained in `tools.ts`, unblocks the swarm's own CRM work.
4. **A2 rules engine** — largest surface; needs its own design review before any code, because
   it introduces an autonomous action layer.
5. **A4 backfill** — last, and only against the counted buckets, dry-run first.

## 7. Blocked / out of scope

- **Lead search is down** (brave 402 out of credits, serper 400, exa daily cap, brightdata
  unresponsive, as of 2026-10-12). Anything that enriches from search — including
  `BRAVE_LLM_CONTEXT` enrichment — cannot be verified end-to-end until a provider is restored.
  A1–A3 do not depend on search and can proceed now.
- **No send actions in v1 automation.** Not a gap to close later without a separate review.
