# APEX Campaigns

_Describes the sales/lead-campaign engine as it actually exists in Apex (`packages/background-jobs/src/campaign-runner.ts`, `leadCampaigns`/`campaignSegments` tables, `/api/campaigns`, `/api/leads`). Verified from source; end-to-end live behavior (does a campaign actually reach a real prospect and record a real response) was **not** re-verified in this audit — that requires live provider credentials and business-policy decisions (spend limits, consent lists) this audit does not have. Apex's own `ROADMAP.md` (P4) already tracks this as open; this document does not duplicate that tracking, only the technical shape._

## Designed outreach (2026-09-26)

The agent no longer has to invent a campaign at send time. `buildmybot-intro` in `packages/core/src/sales-playbooks.ts` is the seeded email, call, and follow-up. Sales Operations → Overview is the live floor: rehearsal ("Sell to me" emails and calls the operator as the buyer), recent sends with provider errors, and the legacy Telnyx conference join surface where applicable. Outbound sales, self-pitch, rehearsal, and Sales-agent campaign dials all resolve the same canonical Cartesia agent, "APEX Sales — BuildMyBot"; historical Telnyx/Vapi calls remain readable for compatibility. `POST /api/leads/import` accepts a CSV or JSON export, including columns from a third-party enrichment file; unknown columns are stored on `researched_leads.enrichment` and nothing is sent as part of import. Unresolved `{{merge}}` tokens fail the send instead of going out. A From-domain rejection stops the rest of that batch. Live unattended sends require the outbound policy described in `AGENTS.md`. The revenue-ops sequence runner still stops at `awaiting_approval` and is not this sender.

## What exists today

