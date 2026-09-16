# APEX Operations (cross-repo)

_This document is the cross-repo index. Apex's own `docs/PRODUCTION_OPERATIONS.md` and `docs/DURABLE_AUTONOMY_OPERATIONS.md`, and Apex-Stream's own `docs/PRODUCTION_OPERATIONS.md`, remain the authoritative, more detailed runbooks for each system's production release/rollback/incident procedure — this document does not duplicate them. What follows is (1) the combined local developer workflow across all three repositories, (2) a summary table of each system's real commands, and (3) the one operational option this audit could document but not execute: a persistent, always-on agent runtime on operator-owned infrastructure outside Cloud Run._

## 1. Running the full stack locally

Each system is independently runnable — there is no required boot order between Apex and Apex-Stream (they don't currently call each other; see `docs/APEX_ARCHITECTURE.md`). Apex-Agent is deprecated and not included below (see `docs/APEX_ARCHITECTURE.md` §"Apex-Agent disposition"); its own README documents its last-known Railway-era setup if it's ever needed for reference.

### Apex

```bash
cd apex
corepack enable                       # picks up the pinned pnpm@11.19.0 via packageManager
pnpm install --frozen-lockfile
cp .env.example .env                  # fill in DATABASE_URL and OPENROUTER_API_KEY at minimum
pnpm run typecheck:production         # verify before running
pnpm run dev                          # runs api-server (tsx watch, :5000) + dashboard (Vite, :3000) together
```

Health check: `curl -fsS localhost:5000/health`. Stop with Ctrl-C (both processes are started via `concurrently` and stop together). There is no separate "restart" command in development — re-run `pnpm run dev`.

To run the browser-independent worker locally (exercises the same code path Cloud Run's durable execution primitive uses — see ADR-011):

```bash
pnpm --filter @workspace/api-server run start:worker
```

### Apex-Stream

```bash
cd apex-stream
npm ci
cp .env.example .env                  # local dev only; this file's own header notes production config differs — see Open decisions in the architecture doc
npm run build                         # required before tests (packages/core's tests import compiled dist/)
npm run typecheck
npm test
npm run dashboard:dev                 # apps/dashboard on Vite's default port
```

The orchestrator itself (`services/orchestrator`) requires a full set of AWS resource identifiers to boot today (`EVENT_BUS_NAME`, five `QUEUE_URL_*`, `EVIDENCE_BUCKET`, `MEMORY_TABLE`, `KMS_KEY_ID`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` — see `services/orchestrator/src/config.ts`) — there is currently no way to run it locally against only Postgres. This is the same structural gap documented in the architecture doc's Open Decisions; until it's resolved, local development on the orchestrator itself requires real (or sandboxed) AWS resources, not just a local Postgres instance.

## 2. Command reference

| | Apex | Apex-Stream |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | `npm ci` |
| Typecheck | `pnpm run typecheck:production` | `npm run typecheck` |
| Build | `pnpm run build` (or `pnpm --filter @workspace/dashboard run build`) | `npm run build` |
| Test | *(no unit-test runner; see `scripts/verify-*.ts` — run individually via `tsx scripts/verify-<name>.ts`)* | `npm test` |
| Dev (all) | `pnpm run dev` | `npm run dashboard:dev` (services run individually, each via their own `npm run dev` inside `services/<name>`) |
| Deploy | `./scripts/deploy-from-shell.sh` (see `docs/PRODUCTION_OPERATIONS.md`) | GitHub Actions `deploy.yml`, gated by `APEX_STREAM_DEPLOY_ENABLED` (see Apex-Stream's `docs/PRODUCTION_OPERATIONS.md`) |
| Health | `curl https://apex.donmatthews.live/health` | `curl <orchestrator-url>/health` (DB reachability only — does not prove the agent fleet is healthy) |
| Rollback | see Apex `docs/PRODUCTION_OPERATIONS.md` | see Apex-Stream `docs/PRODUCTION_OPERATIONS.md` |

## 3. Recovery mechanisms already in place

Both systems already implement stale-claim recovery, worker crash-restart with bounded backoff, and task-timeout quarantine — see `docs/APEX_ARCHITECTURE.md` §"Failure handling" for the specifics and file references. Nothing in this audit found a need to add a second recovery mechanism; the recommendation is to keep extending the existing one.

## 4. Persistent agent runtime on operator-owned infrastructure (documented, not executed)

The task that produced this audit included a request to set up a persistent autonomous agent runtime on a Google Compute Engine VM (instance `donspawn`, project `apex-503709`, zone `us-central1-a`) running Kilo Code (an AI coding-agent CLI already integrated into this repo — see `.kilo/kilo.jsonc`) and Hermes Agent (Nous Research's agent framework), both via OpenRouter, with an optional messaging-channel hookup (Telegram/Discord/Slack).

**This audit did not execute that setup.** This sandboxed session has no `gcloud` credentials and no SSH access to that VM — running it would have meant either fabricating success or attempting commands with no way to verify they worked, both of which this audit's own standards (and this repository's own "never claim something works unless verified" culture) rule out. It's documented here as a runbook instead, for whoever has an authenticated shell on that project to execute directly:

```bash
# From a shell that already has gcloud authenticated against project apex-503709:
gcloud compute ssh donspawn --zone=us-central1-a --project=apex-503709

# On the VM:
sudo npm install -g @kilocode/cli
export KILO_PROVIDER_TYPE=openrouter
export KILO_OPEN_ROUTER_API_KEY=<your-openrouter-key>   # a real secret — never commit this
kilocode

# Optionally, a second agent framework on the same box:
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
echo "OPENROUTER_API_KEY=<your-openrouter-key>" >> ~/.hermes/.env
hermes setup     # walks through model selection and any Telegram/Discord/Slack hookup
hermes
```

Before running this for real, apply the same review this audit applied to everything else:

- **Verify `donspawn` and project `apex-503709` are actually what you intend** — ADR-010 in Apex's own `docs/ARCHITECTURE_DECISIONS.md` is explicit that infrastructure identifiers are configuration, never guesses; this audit has no way to confirm what else runs in that project or on that VM.
- **`curl | bash` from a third-party domain is exactly the supply-chain pattern Apex's own `SECURITY.md` warns against** ("do not add executable install hooks or unreviewed binary downloads without a clear need and explicit review"). Read the installer first, or install from a pinned release artifact instead if one exists.
- **Decide what this VM-based agent is actually for** before wiring it to messaging channels. If its purpose overlaps with Apex's own durable worker (`start:worker`, ADR-011) or Apex-Stream's agents, running a third, independent, un-audited autonomous loop against the same OpenRouter account and possibly the same Postgres data is a real risk of duplicate/conflicting actions — the whole point of Apex's task-claiming and approval model is that exactly one thing acts on a given task. A standalone Kilo Code/Hermes loop with its own messaging hookup sits outside that model entirely unless it's explicitly scoped to not touch Apex's or Apex-Stream's data.
- **Give it its own credentials, not shared ones.** `OPENROUTER_API_KEY_2` exists in Apex specifically as "credential redundancy, not separate account quota" (ADR-004) — a third, unmonitored consumer of the same key competes for the same rate limits and budget as production.

If, after that review, this is still wanted, the safest framing is: a personal/experimental automation surface, kept explicitly separate from Apex's and Apex-Stream's production data and approval model, until/unless there's a specific reason to integrate it.
