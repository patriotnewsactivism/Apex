# APEX System Audit

_Compiled 2026-09-05 by direct repository inspection (local clones, git history, baseline builds/tests) across all three repositories. Every claim below is either read directly from source/docs/git history or explicitly marked as unverified. Nothing here is inferred from repository names or assumed from the original three-way "control plane / stream / agent" framing — that framing turned out not to match reality (see §21)._

**Scope:** `patriotnewsactivism/apex` (`Apex`), `patriotnewsactivism/apex-agent` (`Apex-Agent`), `patriotnewsactivism/apex-stream` (`Apex-Stream`). See `docs/APEX_ARCHITECTURE.md` for the resulting design and `docs/APEX_CAPABILITY_MATRIX.md` for the capability-by-capability breakdown.

---

## 1–3. What each repository currently does

### Apex — the live system

A pnpm/TypeScript monorepo (Node 22, 18 packages) implementing a persistent, hierarchical, 13-agent autonomous workforce ("APEX CEO → CTO/COO → specialists, plus an independent QA role") for one operator's technology/media portfolio (BuildMyBot.app, CaseBuddy.live, and others). Production runs on **Google Cloud Run** at `https://apex.donmatthews.live`.

This is not a lightly-maintained side project: **612 commits**, dozens of active feature/fix branches, a daily-or-more commit cadence through the day this audit was written, 13 ADRs recording durable architecture decisions, an `AGENTS.md` truth-hierarchy contract, and 17 deterministic `verify-*.ts` guards wired into CI (provider routing/backpressure, budget pauses, approval-state integrity, task-timeout quarantine, durable-worker-runtime, deploy provenance, non-completion detection, and more). A very large fraction of what a from-scratch "build durable autonomous orchestration" project would need to invent **already exists here, tested, and documented** — see §21 for what that changes about this audit's own recommendations.

Apex owns: the goal/task/approval data model, the 13-agent workforce, the tool registry (~60 tools) with per-tool approval gating, the durable Postgres-backed task queue and scheduler, the CI/CD automation that deploys Apex itself, health/learning/predictive subsystems, and a growing set of cross-portfolio management tools (`multiapp`) that talk to sibling products (BuildMyBot, CaseBuddy, TubeScribe) as external systems, not as code in this repo.

### Apex-Agent — a superseded predecessor, not a live system

**Verdict: abandoned in place, not actively maintained, and should not be treated as a source of current capability.** Evidence, not inference:

