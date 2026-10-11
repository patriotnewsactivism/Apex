# CRM contact book

One contact record per person or organization, and an append-only timeline of every interaction. The tables live with the existing revenue-ops schema. The migration is `lib/db/drizzle/20261003_crm.sql` (applied by `applyCrmMigration` at the end of `migrate()`).

Every outbound path first calls `assertContactSendable`, which blocks a contact whose `do_not_contact` flag is set on any channel. It then goes through the send safeguard (`openOutboundSendJob` + `assertSendAllowed` in `packages/core/src/send-safeguard.ts`: two operator confirmations, the code at 5+ sends, the kill switch, and suppressions). Only after both does the provider call happen. The send safeguard's suppression check also reads the contact's `do_not_contact` flag, so a send already released in Pending Sends is blocked if the contact opts out on any channel before it goes out.

## Contacts page

The dashboard **Contacts** view (Revenue) searches name, organization, emails, phones, tags, notes, and message text. Filters cover tag, city, state, verified-only, do-not-contact, owner bot, last-contacted range, replied or not, and campaign. A contact opens to the profile, meetings, and a newest-first timeline. Times are stored in UTC and shown in America/Chicago. Matthew can set or clear do-not-contact from that page; the action is logged. Clearing do-not-contact and merging contacts require the dashboard session minted at password login (`X-Apex-Operator-Session`); the admin bearer token alone gets a 403, because scripts and agents hold it too. Clearing lifts only the contact-level flag. A channel suppression recorded by an SMS STOP, a bounce, or a complaint stays, so that channel stays blocked for that address: a STOP is an opt-out from texts until the person opts back in. Unmatched inbound mail and duplicate suggestions are on the same page. A merge happens only when Matthew clicks it, keeps both timelines, and is logged. Export CSV downloads the current filtered view.

## Client status

`contacts.lifecycle_stage` is where the person stands: `prospect` (researched, never contacted), `lead` (contacted, no answer yet), `qualified` (they answered and it fits), `client` (paying), `churned` (was a client, is not any more). It is separate from `contacts.status`, which is the record state (active, suppressed, merged, archived).

Only Matthew can move it. The rule is enforced at the write path (`lifecycleStageChangeAllowed` in `packages/core/src/crm/pure.ts`), not just at the route, so a future caller holding the admin token cannot move it either. Each move writes an audit row (`contact.lifecycle_stage_changed`) and a timeline row (`lifecycle_stage`), and moving a contact to the stage it is already in is a no-op. The contact list and the CSV export both carry it, and the list filters on it.

The migration also backfilled once: a contact that had already been sent to, called or had replied became `lead` rather than a bare `prospect`. That backfill records a marker in `crm_migration_markers`, so it never re-runs and never overrides a status you set by hand.

## Editing, notes, tags, and your own calls

`POST /api/crm/contacts`, `PATCH /api/crm/contacts/:id`, `POST /api/crm/contacts/:id/tags`, and `POST /api/crm/contacts/:id/calls` (log a call you made or took outside APEX; no provider call is placed). Every one of them appends a timeline row, so the contact card shows the edit next to the sends and replies, and a duplicate email or phone is refused with the id of the contact that already holds it rather than creating a second record to merge later.

## Follow-up tasks

`crm_tasks` (title, notes, due date, priority, kind, status, owner). The dashboard's **Due today** list reads every open task due before the end of today in America/Chicago, so an overdue follow-up stays visible, and it can be marked done, pushed to tomorrow, or cancelled from there. `contacts.next_follow_up_at` tracks the earliest open task, which is what the contact-list filter `followUpDueToday` reads.

## Researched leads into the contact book

Researched leads live in their own table until they are copied across. That copy is a reviewed step, not a script against production:

- `POST /api/crm/leads/import/preview` — the dry run. Nothing is written; it reports how many leads would become contacts, how many are already in the book (matched by email, phone, website domain, or company name), and why the rest are skipped.
- `POST /api/crm/leads/import` — the write. Requires `confirm: true` **and** an operator dashboard session. Each lead becomes a contact with source `researched-leads`, client status `prospect`, tags `researched-lead` plus its industry, and the lead's industry, fit reason and outreach angle kept in the contact's metadata.
- `POST /api/crm/leads/import/:batchId/undo` — the undo. Only the contacts that batch created are removed, and only while nothing has touched them: a contact since called, emailed, enrolled in a campaign or opted out is kept, and the undo reports which and why. The batch, its per-lead rows, and the undo are all on record, and the contact's own timeline rows stay (the timeline is insert-only).

`scripts/backfill-crm.ts` still refuses any non-local database. The dashboard action above is the path that writes to production, because it is reviewed and undoable.

## Lifting one opt-out

`POST /api/crm/suppressions/:id/lift` (operator session only) lifts **one** recorded opt-out. The row is never deleted: it is marked `lifted_at`, `lifted_by` and `lift_reason`, an audit row and a timeline row are written, and every place that reads a suppression now ignores a lifted one (`send-safeguard-store.ts`, `outbound-compliance-guard.ts`, `campaign-engine.ts`, `cartesia-sales.ts`). A fresh spoken opt-out can therefore write a new blocking record for the same number.

Lifting clears that channel only. Clearing the contact-level do-not-contact flag is a second, explicit decision (`alsoClearDoNotContact: true`) and is refused while another record still blocks the same person on that channel, so lifting one row cannot quietly unblock a person who opted out twice. `GET /api/crm/contacts/:id/suppressions` lists what is blocking that contact and what has been lifted. `DELETE /api/send-safeguard/suppressions/:id` now lifts the row through the same path instead of deleting it.

## Pipeline

