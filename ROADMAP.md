# APEX Production Roadmap

_Last reset to current source/operations: 2026-09-18._

Canonical production facts:

- APEX production runs on **Railway** — project `APEX`, service `apex-backend` — behind `https://apex.donmatthews.live`.
- Google Cloud Run is a retired host and the tested rollback path only (`APEX_DEPLOY_ENABLED` remains off while billing is disabled).
- AWS Lightsail/CodeBuild is retired and must not be restored.
- Production inference routes through OpenRouter; `packages/core/src/llm-client.ts` is the model-routing source of truth.
- Production is released only when `/health.build.sha` matches the intended commit and the task queue is healthy.

For operating rules, read `AGENTS.md`, `docs/ARCHITECTURE_DECISIONS.md` (ADR-015), `docs/PRODUCTION_OPERATIONS.md`, `docs/HOSTING_MIGRATION.md`, and `SECURITY.md`.

## Done — live on Railway (2026-09-18)

- Control plane, 13-agent workforce, dashboard, WebSocket LIVE keepalive, admin auth.
- Missions HTTP API and dashboard (live SHA `8cf1418`).
- Approval yield (ADR-014) observed in production (`approvalYields > 0`).
- Autonomy policy + Settings allowlist + decision-packet approvals (this change set).

## P0 — Finish the autonomy loop

- Enable Railway "Wait for CI" / checkSuites so red CI cannot ship `main`.
- Set `APEX_ARTIFACT_DIR` (or `APEX_ARTIFACT_BUCKET`) so finished files survive recycle.
- Deploy the commit that registers mission agent tools and the outbound compliance evaluator; confirm `/health.build.sha`.
- Exercise checkpoint/resume on a real long task (`checkpointsCreated` is still 0).
- Copy lead-research keys onto Railway (`BRAVE_SEARCH_API_KEY`, `FIRECRAWL_API_KEY`, `TAVILY_API_KEY`, `GOOGLE_PLACES_API_KEY`, `YELP_API_KEY`) — names only, values stay in the host.

## P1 — Reliability on this host

- Add a second replica only after websocket tickets in Postgres have been live-verified.
- Preview environments for APEX itself (Railway PR deploys).
- Verify in-process executor demotion of `runtime=job` tasks under load.
- Keep Cloud Run rollback path documented and gated.

## P2 — Observability and cost

- Daily operator digest already lands in CEO memory (`daily-report:YYYY-MM-DD`) with pending hard-gated approvals.
- Confirm OpenRouter unique-account count; a fourth key on the same account does not add quota.
- Alert on abnormal queue growth, WS disconnect storms, and SHA drift.

## P3 — Business operations

- Revenue-ops sales pipeline uses `sales_opportunities`, not the APEX ideas `opportunities` table.
- Do not auto-approve `send_email`, `make_outbound_call`, or connector sends.
- Re-verify BuildMyBot live pricing/features before customer-facing claims.

## Completion standard

A roadmap item is complete only when the intended behavior exists and the relevant layer has been verified. For production changes that means live `/health` evidence — not merely a commit or a green build.
