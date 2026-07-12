# APEX ↔ Portfolio Integration

_How APEX commands the BuildMyBot.app AI workforce and receives leads/events
from donmatthews.live. Updated 2026-07-12._

## The model

APEX is the portfolio-level commander — Don's private tool. It does NOT
replace the BuildMyBot AI employees; they are its hands for that product.
They stay persistent and role-specific inside BuildMyBot (Vercel crons +
Supabase memory); APEX steers them, supervises them, and works across every
other project from Don's machine.

```
Don
 └── APEX (CEO → CTO/COO → specialists, local, approval-gated)
      ├── commands  → manager_briefings row   (every BuildMyBot role reads it
      │                                        FIRST on its next shift)
      ├── triggers  → /api/cron/all-shifts, /api/cron/lead-followups
      │                                        (Bearer CRON_SECRET)
      ├── reads     ← ai_team_log, error_logs, escalations, leads
      └── resolves  → error_logs.status after verified fixes
donmatthews.live
      └── leads     → POST buildmybot.app/api/leads/capture
                       (x-portfolio-secret)   → nurtured by the AI
                                                lead-followup worker
      └── GitHub webhooks → Discord (same channel as agent notifications)
```

APEX deliberately has NO GitHub write access and NO deploy authority over
BuildMyBot. After the `agent@buildmybot.app` incident (an unsupervised agent
pushing fabricated telemetry to production), autonomous prod writes go
through data channels only; code ships via branch-protected PRs.

## APEX tools (registered when env is configured)

| Tool | Approval | What it does |
|---|---|---|
| `buildmybot_status` | no | Today's shift outcomes, open errors, escalations, lead counts |
| `buildmybot_send_briefing` | yes | Writes today's `manager_briefings` row — the whole workforce prioritizes it next shift |
| `buildmybot_run_workforce` | yes | Fires all-shifts or lead-followups immediately |
| `buildmybot_open_errors` | no | Open error_logs rows, worst first |
| `buildmybot_resolve_error` | yes | Marks an error resolved with an audit note |
| `buildmybot_recent_leads` | no | Recent CRM leads with follow-up state |

Source: `packages/core/src/buildmybot-connector.ts`. Tools only register when
`BUILDMYBOT_SUPABASE_URL` + `BUILDMYBOT_SUPABASE_SERVICE_KEY` are set.

## Setup checklist

**APEX `.env`** (this repo — never commit real values):

```
BUILDMYBOT_SUPABASE_URL=https://evkjlnbpntimbxklnhoz.supabase.co
BUILDMYBOT_SUPABASE_SERVICE_KEY=<service role key>
BUILDMYBOT_APP_URL=https://www.buildmybot.app
BUILDMYBOT_CRON_SECRET=<same value as Vercel CRON_SECRET>
```

**Vercel project `buildmybot20`** (new vars beyond DEPLOYMENT.md's list):

```
PORTFOLIO_INTAKE_SECRET=<openssl rand -hex 32 — shared with donmatthews.live>
PORTFOLIO_OWNER_EMAIL=<the users-table email that owns portfolio leads>
DISCORD_WEBHOOK_URL=<agent notification channel>
SLACK_WEBHOOK_URL=<agent notification channel>
```

**Railway project donmatthews-live:**

```
PORTFOLIO_INTAKE_SECRET=<same as above>
BUILDMYBOT_INTAKE_URL=https://www.buildmybot.app/api/leads/capture
DISCORD_WEBHOOK_URL=<same channel — deploy + capture events>
GITHUB_WEBHOOK_SECRET=<required now; the endpoint returns 503 without it>
```

**Database:** the BuildMyBot migration
`supabase/migrations/20260711120000_agent_memory_error_recovery.sql` must be
applied before the workforce or intake run — it creates `ai_agent_memories`,
`error_logs`, the lead follow-up columns, and the `leads.source` /
`leads.source_bot_id` attribution columns.

## Daily operating loop (recommended)

1. Morning: ask APEX for `buildmybot_status` (with yesterday for trend).
2. APEX drafts the day's directive; you approve `buildmybot_send_briefing`.
3. Crons run the workforce (13:00 / 15:00 UTC); APEX can re-run on demand.
4. Critical failures ping Discord + Slack in real time; APEX triages
   `buildmybot_open_errors` and proposes resolutions for your approval.
5. donmatthews.live captures flow into the CRM automatically and appear in
   `buildmybot_recent_leads` / the LeadsCRM timeline.

Keep `APEX_APPROVAL_MODE=on`. The approval gate is what makes this a
command hierarchy instead of another unsupervised agent.
