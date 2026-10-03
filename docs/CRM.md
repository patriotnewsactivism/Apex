# CRM contact book

One contact record per person or organization, and an append-only timeline of every interaction. The tables live with the existing revenue-ops schema. The migration is `lib/db/drizzle/20261003_crm.sql` (applied by `applyCrmMigration` at the end of `migrate()`).

Every outbound path first calls `assertContactSendable`, which blocks a contact whose `do_not_contact` flag is set on any channel. It then goes through the send safeguard (`openOutboundSendJob` + `assertSendAllowed` in `packages/core/src/send-safeguard.ts`: two operator confirmations, the code at 5+ sends, the kill switch, and suppressions). Only after both does the provider call happen. The send safeguard's suppression check also reads the contact's `do_not_contact` flag, so a send already released in Pending Sends is blocked if the contact opts out on any channel before it goes out.

## Contacts page

The dashboard **Contacts** view (Revenue) searches name, organization, emails, phones, tags, notes, and message text. Filters cover tag, city, state, verified-only, do-not-contact, owner bot, last-contacted range, replied or not, and campaign. A contact opens to the profile, meetings, and a newest-first timeline. Times are stored in UTC and shown in America/Chicago. Matthew can set or clear do-not-contact from that page; the action is logged. Clearing do-not-contact and merging contacts require the dashboard session minted at password login (`X-Apex-Operator-Session`); the admin bearer token alone gets a 403, because scripts and agents hold it too. Clearing lifts only the contact-level flag. A channel suppression recorded by an SMS STOP, a bounce, or a complaint stays, so that channel stays blocked for that address: a STOP is an opt-out from texts until the person opts back in. Unmatched inbound mail and duplicate suggestions are on the same page. A merge happens only when Matthew clicks it, keeps both timelines, and is logged. Export CSV downloads the current filtered view.

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
