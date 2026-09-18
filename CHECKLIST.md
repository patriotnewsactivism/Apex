# APEX Current Checklist

_Last reset to current source/operations: 2026-09-18._

Canonical production facts:

- [x] APEX production host is **Railway** (`apex-backend`) behind `https://apex.donmatthews.live`.
- [x] Google Cloud Run is retired (billing off on `apex-503709`) and kept only as a gated rollback path.
- [x] AWS Lightsail/CodeBuild is retired.
- [x] OpenRouter is the production LLM gateway.
- [x] Admin auth has no hardcoded password/token fallback.
- [x] Hard-gated tools cannot be auto-approved (`scripts/verify-approval-policy.ts`).
- [x] WebSocket application heartbeats keep LIVE chat up behind Railway/Cloudflare.
- [x] Settings can edit per-project `autonomyLevel` + `autoapproveTools`.
- [x] Approvals show a decision packet; similar non-hard-gated rows can batch.
- [x] Control-plane project `apex` is seeded `full_autonomous` with the default engineering allowlist.

## Still operator / host configuration

- [x] Enable Railway GitHub "Wait for CI" (`checkSuites=true` on the `main` trigger). Proven: a red `production-checks` run was skipped (`skippedReason: CI check suite failed`).
- [x] Artifact volume `apex-artifacts` mounted at `/data/artifacts`; `APEX_ARTIFACT_DIR=/data/artifacts`.
- [x] Lead-research keys present on Railway: `BRAVE_SEARCH_API_KEY`, `FIRECRAWL_API_KEY`, `TAVILY_API_KEY`.
- [ ] `GOOGLE_PLACES_API_KEY` and `YELP_API_KEY` are still absent (not in local env either — cannot invent values).
- [ ] OpenRouter inference is a single key (`OPENROUTER_API_KEY`). `OPENROUTER_FREE_API_KEY` / `OPENROUTER_API_KEY_2` / `_4` are not on the service. Management keys 2/3 exist but do not add quota. A third *account* still requires a new inference key.
- [x] `APEX_EXECUTOR_MODE=inprocess`.
- [ ] Verify `/health.build.sha` after every `main` push. Wait-for-CI will skip red commits.

## Reliability

- [x] Scheduled delegation deduplicates.
- [x] Provider-capacity pauses are separated from ordinary task failure.
- [ ] Live-verify checkpoint/resume (`checkpointsCreated` still 0 as of 2026-09-18).
- [ ] Second replica only after Postgres websocket tickets are proven live.
- [ ] Exercise Cloud Run rollback path only if billing is restored.

## Business / portfolio

- [ ] Re-verify BuildMyBot live pricing/features/payment state before customer-facing use.
- [ ] Measure contact, qualification, conversion, follow-up — not generated-lead counts alone.
- [x] Sales pipeline table is `sales_opportunities` (does not collide with APEX ideas `opportunities`).

## Experimental Convex path

- [x] Convex is experimental, not production authority.
- [ ] Do not enable `APEX_CONVEX_AUTONOMY_ENABLED` without a new architecture decision.

## Rule for checking boxes

Only check an item when the relevant evidence exists. If the item affects production, repository code or CI alone is insufficient; verify the live system.
