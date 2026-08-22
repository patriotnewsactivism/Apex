# Apex Lead Engine — Build Plan

_Ground truth measured live 2026-08-22 against Lightsail `apex-service`
(build `c8e8fa4`), Apex Supabase `zvbypuoobdobqiphhufe`, and BuildMyBot
Supabase `evkjlnbpntimbxklnhoz`. Every number below came from a query, not
from a doc._

## Context

Don wants three things:

1. Apex running on LLM capacity it does not exhaust.
2. Apex ready to actually **run** buildmybot.app, not just watch it.
3. The ability to hand Apex a lead-hunting brief ("find me 200 HVAC
   companies in Texas") and **watch it work through them**.

The measurements say the blocker is not what it looks like. Apex is not out
of quota — it is running on a quarter of its provider roster, its research
output has never reached the one worker that can act on it, and there is no
object in the system that represents "a lead hunt in progress," so there is
nothing to monitor even when it works.

---

## What is actually happening

### Finding 1 — Apex is starving, not exhausting

The provider roster in `packages/core/src/llm-client.ts` has **10 slots, 8 of
them free tier**. Only **4 have keys**:

| Provider | Env var | Key present | Calls today |
|---|---|---|---|
| `mistral` | `MISTRAL_API_KEY` | yes | 258 (1,961,012 tokens) |
| `google-gemini` | `GEMINI_API_KEY` | yes | 10 |
| `groq` | `GROQ_API_KEY` | yes (platform) | 12 |
| `groq-2` | `GROQ_API_KEY_2` | yes | 18 |
| `google-gemini-2` | `GEMINI_API_KEY_2` | **empty** | — |
| `sambanova` | `SAMBANOVA_API_KEY` | **empty** | — |
| `huggingface` | `HF_TOKEN` | **empty** | — |
| `nvidia` | `NVIDIA_API_KEY` | **empty** | — |

298 LLM calls in a full day, across a 13-agent workforce. Mistral absorbs
87% of it and then hits its ceiling with nothing behind it.

Meanwhile `integration_settings` still holds four keys **no provider consumes
any more**: `DEEPSEEK_API_KEY`, `TOGETHER_API_KEY`, `CEREBRAS_API_KEY_2`,
`CEREBRAS_API_KEY_3` (Cerebras was removed in `a1b5298` as billing-blocked).

The cost of the narrow roster:

| Day | Tasks done | Tasks failed | Success rate |
|---|---|---|---|
| 2026-08-22 | 15 | 115 | 12% |
| 2026-08-21 | 28 | 162 | 15% |
| 2026-08-20 | 23 | 398 | 5% |
| All time | 7,984 | 16,382 | 33% |

Every top failure signature is `All LLM providers failed`. The most recent
mode — 2,256 rows, latest 2026-08-22 10:01 — is
`(no providers were configured or had API keys)`, which `llm-client.ts:937`
emits when every provider was **skipped** (no key / in cooldown / over daily
cap), not when any of them actually errored. The message names the wrong
cause, which is why this has been read as a quota problem for weeks.

### Finding 2 — The escalation channel is a black hole

`approvals` holds **8,699 pending rows**. Of those, **8,683 are
`escalate_to_human`** (oldest 2026-07-30, newest 2026-08-22 07:00).

`escalate_to_human` is not approval-gated — `orchestration-tools.ts` writes an
`approvals` row as the "tell Don" channel. Nothing drains it. Agents have been
escalating into a void for three weeks, and the 16 genuinely gated calls
buried in there (14 `runShell`, 1 `create_pull_request`, 1
`buildmybot_send_briefing`) are unfindable.

### Finding 3 — Apex's leads never reach the worker that can act on them

This is the one that matters for "ready to run buildmybot.app." There are
**two separate Supabase projects with two different `researched_leads`
tables**:

| | Apex `zvbypuoobdobqiphhufe` | BuildMyBot `evkjlnbpntimbxklnhoz` |
|---|---|---|
| Rows | **4,722** | 1,606 |
| Newest row | 2026-08-21 | **2026-07-21** (a month stale) |
| Fit column | `fit_reason` | `why_good_fit` |
| Angle column | `outreach_angle` | `suggested_angle` |
| Researcher | `researched_by_agent_id` | `researched_by` |
| Extra | — | `source_query`, `surfaced_to_sales_at` |

`api/cron/_sales-outreach.ts` (Jordan Blake) is the **only** thing in either
system that sends a real email or places a real call. It reads
`researched_leads WHERE status IN (new, surfaced_to_sales)` — from
**BuildMyBot's** table. Apex's 4,722 leads live in a table it cannot see.

All 4,722 Apex leads are `status='new'`. Not one has ever been contacted,
qualified, or rejected. BuildMyBot's CRM `leads` table has **11 rows**.

The research engine works. The pipeline downstream of it does not exist.

### Finding 4 — There is no campaign object

Today, "go find leads" means: submit a goal → the CEO decomposes it however
the LLM decides that run → some agent calls `searchBusinessDirectory` and
`saveResearchedLeadsBatch`. There is no target count, no territory worklist,
no progress percentage, no ETA, no campaign id on the lead row, and no
pause/resume. `LeadsPanel.tsx` renders a flat table of all 4,722 rows with
status counts — a list, not progress.

Segmentation is also unusable as-is: 4,722 leads carry **819 distinct
industry strings** (`Real Estate` / `Real Estate Brokerage` /
`Real Estate Agents` / `real estate agency` are four separate buckets).

---

## The build

Four phases. They are ordered by dependency — campaigns cannot run reliably
on a starved provider pool, and pushing leads to BuildMyBot is pointless
until campaigns tag which leads to push.

### Phase 0 — Restore capacity  ✅ code landed, keys outstanding

**Correction found while implementing:** there is a *third* starvation cause,
and it is the largest single one. `APEX_TOKEN_CAP_TOTAL=2000000` is set in
production, and actual spend on 2026-08-22 was **2,160,261 tokens** — the
workforce hit the workspace-wide cap at ~07:00 UTC and every `complete()` call
for the following 17 hours failed fast with "spend paused until the UTC daily
reset". Mistral's free tier alone is ~33M tokens/day, so the cap was throttling
Apex to roughly 6% of capacity it already had. The plan originally said to
leave this unset pending a week of data; that was wrong. Raise it, and let the
per-provider caps do the load-spreading.

Landed:
- `logProviderRoster()` runs at boot and warns with the exact env var names of
  every empty slot (`llm-client.ts`); `GET /api/tokens` now returns `roster`
  alongside spend.
- `.env.example` carries corrected caps: `APEX_TOKEN_CAP_TOTAL=8000000` and
  per-provider `APEX_TOKEN_CAPS` sized to each published free tier. The dead
  `CEREBRAS_API_KEY` entry is gone.
- The total-cap error now states spend vs cap instead of just "cap reached".

Still needs Don: the four keys below, and the corrected cap values set on the
live Lightsail service.

Fills the four empty free-tier slots. All four are free, no credit card.

| Slot | Where to get the key |
|---|---|
| `GEMINI_API_KEY_2` | Second Google AI Studio project |
| `SAMBANOVA_API_KEY` | cloud.sambanova.ai |
| `HF_TOKEN` | huggingface.co/settings/tokens |
| `NVIDIA_API_KEY` | build.nvidia.com |

Set each through the Apex dashboard Settings panel — `routes/settings.ts`
writes to `integration_settings` **and** assigns `process.env[key]` live, so
they take effect without a redeploy (`settingsLoader.ts` re-applies at boot).

Then:
- Delete the four dead rows (`DEEPSEEK_API_KEY`, `TOGETHER_API_KEY`,
  `CEREBRAS_API_KEY_2`, `CEREBRAS_API_KEY_3`).
- Set `APEX_TOKEN_CAPS` so the governor spreads load instead of letting one
  provider absorb everything, e.g.
  `mistral:800000,groq:400000,groq-2:400000,google-gemini:500000,google-gemini-2:500000,sambanova:400000,huggingface:200000,nvidia:300000`.
- Leave `APEX_TOKEN_CAP_TOTAL` unset until a week of real per-provider data
  exists under the wider roster.

**Expected result:** free pool 4 → 8 providers, roughly 2× headroom before
the chain bottoms out, and a genuine fallback path when Mistral caps.

### Phase 1 — Make failure legible  ✅ landed

**1a. Fix the misleading error.** `packages/core/src/llm-client.ts` around
line 937: when `providerErrors` is empty, report per-provider *skip reasons*
that the loop already knows (`no key` / `cooldown: <until>` /
`over daily cap` / `paid, APEX_PAID_LLM_MODE not set`) instead of
`(no providers were configured or had API keys)`. Collect them into a
`skipReasons` array alongside `providerErrors` in the same loop that already
`continue`s at lines 666–690.

**1b. Split escalations from approvals.** Add `kind` (`'approval' |
'escalation'`) to the `approvals` table, default `'approval'`; write
`'escalation'` from `escalate_to_human`. Then:
- Dedupe: one open escalation per `(goalId, agentId, reason-hash)` — the
  8,683 rows are overwhelmingly the same handful of complaints repeated.
- Auto-expire escalations older than 7 days to `stale`.
- `ApprovalQueue.tsx` filters to `kind='approval'` by default with an
  Escalations tab beside it.
- One-time backfill: mark the existing 8,683 rows `kind='escalation'`,
  `status='stale'`.

### Phase 2 — The campaign object

This is the core of the ask. New tables in `lib/db/src/schema.ts`:

```ts
export const leadCampaigns = pgTable('lead_campaigns', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  goalId: text('goal_id'),                    // the goal that spawned it
  projectId: text('project_id'),              // 'buildmybot'
  icp: jsonb('icp').$type<{ industries: string[]; cities: string[]; notes?: string }>().notNull(),
  targetLeads: integer('target_leads').notNull().default(100),
  status: text('status').notNull().default('running'),  // running|paused|completed|completed_short|cancelled|failed
  pushToBuildmybot: boolean('push_to_buildmybot').notNull().default(false),
  createdAt, startedAt, completedAt, lastProgressAt,
});

export const campaignSegments = pgTable('campaign_segments', {
  id: text('id').primaryKey(),
  campaignId: text('campaign_id').notNull(),
  industry: text('industry').notNull(),
  city: text('city').notNull(),
  status: text('status').notNull().default('pending'), // pending|in_progress|done|exhausted|failed
  found: integer('found').notNull().default(0),
  saved: integer('saved').notNull().default(0),
  duplicates: integer('duplicates').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  leasedAt, lastError, completedAt, createdAt,
});
```

Plus `campaignId` on `researched_leads` (nullable — the existing 4,722 rows
keep NULL).

**A segment is one (industry × city) cell** — the unit of work and the unit
of progress. A brief of 4 industries × 10 cities makes 40 segments. Segments
get a real table rather than a `jsonb` array specifically so multiple
researcher agents can claim them concurrently under a lease, the way `tasks`
already does (`api-server/src/index.ts:278–321`).

**The runner is deterministic, not an LLM plan.** New
`packages/background-jobs/src/campaign-runner.ts`. Per tick:

1. Claim the next `pending` segment under a lease.
2. `searchBusinessDirectory("{industry} {city}")` — **zero LLM cost**. Yelp /
   Google Places / OSM return structured business records directly.
3. Drop websites already in `researched_leads`.
4. **One** LLM call per *segment* to write `fitReason` / `outreachAngle` for
   the whole batch — not one call per lead. If every provider fails, fall
   back to a deterministic template so the campaign degrades to plainer copy
   instead of dying.
5. `saveResearchedLeadsBatch` with `campaignId` attached.
6. Update segment counters + `lastProgressAt`, emit a WebSocket event.
7. Stop when `saved >= targetLeads` → `completed`; if segments run out first
   → `completed_short` with an honest count.

This is what makes the campaign survive a bad LLM day: the step that finds
businesses needs no model at all.

**Progress math** (computed in the route, never stored stale):

- Headline: `leadsSaved / targetLeads`
- Coverage: `segmentsDone / segmentsTotal`
- Yield: `leadsSaved / segmentsDone`
- ETA: `((target - saved) / yield) × avgSegmentDuration`
- **Stalled**: `status='running'` and `lastProgressAt` older than 15 min —
  surfaced as its own state, so a wedged campaign never reads as "running"

**Routes** (`packages/api-server/src/routes/campaigns.ts`, mounted like the
existing `/api/leads`):

```
POST   /api/campaigns                 create + start
GET    /api/campaigns                 list with computed progress
GET    /api/campaigns/:id             detail + per-segment grid
POST   /api/campaigns/:id/pause|resume|cancel
GET    /api/campaigns/:id/leads       leads from this campaign
POST   /api/campaigns/:id/push        push to BuildMyBot (Phase 3)
```

**Agent tools** (`packages/core/src/tool-registry.ts`, beside the existing
lead tools) so Apex can run campaigns conversationally too:

- `start_lead_campaign({ name, industries[], cities[], targetLeads, pushToBuildmybot })`
- `get_campaign_progress({ campaignId? })` — same computed numbers, so the
  CEO reports real progress instead of guessing
- `pause_lead_campaign` / `resume_lead_campaign`

**Industry normalization.** A small canonical map (`HVAC`, `Plumbing`,
`Roofing`, `Legal`, `Dental`, `MedSpa`, `Real Estate`, `Pest Control`, …)
applied on write, so segments and filters mean something. The 819 existing
strings get a one-time backfill pass.

### Phase 3 — Bridge Apex leads into BuildMyBot

New tool `buildmybot_push_leads` in
`packages/core/src/buildmybot-connector.ts`, using the `sbFetch` helper
already there:

- Read Apex `researched_leads WHERE campaign_id = X AND status = 'new'`
- Map columns: `fit_reason → why_good_fit`, `outreach_angle →
  suggested_angle`, `researched_by_agent_id → researched_by`, and set
  `source_query` to the campaign name
- POST to BuildMyBot `researched_leads` with
  `Prefer: resolution=ignore-duplicates` — the table has a **unique index on
  `website`**, so de-dup is handled by Postgres
- Mark the Apex rows `status='pushed_to_buildmybot'`
- Approval-gated, batch-capped (default 50/push)

Once a lead lands there, Jordan Blake's `_sales-outreach.ts` picks it up on
its next run — the path that was missing for a month.

**Safety:** `salesAutomationDryRun()` in `api/ai-team/lib.ts` defaults to
**true**, so outbound stays paused until `SALES_AUTOMATION_DRY_RUN=false` is
set deliberately. The whole bridge can be built and tested end-to-end with no
risk of an unintended email or call.

Also worth doing while in here: `_sales-outreach.ts` has **no cron entry** in
`vercel.json`. It only ever runs when triggered manually or via
`api/cron/[job].ts`. Either add the entry or have Apex drive it through the
existing `buildmybot_run_workforce` tool.

### Phase 4 — Watch it work

`packages/dashboard/src/components/CampaignsPanel.tsx`, following the
conventions already in `LeadsPanel.tsx` (react-query, `glass-card`, the
`--color-apex-*` tokens, 5s poll):

- A card per campaign: name, status pill, **progress bar (saved/target)**,
  coverage bar (segments), live counters, computed ETA
- A per-segment grid — one cell per (industry × city), colored by state, so
  the territory being worked through is visible at a glance
- A stall banner when `lastProgressAt` has gone quiet
- Pause / Resume / Cancel, and Push to BuildMyBot
- New WebSocket events off the existing `emitApexEvent` bus
  (`base-agent.ts:33`): `campaign:started`, `campaign:progress`,
  `campaign:segment`, `campaign:completed`

---

## Verification

Each phase has to be proven live, per the sequence in `AGENTS.md` — compile
and deploy are necessary, not sufficient.

**Phase 0** — after setting the keys, `GET /api/tokens` (admin auth) shows
8 providers with today's spend. Re-query the failed-task signature 24h later
and confirm `(no providers were configured or had API keys)` has stopped
appearing. Expect daily success rate to move off 12%.

**Phase 1** — force a failure with every provider in cooldown; the error must
name each provider and why it was skipped. `ApprovalQueue` shows 16 real
approvals, not 8,699 rows.

**Phase 2** — start a small campaign (1 industry × 3 cities, target 15).
Watch `campaign:progress` events arrive, the segment grid fill in, and
`researched_leads` gain rows carrying the right `campaign_id`. Pause it
mid-run and confirm segment leases release cleanly. Confirm the LLM cost is
one call per segment, not per lead, against `llm_token_usage_daily`.

**Phase 3** — push that campaign's leads; confirm the rows appear in
BuildMyBot Supabase with `why_good_fit` populated, then trigger
`_sales-outreach.ts` with `?preview=1` and confirm it *sees* them. Keep
`SALES_AUTOMATION_DRY_RUN=true` throughout.

**Phase 4** — drive a real 200-lead campaign from the dashboard end to end.

---

## Decisions needed from Don

1. **Does the Apex backlog get pushed?** 4,722 leads sit ready. They predate
   campaigns, so they have no `campaign_id` and their industry strings are
   messy. Options: push the cleanest subset after normalization, push nothing
   and start fresh with campaigns, or push all of them in capped batches.
2. **Directory provider.** `searchBusinessDirectory` currently falls through
   to OSM Overpass, which is thin. A free Yelp Fusion key (`YELP_API_KEY`, no
   credit card) returns far better data and would materially raise yield per
   segment.
3. **Outbound stays paused?** Phase 3 is safe to build with dry-run on.
   Turning it off is a separate, deliberate call.
