# APEX Production Roadmap

_Last reset to current source/operations: 2026-08-28._

This is the living roadmap. It intentionally replaces the accumulated July/August historical build-plan narrative that previously lived here.

Canonical production facts:

- APEX production runs on the **existing Google Cloud Run service** behind `https://apex.donmatthews.live`.
- AWS Lightsail/CodeBuild and Railway are retired APEX hosting paths.
- Production inference routes through OpenRouter; `packages/core/src/llm-client.ts` is the model-routing source of truth.
- Production releases are existing-service-only and require exact build-SHA verification.
- Production database/Supabase management changes require separate target-specific verification and authorization; runtime DB access is not blanket management authority.

For operating rules, read `AGENTS.md`, `docs/ARCHITECTURE_DECISIONS.md`, `docs/PRODUCTION_OPERATIONS.md`, and `SECURITY.md`.

## P0 — Put the current productionized code live on Cloud Run

The repository has moved to the production OpenRouter/Cloud Run architecture, but source code being on `main` is not proof that Cloud Run is serving it.

Remaining release gate:

1. Obtain authenticated access to the **existing** APEX Google Cloud project/service configuration.
2. Resolve the exact existing project ID, region, and Cloud Run service name from trusted Google configuration; do not guess.
3. Confirm required Cloud Run secrets/config are present, including admin auth and OpenRouter credential names, without exposing values.
4. Run the full production CI gate on the release state.
5. Build the exact clean release commit through `cloudbuild.apex.yaml` with an immutable SHA tag.
6. Update only the existing Cloud Run service image.
7. Verify public `/health.build.sha` equals the release SHA and `taskQueue.verdict` is healthy.
8. Smoke-test login, dashboard, agent execution, OpenRouter inference/tool calls, scheduling, and the changed production paths.

Do not mark this milestone complete until the public service proves the release is live.

## P1 — Production reliability hardening

After the current release is proven live:

- verify scheduled task deduplication under real recurring load;
- harden multi-instance scheduler claiming so two Cloud Run instances cannot claim the same scheduled job;
- verify provider-capacity pauses do not consume normal task retry budgets;
- test manager/delegation follow-through so delegation itself cannot be mistaken for completion;
- validate graceful shutdown/restart behavior under Cloud Run instance replacement;
- exercise rollback to a known prior Cloud Run revision and verify health afterward.

Success means repeated work, provider exhaustion, and instance concurrency do not manufacture duplicate tasks or false failures.

## P2 — Observability and cost control

- expose useful non-secret OpenRouter/provider diagnostics to authenticated operators;
- confirm actual serving provider/model is recorded for production calls;
- measure per-role token usage, latency, retries, and failure classes;
- define operator-approved OpenRouter account spending limits and optional APEX token caps;
- alert on abnormal queue growth, repeated LLM capacity failures, authentication failure spikes, and unhealthy revisions;
- keep `/health` small, public, and non-secret while richer diagnostics stay authenticated.

Success means an operator can distinguish application failure, provider capacity, spend limits, and deployment staleness quickly.

## P3 — Autonomous engineering maturity

- strengthen self-healing CI around reproducible failures;
- preserve feature-branch/PR review for normal engineering changes;
- ensure production deploy/rollback remains approval-gated and provenance-verified;
- improve root-cause analysis and skeptical review loops using measurable outcomes rather than agent narration;
- validate repository-completion and multi-application orchestration against real projects without broadening production permissions unnecessarily.

Success means APEX can carry approved engineering work from diagnosis through tested implementation and verified release without losing auditability.

## P4 — Business-operations maturity

BuildMyBot and other portfolio operations must use their current live systems as source of truth, not dated repo snapshots.

Priorities:

- validate current BuildMyBot connector contracts against `patriotnewsactivism/buildmybot2` and live endpoints;
- verify lead research → CRM/outreach handoff end to end before scaling campaigns;
- measure campaign progress, conversion, failures, and follow-up state rather than counting generated leads as business results;
- keep external sends, calls, financial effects, and materially risky customer actions within explicit approval/standing-policy boundaries;
- update `BUSINESS_PROFILE.md` only after current commercial facts are independently verified.

## P5 — Controlled autonomy expansion

Increase autonomy by tightening policies, not deleting controls.

Prefer:

- narrow standing authorizations with numeric limits;
- idempotent/reversible actions;
- automatic preflight tests;
- clear dry-run modes;
- exact rollback targets;
- bounded concurrency;
- automatic verification of external side effects;
- concise approval packets for genuinely irreversible work.

Do not weaken authentication, approval, audit, provenance, provider backpressure, task deduplication, or secret-handling controls to make APEX look more autonomous.

## Completion standard

A roadmap item is complete only when the intended behavior exists and the relevant layer has been verified.

For production changes, that means live production evidence—not merely code, a commit, a green build, or a Ready-but-unverified revision.