- 15 commits total, spanning 2026-06-20 → 2026-07-12 (22 days), zero commits since — **~8 weeks of silence** as of this audit.
- Its **last commit's own message** documents that the deployed Railway instance had been crash-looping continuously since 2026-07-12 06:59 and had **never once completed initialization**. No later commit confirms the fix worked in production. The project went dark immediately after admitting it was down.
- Deploys to **Railway**, which Apex's own ADR-001 explicitly lists as a retired APEX hosting path.
- Zero tests, zero CI (`.github/workflows` does not exist in this repo).
- Internally inconsistent, half-migrated documentation: `.replit` still declares a Replit `autoscale` target that was abandoned 21 days before the repo went dark; `GEMINI.md` is an untouched day-one snapshot describing an org chart and env-var scheme (`OPENAI_API_KEY`, `APEX_LLM_PROVIDER`) that don't exist in the actual code (which is OpenRouter-only); `replit.md` was half-updated on the last day (org chart yes, env vars no).
- `packages/frontend` is dead code (no `package.json`, not in the pnpm workspace, duplicates a component that already existed in `packages/dashboard`).
- `packages/dashboard` was never touched after the very first commit — it never picked up the final two weeks of feature work.
- A `goal.json` at the repo root is an accidentally-committed API test payload with zero references anywhere in the code.
- Commit-author trail (`patriotnewsactivism@gmail.com`, matching this session's user) confirms this is the same operator's own project, not a fork or a different team's work.

**What Apex-Agent got right, for the record:** its core design (hierarchical agents, goal→task tree, human-approval gate with a 5-minute timeout, importance/expiry-aware memory, structured logs, inter-agent messaging, per-tool Zod-validated approval gating) is a reasonably complete, purpose-built schema — not a toy. Apex's own `packages/core`/`packages/agents` clearly reflect a mature evolution of the same ideas (same concepts: `BaseAgent`, `ToolRegistry`, `TaskQueue`, per-tool `requiresApproval`), strongly suggesting common authorship and iteration rather than coincidence, even though no direct code linkage exists between the two repos (a full-repo grep for "apex-agent" inside Apex found zero real references — the only hits were an unrelated `User-Agent: APEX-Agent/1.0` HTTP header string).

**What would change this verdict:** nothing found in either repo suggests Apex-Agent should be revived. If the operator has a specific reason to keep developing it independently (e.g., a genuinely separate deployment target), that would need to be stated explicitly — absent that, see the disposition recommendation in §17.

### Apex-Stream — a live, separate, mid-migration product

A multi-agent monitoring/anomaly-detection/evidence-custody platform (Aria = feed ingestion, Atlas = web-page diffing, Sentinel = live-stream capture, Archivist = evidence vault, Warden = YouTube comment triage) built around a Fastify orchestrator, a declarative workflow engine, and a hash-chained tamper-evident audit log. **67 commits**, most recent 2026-08-29 (about a week before this audit) — actively maintained, just at a slower cadence than Apex, and currently **mid-migration from AWS (CDK/ECS/Fargate) to Google Cloud Run.**

This is a real, independent product with a distinct purpose (compliance-grade evidence capture and social/live-stream anomaly detection) — not a component that logically folds into Apex's "autonomous business workforce" framing. It deserves to stay a separate service. See §21 for exactly what does and doesn't currently connect it to Apex.

**Migration status, subsystem by subsystem** (see `docs/APEX_CAPABILITY_MATRIX.md` for the full table):

| Subsystem | Status |
|---|---|
| Database | **Migrated and proven.** `packages/agent-runtime/src/sql-pg.ts` is a real, working Postgres executor; the README states this is what's actually running on Cloud Run today. |
| Dispatch/eventing | **Still 100% AWS.** Real, unconditional SQS (`bus.ts`'s `TaskQueue`) and EventBridge (`bus.ts`'s `EventBus`) calls, instantiated in the shared `Agent` base class constructor. No Cloud-Run-native substitute exists anywhere in the tree. |
| Auth | **Still 100% AWS Cognito**, including the *only* operator-provisioning path (`.github/workflows/create-operator.yml`, which calls `aws cognito-idp admin-create-user`). No alternate identity provider exists. |
| Evidence storage | **Still 100% AWS S3** (Object Lock compliance mode + KMS server-side encryption), used by both Archivist's evidence vault and Sentinel's stream-segment capture. No non-AWS storage path exists. |
| Agent memory | **Still 100% AWS DynamoDB** — a subsystem the repository's own README doesn't even mention in its "still AWS" disclosure. |
| Deploy path | **Only the orchestrator is deployable at all.** CI builds and pushes one Docker image (the orchestrator's); the five agents have Dockerfiles that nothing in the repo's CI ever builds, and a Lambda entrypoint (`lambda.ts`) on four of five agents that is fully vestigial — wired to nothing since the AWS CDK tree was deleted. |

The single most important fact for planning: **the "fake AWS resource identifiers" failure mode the README warns about already happened once.** Commit `620bdf8` shipped a Cloud Run deploy with literal placeholder values (`COGNITO_USER_POOL_ID=us-east-1_000000000`, SQS URLs under fake AWS account `000000000000`, `--allow-unauthenticated`, `DATABASE_CA_REQUIRED=false`) to satisfy `config.ts`'s Zod schema, which still requires all nine AWS resource identifiers with no `.optional()`/`.default()`. It was reverted the same day (`267dc2f`) along with a hardcoded Cloud Run service-name collision with Apex itself (both were, at one point, deploying to a service literally named `apex`). The revert commit message states outright that "a proper fix would make these optional in config.ts for non-AWS deployments" — **that fix has still not been made.** CI currently protects against a repeat only by refusing to deploy at all (`APEX_STREAM_DEPLOY_ENABLED` gate, no verified dedicated service), not by removing the underlying requirement.

Documentation is badly out of date: **10 of the 12 files under `docs/` described the retired AWS CDK/ECS/Cognito/CloudFront architecture** at audit time, including two files (`DEPLOY.md`, `deployment.md`) that walk through provisioning a CDK stack tree (`infra/`) that no longer exists in the repository. Two pairs (`ARCHITECTURE.md`/`architecture.md`, `SECURITY.md`/`security.md`) were byte-for-byte duplicates. This audit fixed the duplication and added historical-context banners to the stale docs (see §22 and `docs/APEX_IMPLEMENTATION_PROGRESS.md`) rather than rewriting their technical content, since the actual target non-AWS architecture for dispatch/auth/evidence storage has not been decided yet — see §19.

---

## 4. Application entrypoints

| Repo | Entrypoint | What it starts |
|---|---|---|
| Apex | `packages/api-server/src/index.ts` (`pnpm --filter @workspace/api-server run start`) | HTTP control plane: builds the 13-agent workforce, mounts ~20 route groups + WebSocket, runs the DB migration bootstrap, starts the job scheduler and campaign runner. |
| Apex | `packages/api-server/src/worker.ts` (`run start:worker`) | Headless variant of the same workforce+scheduler with no HTTP listener — the browser-independent Cloud Run execution primitive required by ADR-011. |
| Apex | `packages/dashboard` (Vite/React) | Operator dashboard; built to static files and served by api-server, or run standalone via `dev`. |
| Apex | `packages/cli` (`bin/apex-install.js`, `bin/apex-run.js`) | Zero-dependency installer/cron-runner meant to be copied into *other* repositories — deliberately has no imports from this monorepo. |
| Apex | `packages/cicd-worker/src/index.ts` | Standalone poll loop against the **experimental, non-production** Convex job queue. Not part of the live deploy path. |
| Apex-Agent | `packages/api-server/src/index.ts` (Express) | Same shape as Apex's api-server, one generation earlier, SQLite-backed. Not currently running anywhere (see §2). |
| Apex-Stream | `services/orchestrator/src/index.ts` | Fastify API: auth, task dispatch, Beast-mode control, comment triage, workflow execution, audit verification. The only Apex-Stream process with a live deploy path today. |
| Apex-Stream | `services/agent-{aria,atlas,sentinel,archivist,warden}/src/index.ts` | Each a standalone SQS-polling agent process extending a shared `Agent` base class (`packages/agent-runtime`). Buildable, Dockerized, **not deployed by any current CI workflow**. |
| Apex-Stream | `apps/dashboard` (Vite/React) | Operator UI, deployed to Vercel per `vercel.json` — a legitimate split from the Cloud-Run-hosted API, not a conflicting deployment signal. |

## 5. Existing APIs

Both Apex and Apex-Stream expose a REST+WebSocket control plane behind their own orchestrator process; see the full route tables in `docs/APEX_ARCHITECTURE.md` §"Request flow". Apex's ~20 route groups are bearer-token-authenticated (`APEX_ADMIN_TOKEN`, constant-time compared, no source fallback); Apex-Stream's routes are Cognito-JWT-authenticated with a five-role RBAC model (deny-wins semantics). The two APIs share no code and do not currently call each other (see §21).

## 6. Existing agents

- **Apex**: 13 production agents (CEO, CTO, COO, Lead Developer, Frontend/Backend/DevOps/QA specialists, Lead Research, Sales, Marketing, Customer Success, plus an independent QA Director) defined in `packages/agents/src/*.ts` as `BaseAgent` subclasses. A parallel, largely 1:1-ported Convex reimplementation exists in `packages/convex-backend` but is explicitly non-production (ADR-008).
- **Apex-Agent**: 12 agents of the same shape, one generation earlier — superseded, see §2.
- **Apex-Stream**: 5 monitoring/ingestion agents (Aria, Atlas, Sentinel, Archivist, Warden), each a subclass of a shared `Agent` base class in `packages/agent-runtime`, plus a "Beast mode" fleet-wide activation controller (`services/orchestrator/src/beast.ts` — a product feature name for "activate every agent on every source at maximum concurrency right now," not an infra term, with four hard-coded safety rails: cost ceiling, wall-clock expiry, concurrency ceiling, and a database-enforced single-active-run constraint).

## 7. Existing tools

Apex's `packages/core/src/tool-registry.ts` defines ~60 tools spanning file I/O, web search/fetch, CI/CD (test/lint/build/deploy/rollback), peer review, sandboxed shell execution, and the BuildMyBot portfolio connector, each with an explicit `requiresApproval` flag enforced centrally in `ToolRegistry.execute()`. Apex-Stream has no equivalent generic tool-registry concept; its "tools" are the fixed set of orchestrator routes plus the five agents' own `handle()` implementations.

## 8. Existing integrations

- **Apex → external products (real, code-level):** BuildMyBot.app (via its own Supabase instance — read/write status, briefings, error triage, lead data; explicitly no GitHub write access or deploy authority over BuildMyBot), plus declared-but-narrower connectors for CaseBuddy and TubeScribe, Base44 (an AI app-builder "superagent" that can be delegated bounded tasks), Vapi (voice), Stripe, and several lead-sourcing APIs (Yelp, Google Places, Tavily, Brave Search, Firecrawl).
- **Apex-Stream → external platforms:** YouTube Data API (OAuth, KMS-envelope-encrypted refresh tokens), and — pending the AWS migration — AWS SQS/EventBridge/S3/DynamoDB/Cognito/ECS as described in §3.
- **Apex ↔ Apex-Stream:** effectively none at runtime today. The one artifact of cross-repo work is `packages/community-watch` in Apex, a narrow port of Apex-Stream's Warden `classify.ts`/`draft.ts` logic re-pointed at Apex's own OpenRouter LLM chain instead of AWS Bedrock — advisory-only, drafts require human posting, and it does not call Apex-Stream at runtime or share its database. See §21 and `docs/APEX_ARCHITECTURE.md` for the recommended integration contract.

## 9. Existing worker/background systems

- **Apex**: a genuinely durable, from-scratch scheduler (`packages/background-jobs`) — no Redis/BullMQ — that atomically claims due rows from a Postgres `scheduled_jobs` table, runs them under a timeout race with an `AbortController`, and recovers stale claims every 5 minutes. A separate `CampaignRunner` does the same for lead-generation campaigns. Agent-loop crash supervision (`packages/core/src/agent-supervisor.ts`) restarts crashed loops with bounded jittered backoff and surfaces "abandoned" agents at `/health`.
- **Apex-Stream**: each of the 5 agents runs its own SQS long-poll loop via the shared `Agent` base class, with lease renewal, concurrency ceilings, and a 25-second graceful-drain window on SIGTERM. A 60-second in-process timer in the orchestrator sweeps overdue Beast runs (also reachable via `/internal/expire-runs`, guarded by a static, non-secret header check the code's own comment states is deliberately *not* an authentication mechanism — see `docs/APEX_SECURITY.md`).

## 10. Existing schedulers

Apex's `JobScheduler`/`CronParser` (hand-rolled, Postgres-polling, 60-second tick) is the only general-purpose recurring scheduler in the ecosystem. Apex-Stream has no general scheduler; its "recurring" work is either agent poll loops (interval per source, stored in the `sources` table) or the Beast-run expiry sweep.

## 11. Existing databases and persistence

Both Apex and Apex-Stream persist to **Postgres via a hand-rolled idempotent bootstrap migration** run at process start (not `drizzle-kit`/a migration-framework CLI in Apex's case; a forward-only checksummed SQL-file runner with an advisory lock in Apex-Stream's case). Apex additionally runs an **experimental, explicitly non-production** parallel Convex backend (ADR-008) that has already drifted behind the live Postgres schema (missing three tables that exist in Postgres). Apex-Agent used local SQLite via libSQL — abandoned along with the rest of the repo.

## 12. Existing messaging/event infrastructure

Apex has no message bus — delegation between agents happens by writing rows to Postgres and polling. Apex-Stream's entire dispatch/eventing layer is AWS SQS (per-agent queues) + EventBridge (a single fan-out bus, described in-code as "a star rather than a mesh — agents never call each other directly"), both still live per §3.

## 13. Existing authentication/authorization

Apex: single long-lived bearer secret (`APEX_ADMIN_TOKEN`), constant-time compared, no hardcoded fallback, plus a separate single-use 30-second-TTL WebSocket ticket so the long-lived token never appears in a URL. Apex-Stream: AWS Cognito JWT verification against the pool's JWKS, five-role RBAC (`owner/admin/operator/analyst/viewer`) with deny-wins semantics and per-agent IAM-style capability scoping. Neither system currently trusts the other; there is no SSO or shared-identity boundary between them (a real gap if/when they need to call each other's APIs — see `docs/APEX_ARCHITECTURE.md`).

## 14. Existing observability

Apex: structured logging conventions, a `HealthMonitor` running 8 read-only checks every 60 seconds (DB, LLM providers, memory, tool registry, task backlog, WebSocket, an external product's shift status, ARIA dispatch volume — note this "ARIA" is Apex's own name for a dispatch-volume metric, unrelated to Apex-Stream's Aria agent), a `/health` endpoint reporting build SHA + task-queue verdict + workforce liveness, and a token-spend ledger at `/api/tokens`. Apex-Stream: structured JSON logging with deny-by-default field redaction, a hash-chained append-only audit log with a `/api/audit/verify` endpoint that recomputes the whole chain on demand, and per-agent heartbeats surfaced at `/api/agents`.

## 15. Existing tests

- **Apex**: zero conventional unit tests (`*.test.ts`/`*.spec.ts`/`__tests__` — none exist). Correctness is verified by `tsc --noEmit` per package plus a custom harness of ~25 `scripts/verify-*.ts` regression checks, 17 of which run in CI, covering exactly the reliability-critical state machines (approval integrity, task-timeout quarantine, provider backpressure, deploy provenance, non-completion detection, websocket lifecycle). This is real, substantial coverage of the hardest parts — it is simply not organized as a conventional test suite, and it has **zero coverage** of route handlers, the dashboard, `learning-system`, `predictive`, `multiapp`, or `youtube`/`community-watch`.
- **Apex-Agent**: zero tests, zero CI, one abandoned manual smoke-test script.
- **Apex-Stream**: a genuine, if small, `node:test` unit-test suite (44 tests across `packages/core` and `packages/workflow-engine`) that runs with **zero live credentials** (AWS KMS is faked with a hand-rolled XOR provider specifically so tests don't need AWS). All 44 pass in this audit's baseline run. No tests exist for any of the five agents, the orchestrator's HTTP layer, or the AWS integration points themselves.

## 16. Existing deployment mechanisms

Apex: Google Cloud Build (`cloudbuild.apex.yaml`) → immutable SHA-tagged image → `gcloud run services update` on an existing, never-created, never-substituted Cloud Run service, gated by an explicit `APEX_DEPLOY_ENABLED` variable and verified post-deploy against `/health.build.sha`. This is implemented twice — once for real (`packages/cicd-automation`, wired into the live tool registry) and once as an unused, non-production Convex-worker path (`packages/cicd-worker`) that always throws rather than attempting a deploy. Apex-Agent: Railway, retired, last known to be crash-looping. Apex-Stream: the orchestrator only, via a guarded GitHub Actions workflow with real fail-closed checks (service-name collision guard, existing-service verification, SHA-pinned image, post-deploy `/health.version` verification) — the five agents have no deploy path at all right now.

## 17. Duplicate functionality

See `docs/APEX_CAPABILITY_MATRIX.md` for the full list with recommended owners. The significant ones:

1. **Agent/task/goal orchestration exists three times** across the three repos (Apex's `packages/core`+`packages/agents`; Apex-Agent's near-identical earlier version; Apex-Stream's differently-shaped `Agent`/`Dispatcher` model for a genuinely different problem — monitoring agents, not a business workforce). Only the first and third are live.
2. **CI/CD automation exists twice inside Apex alone**: the real, production-wired `packages/cicd-automation` vs. the unused Convex-queue-based `packages/cicd-worker` (whose deploy/rollback handlers always throw and point back at the real path).
3. **"Orchestration" exists under three different names inside Apex**: `packages/orchestrator` (a confirmed dead stub — its own comment says "safe to delete entirely"), `packages/multiapp`'s `OrchestrationEngine` (thin, 27 lines, the one that's actually used for cross-portfolio delegation), and `packages/core/src/orchestration-tools.ts` (433 lines, the one doing the heavy lifting for agent-to-agent delegation).
4. **`packages/frontend` is dead code in both Apex and Apex-Agent** — the identical failure pattern (an orphaned, unbuilt, superseded dashboard prototype fragment) in both repos.
5. **The Cognito-vs-non-AWS auth question, the SQS/EventBridge-vs-Postgres dispatch question, and the S3-vs-non-AWS evidence-storage question all still have exactly one implementation each (AWS)** in Apex-Stream, despite the repo's own docs framing them as "being migrated" — see §3.
6. **`rds-ca.ts`'s TLS CA-bundle loader was duplicated** between Apex-Stream's orchestrator (dead, unimported) and `agent-warden` (the only place it was actually wired in) — consolidated into `packages/agent-runtime` during this audit; see `docs/APEX_IMPLEMENTATION_PROGRESS.md`.
7. **Two byte-for-byte duplicate doc pairs** in Apex-Stream (`ARCHITECTURE.md`/`architecture.md`, `SECURITY.md`/`security.md`) — de-duplicated during this audit.

## 18. Broken functionality

1. **Apex-Agent**: the entire deployed instance, per its own final commit — see §2. Not being fixed; recommended for formal deprecation (§17 disposition, `docs/APEX_IMPLEMENTATION_PROGRESS.md`).
2. **Apex**: the live, agent-callable `deploy_to_environment`/`rollback_deployment` tool definitions in `packages/core/src/tool-registry.ts` described AWS Lightsail/CodeBuild and defaulted their `platform` argument to `'lightsail'`, even though the actual implementation they call (`packages/cicd-automation/src/deployment-manager.ts`) was already correctly rewritten against Cloud Run — the deploy itself likely still worked (the manager ignores everything but a `'local'` sentinel), but every deployment was being recorded with a false `platform: 'lightsail'` audit value, and an agent narrating "what did that tool just do" would describe infrastructure Apex hasn't run on since ADR-001. **Fixed during this audit** — see `docs/APEX_IMPLEMENTATION_PROGRESS.md`.
3. **Apex**: `packages/cicd-worker/src/handlers/deploy.ts` carried the same stale AWS-Lightsail runbook text in a comment/exported constant, in a file the retired-hosting-instructions CI guard doesn't scan (it only scans `.md` files) — **fixed during this audit**, and flagged as a blind spot in the guard itself (see §22 recommendations).
4. **Apex-Stream**: `services/orchestrator/src/effects.ts`'s `notify()` only ever writes a `status='queued'` row — nothing anywhere transitions a notification to `'sent'` on either the AWS or the (nonexistent) non-AWS path. Alerting is a complete no-op regardless of platform. Not fixed (needs a real provider decision — email/SMS/Slack — this audit did not fabricate one).
5. **Apex-Stream**: `packages/agent-runtime/src/sql-pg.ts` never supplied a CA bundle for its Postgres TLS connections, which its own sibling copy of the loader function (in `agent-warden/src/store.ts`) documented as "guarantees 'self-signed certificate in certificate chain' on every connection, always." **Fixed during this audit** by consolidating the loader into `packages/agent-runtime` and wiring it into `PgExecutor`.
6. **Apex**: two route handlers have latent filter-ignoring bugs inherited from the same scaffold as Apex-Agent (`GET /api/tasks` and `GET /api/logs` accept filter query params but never apply them to the query) — found in Apex-Agent's audit and not independently re-verified against Apex's current source in this pass; flagged for follow-up in `docs/APEX_CAPABILITY_MATRIX.md`.

## 19. Missing functionality

The largest, most consequential gap in the whole ecosystem: **Apex-Stream has no non-AWS path for dispatch, auth, or evidence storage**, and choosing the Google-Cloud-native replacements (Pub/Sub or Cloud Tasks? Firebase Auth/Identity Platform or a self-hosted equivalent? GCS with Bucket Lock instead of S3 Object Lock? Firestore/Spanner instead of DynamoDB for agent memory?) is a genuine architecture decision this audit is **not** making unilaterally — it affects a compliance-relevant evidence-custody chain and touches every one of the five agents plus the orchestrator's auth boundary. See `docs/APEX_ARCHITECTURE.md` §"Open decisions" for the options and what's needed to decide.

Other gaps, roughly in priority order: no deploy path at all for Apex-Stream's five agents; no working notification delivery in Apex-Stream; no unit tests for Apex's route handlers, dashboard, or newer packages (`learning-system`, `predictive`, `multiapp`, `youtube`, `community-watch`); no runtime integration contract between Apex and Apex-Stream beyond the one-time `community-watch` port (§21); no CI guard that would have caught the stale-Lightsail-instructions bug in `.ts` source rather than only `.md` docs.

## 20. TODOs and partially implemented features

Both Apex and Apex-Stream enforce "no TODO comments — finish it or file a follow-up" as policy, and it shows: there are essentially zero literal `TODO`/`FIXME` comments in either. The partial-implementation signal instead shows up as stale narrative comments and stub packages — see §17/§18 above and the full file-level list in each repo's Explore-agent findings folded into `docs/APEX_CAPABILITY_MATRIX.md`. Apex's `packages/buildmybot-ops` (declared, zero implementation) and `packages/orchestrator` (an explicit `export {}` stub) are the clearest examples.

## 21. Architectural risk — the original three-way framing doesn't match reality

The task that produced this audit assumed Apex would be a control plane, Apex-Stream would own event ingestion/streams, and Apex-Agent would own agent reasoning/planning, with the three needing to be "connected." **What's actually true:** Apex already owns agent reasoning/planning/execution end-to-end for its own domain (business/sales/content automation) and does not need Apex-Agent's code — Apex-Agent is a dead predecessor (§2). Apex-Stream is a complete, independently-useful product for a genuinely different problem (compliance-grade monitoring/evidence capture) that happens to share an author and a *style* of agent design with Apex, not a subsystem Apex is missing. Forcing a deep runtime merger between Apex and Apex-Stream would not reflect either codebase's actual shape and was not attempted. The one real integration opportunity — letting Apex's goal/task system consume Apex-Stream's anomaly/evidence findings as inputs to a goal (e.g., "investigate this flagged anomaly," "draft a response to this classified comment") — is designed as a clean, optional, HTTP-based contract in `docs/APEX_ARCHITECTURE.md` rather than a code merge, precisely because the two systems have different auth models, different compliance requirements (Apex-Stream's evidence chain must remain independently verifiable), and different deploy cadences.

## 22. Security risks

Ranked by what this audit found, not by generic checklist:

1. **Apex-Stream's evidence-storage/auth/dispatch AWS dependency is itself the top risk** — not because AWS is unsafe, but because the repo's docs (SECURITY.md, ARCHITECTURE.md) describe a security *design* (KMS envelope encryption, Object Lock compliance mode, Cognito MFA, deny-wins RBAC) that is sound, while the migration-in-progress state means a wrong move (e.g., re-adding placeholder identifiers to make a Cloud Run deploy "just work," as already happened once) could silently produce an unencrypted-by-default or wrong-permission deployment. Mitigated today only by CI refusing to deploy at all.
2. **Two known CVEs in Apex-Stream's dependency tree** (`fastify` 5.11.3, schema-validation-bypass + X-Forwarded-* trustProxy spoofing; `fast-uri`, SSRF/host-confusion via IDN/IPv6/percent-encoding) — **fixed during this audit** via `npm audit fix` (patch-level bumps only, all tests still pass).
3. **`services/orchestrator/src/server.ts`'s `trustProxy: true`** is set unconditionally with a comment claiming "behind an ALB" — stale for Cloud Run, where exactly one trusted proxy hop (Google Front End) sits in front of the service. `request.ip` under `trustProxy: true` trusts the *entire* client-supplied `X-Forwarded-For` chain, which is used both for a rate-limit key and for the `ipAddress` field on audited authorization decisions and evidence-access denials — on an evidence-custody platform, an unreliable audit-trail IP is a real (if narrow) integrity concern. **Not changed in this audit**: the correct fix (`trustProxy: 1`, trusting exactly the nearest hop) depends on confirming Cloud Run's actual network topology for this service, which requires live GCP access this audit did not have. Documented here as a concrete next action rather than guessed at.
4. **The `/internal/expire-runs` route's `x-apex-internal: schedule` header check is a hardcoded, non-secret literal string**, not an environment-configured secret. The code's own comment explicitly (and reasonably) frames this as a guard against *accidental* misrouting, not an authentication boundary, and the route's blast radius is narrow (it only expires already-overdue runs, returning a count and run IDs — no data exposure, no destructive action, and nothing an attacker gains beyond forcing early expiry of a run that was going to expire anyway). That risk-acceptance reasoning was written for AWS EventBridge's account-boundary guarantee; it has not been re-validated for Cloud Run's network model. Low severity given the bounded impact, but worth a five-minute check of the service's ingress settings.
5. **Apex's approval-surface changes are undocumented as a batch**: six tools in `tool-registry.ts` had `requiresApproval` flipped from `true` to `false` on 2026-07-22 ("Auto-approved"). Individually plausible, never reviewed together. Worth a five-minute pass to confirm the set is still correct.
6. No secrets were found exposed in either repo's `.env.example` files or committed source during this audit (checked deliberately, values only, never reproduced here).

## 23. Reliability risks

Apex's own `CHECKLIST.md` already tracks the sharpest open reliability items honestly (multi-instance scheduler claim safety under real load, graceful-shutdown verification during Cloud Run instance replacement, rollback exercised end-to-end) — this audit did not find reason to second-guess that list and did not duplicate it. The one new item: **Apex-Stream's `notify()` no-op (§18.4)** means any alerting this platform is supposed to provide operators today silently does nothing on every path, a reliability gap distinct from (and unrelated to) the AWS migration.

## 24. Scalability risks

Apex-Stream's memory subsystem (DynamoDB) and evidence subsystem (S3) are both designed to scale independently of compute — no concern there once/if migrated. Apex's Postgres-polling scheduler and task queue are simple and auditable but will need the multi-instance claim-safety work already tracked in `CHECKLIST.md` before running more than one Cloud Run instance with real concurrent scheduled load. Neither system showed evidence of unbounded queues, unbounded caches, or N+1 query patterns during this audit's necessarily-time-boxed source review; a dedicated profiling pass was out of scope and is not claimed to have happened.

## 25. Opportunities for consolidation

See `docs/APEX_CAPABILITY_MATRIX.md`'s "recommended owner after integration" column for the full list. Highest-value: (a) formally deprecate Apex-Agent rather than leave it ambiguously abandoned; (b) delete or clearly gate off the unused Convex-based CI/CD path in Apex once a decision is made about whether the broader Convex migration continues at all; (c) delete the confirmed-dead `packages/orchestrator` stub in Apex; (d) decide and execute the Apex-Stream AWS-to-GCP-native migration for dispatch/auth/evidence storage as one deliberate project rather than piecemeal, given how tightly those three are coupled to each other and to the evidence-integrity guarantees the product depends on.

---

_Continue to `docs/APEX_CAPABILITY_MATRIX.md` for the capability-by-capability breakdown, `docs/APEX_ARCHITECTURE.md` for the resulting design, and `docs/APEX_IMPLEMENTATION_PROGRESS.md` for exactly what this audit changed._