- **Campaign persistence**: `leadCampaigns` and `campaignSegments` tables (Postgres), with a unique-per-cell index on segments and stall detection (`lastProgressAt` + `STALL_AFTER_MS`) so a campaign that stops making progress is detectable rather than silently stuck.
- **Execution**: `CampaignRunner` (`packages/background-jobs/src/campaign-runner.ts`) is a dedicated polling loop, separate from the general job scheduler, with its own lease semantics on `campaign_segments`.
- **Lead sourcing**: tool-registry connectors to Yelp, Google Places, TomTom, Brave Search, Serper, Bright Data, keyless OSM/DuckDuckGo, and Firecrawl (see `.env.example` for the exact credential names — no values reproduced here). Tavily and BuildMyBot's Tavily proxy were removed from the search path on 2026-10-05 (operator decision, c7a61fc).
- **API surface**: `/api/campaigns` (CRUD + action endpoints), `/api/leads` (list/export/stats/patch).
- **Agent responsibility**: `LeadResearchAgent` (real outbound research against the configured ICP) and `SalesAgent` (pipeline review/prioritization — explicitly instructed to report when outreach isn't actually automated rather than fabricate activity, per its system prompt) own this domain, both under `COO`.
- **Email campaigns** (`emailCampaigns`/`emailSends`/`emailSuppressions` tables, added 2026-09-06): agent tools `start_email_campaign` (enqueue only), `send_email_campaign_batch` (paced, approval-gated sending), `get_email_campaign_status`. Delivery status (`sent`/`delivered`/`opened`/`clicked`/`bounced`/`complained`/`failed`) updates live via the Resend webhook (`routes/resend-webhook.ts`), with automatic bounce/complaint suppression. Until 2026-09-15 this had no human-facing surface at all — no route, no dashboard — despite `send_email_campaign_batch` already checking for and refusing to send a `paused` campaign. `/api/email-campaigns` (`routes/email-campaigns.ts`) and the **Email Campaigns** dashboard panel now expose list/detail with a full delivery funnel, and pause/resume/cancel, mirroring the `/api/campaigns` pattern above. The route only ever reads `emailSends` and flips `emailCampaigns.status`; it never sends anything itself.

## Search provider outages (2026-10-03)

At 20:34 UTC on 2026-10-03 the Tavily plan behind BuildMyBot's proxy reached its usage limit. APEX had no search key of its own, so every search came back empty. The runner treated each empty search as that segment's failure and closed 799 "US News" searches across 73 cities in 13 minutes.

The runner now tells an outage apart from an empty result (`packages/background-jobs/src/lead-search-capacity.ts`):

- **Outage:** a segment counts as an outage when every keyed source it tried was unavailable and none answered. Keyed sources are Brave, Serper, Bright Data, Yelp, Google Places and TomTom (Tavily and the BuildMyBot proxy until their removal on 2026-10-05). Unavailable means quota (402, 429, a 432/433 plan limit), a 5xx, a timeout, a rejected key, or an open circuit breaker.
- **Pause:** an outage puts the segment back to pending, hands its attempt back, and pauses claiming for 2 minutes, doubling up to 60. After each wait the runner sends one test search, and the first answer resumes normal batches.
- **Activity feed:** one line when a pause starts, one per failed test search, and one on resume.
- **Not an outage:** a source that answered with nothing is an honest empty. Keyless OSM or DuckDuckGo failures never pause search.
- **Dashboard:** the campaign card shows "waiting for search" and the cause, instead of "stalled".
- **Restarts:** the pause is process-local. After a restart, the first batch can hit a provider that is still down; those segments are handed back too.

The webSearch circuit breaker covers every keyed web source. It waits 30 minutes after a 401, 402, 403, 432 or 433 and 60 seconds after a 429. `scripts/verify-lead-search-capacity-pause.ts` and `scripts/verify-lead-search-pause-postgres.ts` replay the incident with Serper as the source that went down.

Searches closed before this change stay closed. Reopening them is a production data change.

## Saving researched leads (2026-10-04)

The campaign runner writes discovered leads itself. The Lead Researcher saves the leads it finds with `saveResearchedLead` and `saveResearchedLeadsBatch`. On 2026-10-04, those two tools changed:

- **US only.** A lead's city must name a US state or territory ("Lima, OH"), be a state on its own, or be a well-known US city ("Austin"). Anything else is refused with `OUT_OF_SCOPE_GEOGRAPHY` and nothing is saved. That covers a foreign place, a bare name that could be either ("Lima"), a missing city, and a contact phone with a country code other than +1. The refusal tells the agent to resubmit as "City, ST". The rule is in `packages/core/src/lead-geography.ts`, and no tool argument turns it off.
- **Duplicates explained.** A website already on file comes back with `duplicateDetails`: the existing lead id, which agent saved it, its producing task, status, pipeline state, and campaign.
- **Check without saving.** `lookupOnly: true` returns the same duplicate and geography answer and writes nothing.
- **Four outcomes.** A batch counts `saved`, `duplicates`, `refusedGeography` and `failed` separately and explains each one. `savedLeads` lists the new lead ids so the agent can mark them with `updateLeadStatus`.
- **Provenance.** Every saved row records its producing task in `pipeline_metadata.taskRef`. A batch save prefixes it with `agent_research_batch:` and adds a `batchId`.

Lead records can be updated (`updateLeadStatus`, `updateLeadContactInfo`, and `PATCH /api/leads/:id` for the operator). They cannot be deleted: there is no delete tool and no delete route. A lead that does not fit is marked `rejected`.

Rows saved before this change keep their old shape and are not re-checked.

## Lifecycle mapping

The originating brief's suggested lifecycle (`DRAFT → RESEARCH → TARGETING → CONTENT → READY → ACTIVE → FOLLOW_UP → ANALYSIS → OPTIMIZING → COMPLETED`) does not have a literal 1:1 status-enum match in the current schema — this audit did not invent one to force a match, since doing so without touching the actual state machine would just create a second, unenforced vocabulary layered on top of the real one. What exists instead: `campaignSegments` tracks per-segment progress with stall detection, and the campaign/lead API supports the underlying operations (research, targeting via segment definition, outreach via the runner, follow-up via lead patch/stats) without a single top-level campaign status field driving all of them. **Recommendation, not implemented in this audit**: if a single visible campaign-status field would help operators (rather than inferring status from segment states), add it as a small, additive schema change — not a rewrite of the runner.

## Guardrails already in place

- Approval gating on any tool with real external side effects (per `docs/APEX_AGENT_MODEL.md`).
- Stall detection prevents a campaign from silently going nowhere without surfacing it.
- `SalesAgent`'s own system prompt explicitly forbids reporting outreach as sent when the underlying channel isn't actually wired up — a deliberate anti-fabrication control specific to this domain, on top of the general non-completion guard.

## Guardrails **not** verified as in place

This audit did not find, and did not add, explicit machinery for: provider-specific rate limits, spend caps scoped to a campaign, consent/suppression-list enforcement, or anti-spam-law-specific checks (e.g., CAN-SPAM/TCPA-style rules) at the campaign-execution layer. If real outbound campaigns are running today, confirm these exist somewhere in the actual outreach-provider integration (not found in `packages/background-jobs` or `packages/core/src/tool-registry.ts`'s campaign-adjacent tools during this audit) before scaling volume. This is exactly the kind of "unknown business policy" this audit's own instructions say to flag rather than guess at.

Still true as of the 2026-09-15 email-campaigns surface work above: `emailSuppressions` covers bounce/complaint/manual opt-out, which is necessary but not sufficient for CAN-SPAM/TCPA-style compliance (no upfront consent tracking, no physical-address/unsubscribe-link enforcement in `bodyTemplate`). There is still no equivalent suppression concept for calling at all — see the call-campaign gap below. Do not read the new dashboard/API as a compliance control; it is observability and operator control over sends that were already happening, not a new guardrail on whether a send should happen.

## Call campaigns: single-call execution, no bulk dialer

There is still no separate bulk `call_campaigns` dialer/table that blasts a list in one provider request. APEX's real sales-call execution is deliberately one prospect at a time through the approval-gated `make_outbound_call` tool. A Sales-agent goal or calling campaign may invoke that tool repeatedly across its selected leads, but every invocation resolves the exact same Cartesia agent name, **`APEX Sales — BuildMyBot`**, and the exact approved originating number **+1 832-975-7665**. If either resolves ambiguously or is missing, the call fails closed rather than choosing another agent or caller ID.

Campaign-specific context does not require a new voice agent per campaign. `make_outbound_call` passes the lead/campaign/playbook identifiers plus that call's opening line and instructions as Cartesia dynamic variables to the canonical agent. The six APEX webhook tools handle lead lookup/qualification, calendar availability and booking, consented demo-link SMS, and durable outcome/DNC capture. A prospect-level DNC is written into APEX suppression state and checked before later outbound calls. This improves operational consistency; it does **not** by itself settle every TCPA, state recording-consent, or business-policy question, so the existing outbound approval/policy controls remain in force.

## Recommended next step

Before adding new campaign features, verify the one thing `ROADMAP.md` P4 already flags as unverified: a lead going all the way from research → contact → qualification → CRM handoff, with a real (even if small-scale) outcome recorded — not generated-lead counts. That live-path verification, not new schema, is the highest-value next step in this domain.