The pipeline uses the `pipeline_stages` and `sales_opportunities` tables that already existed but had no screen and no API. `sales_opportunities` gained `expected_close_at`, `closed_at`, `won_reason`, `lost_reason` and `next_step`, plus the index the board reads on, and the migration seeds four default stages per position for this organization (`Qualified`, `Proposal sent`, `Negotiation`, `Verbal yes`). The seed fills only empty positions, so a stage you rename or add is never overwritten.

- `GET /api/crm/pipeline` — the board: each stage with its open deals and column total, plus the deals that have no stage at all (they would otherwise be invisible), the open totals (count, plain value, weighted by probability, and what is expected to close before the end of the month), and the won/lost counts and values.
- `POST /api/crm/deals`, `PATCH /api/crm/deals/:id`, `POST /api/crm/deals/:id/move` — open a deal (value, expected close, next step, probability), edit one, move it between columns. Amounts are entered in dollars and stored in cents; a blank value is no value, and a negative or absurd one is refused.
- `POST /api/crm/deals/:id/close` — `won` or `lost`, with the value that was actually agreed and the reason. A **win** requires the operator dashboard session, because a win is what turns the contact into a client (`lifecycle_stage = client`, recorded with the same changed-by attribution as a hand move). A deal that is already won or lost cannot be closed twice.

Every deal write appends to the linked contact's timeline (`deal_created`, `deal_stage`, `deal_won`/`deal_lost`, `deal_updated`) and to `audit_events`, so a deal's history is on the contact card next to the calls and emails. Nothing here is reachable from an agent: `tools.ts` neither calls nor imports these write paths, and verify-crm asserts it.

## Companies

- `GET /api/crm/companies` — search by name, domain or industry, with per-company contact count, open deals, open value and won value, so the list is a working view rather than a directory.
- `GET /api/crm/companies/:id` — the company page: its detail, every contact with their client status and do-not-contact flag, every deal with its stage and value, the open/won/lost totals, how many follow-ups are open across those contacts, and when anything last happened.

## Timeline

`contact_timeline` rejects UPDATE and DELETE with a trigger (`crm_reject_timeline_mutation`, errcode 55000). Corrections are new rows. A merge does not rewrite `contact_id`; `contact_merges` links the loser, and the winner's timeline read includes both histories.

Outbound email, SMS, calls, calendar invites, and provider call events write the timeline row in the same transaction as the send record. The provider HTTP call stays outside that transaction. `assertContactSendable` and the send safeguard both run before the provider call. A send held in Pending Sends writes no timeline row, because nothing was sent. Released email, texts, Cartesia calls, and call-bridge customer legs write it when they actually go out.

## Inbound mail and SMS

`POST /api/resend/inbound` verifies the Resend/Svix signature. Matching order is reply token, then In-Reply-To/References against a stored Message-ID, then sender address. Anything else waits in the unmatched queue. Attachments go through `AttachmentStorage`. The default implementation uses the artifact store (`APEX_ARTIFACT_BUCKET` or `APEX_ARTIFACT_DIR`). A reply pauses follow-ups and queued sequence steps. Bounces, complaints, and opt-out replies (`stop`, `unsubscribe`, `remove me`) set do-not-contact. A later send to that contact is blocked.

Inbound Telnyx SMS on `POST /api/telnyx-assistant/sms-inbound` verifies the ed25519 webhook signature. The old query-string key is accepted only when `TELNYX_SMS_QUERY_KEY_FALLBACK=true` and no signature header was sent.

## Matthew's own Gmail

Both options default off.

- BCC capture (`APEX_CRM_BCC_CAPTURE=true`) logs mail that includes `bcc@APEX_REPLY_DOMAIN` onto the matching contact.
- Gmail sync (`APEX_CRM_GMAIL_SYNC=true`) uses Google OAuth with scope `https://www.googleapis.com/auth/gmail.readonly` only. Tokens are encrypted with `APEX_ENCRYPTION_KEY`. The sync never sends mail.

## Environment

| Variable | Purpose |
| --- | --- |
| `APEX_REPLY_DOMAIN` | Reply host, for example `reply.example.com`. Unset omits Reply-To. |
| `TELNYX_PUBLIC_KEY` | Telnyx ed25519 public key, base64 raw 32 bytes. |
| `TELNYX_SMS_QUERY_KEY_FALLBACK` | Default `false`. |
| `APEX_CRM_BCC_CAPTURE` | Default `false`. |
| `APEX_CRM_GMAIL_SYNC` | Default `false`. |
| `GOOGLE_OAUTH_CLIENT_ID` | Gmail OAuth client. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Gmail OAuth secret. |
| `GOOGLE_OAUTH_REDIRECT_URI` | Gmail OAuth redirect. |
| `APEX_ENCRYPTION_KEY` | Encrypts the stored Gmail token. Already used elsewhere. |

## Scripts

- `scripts/import-contacts-csv.ts` — Newsroom Directory CSV. Tags `newsroom` and `tier-A` / `tier-B` / `tier-C`. Dry-run unless `--apply`.
- `scripts/backfill-crm.ts` — idempotent copy from the legacy lead, email, SMS, call, and audit tables. Dry-run unless `--apply`. Does not delete legacy rows.
- `scripts/verify-crm.ts` — source and Postgres checks. Set `CRM_TEST_DATABASE_URL` to a local `apex_crm_verify` database.

Both import and backfill refuse Railway, Supabase, and any non-local host. Do not point them at production.

## Agent tools

`crm_search_contacts`, `crm_get_contact`, and `crm_get_timeline` are read-only. There is no tool that clears do-not-contact or merges contacts, and the HTTP routes for both refuse a caller without an operator dashboard session.
