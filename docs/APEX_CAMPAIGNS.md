# APEX Campaigns

_Describes the sales/lead-campaign engine as it actually exists in Apex (`packages/background-jobs/src/campaign-runner.ts`, `leadCampaigns`/`campaignSegments` tables, `/api/campaigns`, `/api/leads`). Verified from source; end-to-end live behavior (does a campaign actually reach a real prospect and record a real response) was **not** re-verified in this audit — that requires live provider credentials and business-policy decisions (spend limits, consent lists) this audit does not have. Apex's own `ROADMAP.md` (P4) already tracks this as open; this document does not duplicate that tracking, only the technical shape._

## What exists today

- **Campaign persistence**: `leadCampaigns` and `campaignSegments` tables (Postgres), with a unique-per-cell index on segments and stall detection (`lastProgressAt` + `STALL_AFTER_MS`) so a campaign that stops making progress is detectable rather than silently stuck.
- **Execution**: `CampaignRunner` (`packages/background-jobs/src/campaign-runner.ts`) is a dedicated polling loop, separate from the general job scheduler, with its own lease semantics on `campaign_segments`.
- **Lead sourcing**: tool-registry connectors to Yelp, Google Places, Tavily, Brave Search, and Firecrawl (see `.env.example` for the exact credential names — no values reproduced here).
- **API surface**: `/api/campaigns` (CRUD + action endpoints), `/api/leads` (list/export/stats/patch).
- **Agent responsibility**: `LeadResearchAgent` (real outbound research against the configured ICP) and `SalesAgent` (pipeline review/prioritization — explicitly instructed to report when outreach isn't actually automated rather than fabricate activity, per its system prompt) own this domain, both under `COO`.

## Lifecycle mapping

The originating brief's suggested lifecycle (`DRAFT → RESEARCH → TARGETING → CONTENT → READY → ACTIVE → FOLLOW_UP → ANALYSIS → OPTIMIZING → COMPLETED`) does not have a literal 1:1 status-enum match in the current schema — this audit did not invent one to force a match, since doing so without touching the actual state machine would just create a second, unenforced vocabulary layered on top of the real one. What exists instead: `campaignSegments` tracks per-segment progress with stall detection, and the campaign/lead API supports the underlying operations (research, targeting via segment definition, outreach via the runner, follow-up via lead patch/stats) without a single top-level campaign status field driving all of them. **Recommendation, not implemented in this audit**: if a single visible campaign-status field would help operators (rather than inferring status from segment states), add it as a small, additive schema change — not a rewrite of the runner.

## Guardrails already in place

- Approval gating on any tool with real external side effects (per `docs/APEX_AGENT_MODEL.md`).
- Stall detection prevents a campaign from silently going nowhere without surfacing it.
- `SalesAgent`'s own system prompt explicitly forbids reporting outreach as sent when the underlying channel isn't actually wired up — a deliberate anti-fabrication control specific to this domain, on top of the general non-completion guard.

## Guardrails **not** verified as in place

This audit did not find, and did not add, explicit machinery for: provider-specific rate limits, spend caps scoped to a campaign, consent/suppression-list enforcement, or anti-spam-law-specific checks (e.g., CAN-SPAM/TCPA-style rules) at the campaign-execution layer. If real outbound campaigns are running today, confirm these exist somewhere in the actual outreach-provider integration (not found in `packages/background-jobs` or `packages/core/src/tool-registry.ts`'s campaign-adjacent tools during this audit) before scaling volume. This is exactly the kind of "unknown business policy" this audit's own instructions say to flag rather than guess at.

## Recommended next step

Before adding new campaign features, verify the one thing `ROADMAP.md` P4 already flags as unverified: a lead going all the way from research → contact → qualification → CRM handoff, with a real (even if small-scale) outcome recorded — not generated-lead counts. That live-path verification, not new schema, is the highest-value next step in this domain.
