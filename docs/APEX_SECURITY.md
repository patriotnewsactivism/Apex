# APEX Security (cross-repo)

_Apex's own `SECURITY.md` and Apex-Stream's own `docs/SECURITY.md` remain the authoritative security policy for each system — this document does not replace either. It consolidates the cross-repo findings from `docs/APEX_SYSTEM_AUDIT.md` §22 and records what this audit fixed vs. flagged for follow-up. Apex-Agent is out of scope (deprecated, not handling live traffic or data — see `docs/APEX_ARCHITECTURE.md`)._

## Permission model summary

Apex: single admin bearer token (`APEX_ADMIN_TOKEN`), constant-time compared, fails closed with no source-code fallback (ADR-006), plus per-tool `requiresApproval` gating for consequential actions (deploy, shell execution, external sends, financial actions). Apex-Stream: Cognito-JWT-authenticated, five-role RBAC (`owner/admin/operator/analyst/viewer`) with deny-wins semantics — notably, **no role including owner can ever delete evidence**, enforced at both the RBAC layer and, redundantly, at the database trigger layer, which the audit found to be a deliberately defense-in-depth design rather than an oversight.

Neither system's tools map cleanly to a single shared capability vocabulary (`READ_CRM`, `SEND_EMAIL`, etc.) today — each has its own per-tool/per-route gating implemented independently. This audit did not force a unification, since the two systems' actions are largely disjoint (Apex: business/CRM/deploy actions; Apex-Stream: evidence/comment-moderation actions) and a shared vocabulary would be speculative ahead of the integration contract described in `docs/APEX_ARCHITECTURE.md`.

## Fixed during this audit

| Finding | Component | Fix |
|---|---|---|
| `fastify` 5.11.3 (schema-validation-bypass, X-Forwarded-* trustProxy spoofing) and `fast-uri` (SSRF/host-confusion) known CVEs | Apex-Stream `services/orchestrator` | `npm audit fix` — patch-level bumps only (`fastify` → 5.12.3, `fast-uri` → 4.1.4/3.1.7); build/typecheck/test re-verified green after |
| `deploy_to_environment`/`rollback_deployment` tool descriptions and default `platform` value referenced retired AWS Lightsail, contradicting ADR-001 and misrepresenting what the tool actually does to any agent reading its own tool description | Apex `packages/core/src/tool-registry.ts` | Corrected description, schema enum, and default to match the actual Cloud Run implementation (`packages/cicd-automation/src/deployment-manager.ts`, which was already correct) |
| Same stale AWS-Lightsail runbook duplicated in a dead code path, invisible to the retired-hosting-instructions CI guard (which only scans `.md` files) | Apex `packages/cicd-worker/src/handlers/deploy.ts` | Corrected to describe Cloud Run; renamed constant with a back-compat alias |
| `sql-pg.ts`'s Postgres connections never loaded a CA bundle, guaranteeing TLS verification failure against AWS RDS/Aurora per the sibling implementation's own comment | Apex-Stream `packages/agent-runtime/src/sql-pg.ts` | Consolidated the previously-duplicated `loadRdsCaBundle()` (one dead copy, one live copy) into `packages/agent-runtime`, wired into `PgExecutor` |
| Three stale draft PRs on Apex-Stream (#5, #6, #7) — one of which would have resurrected deleted AWS CDK infrastructure the operator had deliberately removed the day after the PR was opened | Apex-Stream (GitHub) | Closed all three with an explanation; the one salvageable idea (a SHA-256 evidence hash-chain ledger) is recorded as a fresh backlog item rather than merged from a stale branch |
| Two byte-for-byte duplicate security/architecture docs | Apex-Stream `docs/` | De-duplicated |

## Flagged, not fixed (needs live access or a policy decision this audit couldn't make safely)

| Finding | Why not fixed here |
|---|---|
| `services/orchestrator/src/server.ts`'s `trustProxy: true` (stale "behind an ALB" comment; Cloud Run has exactly one trusted proxy hop, not an unbounded chain) — affects `request.ip` used in rate-limiting and in the audit trail's `ipAddress` field | The correct fix (`trustProxy: 1`) depends on confirming Cloud Run's actual network topology for this specific service, which requires live GCP access this audit did not have. Flagged with an exact recommended value rather than guessed at blind. |
| `/internal/expire-runs`'s hardcoded, non-secret `x-apex-internal: schedule` header check | The code's own comment explains this was a deliberate, reasoned risk acceptance under AWS EventBridge's account-boundary guarantee, not an oversight — and the route's blast radius is narrow (expires already-overdue runs, no data exposure). It needs re-validation under Cloud Run's network model, not a reflexive fix that might not match whatever ingress configuration is actually live. |
| Six tools in Apex's `tool-registry.ts` had `requiresApproval` flipped `true → false` as a batch on 2026-07-22 | Each change looks individually reasonable in context (git blame shows scoped, reversible, or low-risk actions), but this audit did not have the original review context to confirm the batch was deliberate rather than a shortcut taken under time pressure. Flagged for a five-minute human confirmation pass rather than silently reverted or silently endorsed. |
| Apex's per-agent `approvalRequired` field is defined but not read by the live execution path | This could be intentional simplification (uniform per-tool gating is arguably *more* consistent than a second, role-based override) or an accidental regression from an earlier design. Confirm intent before changing either the code or the field. |
| Apex-Stream's dispatch/auth/evidence-storage AWS dependency | See `docs/APEX_ARCHITECTURE.md` §"Open decisions" — this is an infrastructure/compliance decision, not a bug. |

## Supply chain

Both repos already enforce reasonable supply-chain hygiene independently: Apex's `pnpm-workspace.yaml` sets a 1440-minute minimum package release age (a real defense against just-published malicious npm releases) with an explicit, narrow exclusion list; Apex-Stream's `SECURITY.md` documents ECR image scanning, immutable tags, and `npm ci` against a committed lockfile in CI. This audit did not find a reason to add a second mechanism on top of either.

The one supply-chain-adjacent item this audit flagged but did not execute: the operator-provided VM setup instructions (Kilo Code + Hermes Agent via `curl | bash` from third-party domains) — see `docs/APEX_OPERATIONS.md` §4 for why this was documented rather than run, and what to check before running it.

## Secrets handling

No real credential values were found exposed in either repository's `.env.example`, committed source, or documentation during this audit (checked deliberately; per this document's own rule, none are reproduced here even as an example of what was checked). Both repos already follow "reference secrets by name only" as a written policy (Apex `AGENTS.md`/`SECURITY.md`; Apex-Stream `docs/SECURITY.md`) — this audit's own documentation changes followed the same rule throughout.
