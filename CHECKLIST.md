# APEX Current Checklist

_Last reset to current source/operations: 2026-08-28._

This is the living implementation/release checklist. Old session-by-session completion claims and corrected historical notes were removed to prevent them from being mistaken for current state.

Canonical production facts:

- [x] APEX production target is **Google Cloud Run**.
- [x] `https://apex.donmatthews.live` is the public production domain.
- [x] AWS Lightsail/CodeBuild deployment code and docs are retired/removed.
- [x] Railway and Replit are not APEX production deployment paths.
- [x] OpenRouter is the production LLM gateway in current source.
- [x] Current source routes MiniMax M3 Free → NVIDIA Nemotron 3 Ultra Free fallback.
- [x] Admin auth has no hardcoded password/token fallback.
- [x] Cloud Run deployment tooling is existing-service-only and SHA-provenance aware.
- [x] Production CI includes typecheck, deterministic guards, and dashboard build.
- [x] Canonical documentation has been reset around Cloud Run/OpenRouter/current security rules.

## Release current `main` to Cloud Run

Do not check these from a commit/build alone.

- [ ] Resolve authenticated access to the existing APEX Google Cloud configuration.
- [ ] Confirm exact `APEX_GCP_PROJECT_ID` from trusted configuration.
- [ ] Confirm exact `APEX_CLOUD_RUN_REGION` from trusted configuration.
- [ ] Confirm exact `APEX_CLOUD_RUN_SERVICE` from trusted configuration.
- [ ] Confirm the intended existing service can be described before any update.
- [ ] Confirm required secret/config names exist in Cloud Run without exposing their values.
- [ ] Confirm `OPENROUTER_API_KEY` is configured for the existing production service.
- [ ] Confirm `APEX_ADMIN_PASSWORD` and `APEX_ADMIN_TOKEN` are configured.
- [ ] Run/confirm green CI for the release state.
- [ ] Build the exact clean release SHA with `cloudbuild.apex.yaml`.
- [ ] Update only the existing Cloud Run service image.
- [ ] Wait for the new revision to become Ready.
- [ ] Verify public `/health.build.sha` equals the released SHA.
- [ ] Verify `taskQueue.verdict` is healthy.
- [ ] Smoke-test admin login.
- [ ] Smoke-test dashboard/API access.
- [ ] Smoke-test one real OpenRouter inference/tool-call path.
- [ ] Smoke-test scheduler/task execution behavior.
- [ ] Record the prior Cloud Run revision as rollback target.

## Reliability hardening

- [x] Scheduled delegation deduplicates duplicate open scheduled tasks.
- [x] Provider-capacity pauses are separated from ordinary task failure handling in current source.
- [x] Provider routing/backpressure have deterministic CI guards.
- [x] Non-completion and malformed-tool-call behavior have deterministic CI guards.
- [x] Deployment provenance has a deterministic Cloud Run guard.
- [ ] Add/verify atomic scheduled-job claiming for multi-instance Cloud Run operation.
- [ ] Load-test recurring scheduling with more than one application instance.
- [ ] Verify graceful shutdown and lease release during Cloud Run instance replacement.
- [ ] Exercise production rollback and verify public health afterward.
- [ ] Verify repeated manager delegation reaches measurable outcomes rather than stopping at delegation.

## OpenRouter operations

- [x] Canonical primary credential name is `OPENROUTER_API_KEY`.
- [x] Optional `OPENROUTER_API_KEY_2` is treated as credential redundancy, not separate account quota.
- [x] Default global LLM concurrency in current source/config is production-oriented rather than demo-throttled.
- [x] Lead research has bounded production concurrency configuration.
- [x] Token pacing/backpressure controls remain enabled in the production example configuration.
- [ ] Verify current OpenRouter account-level spending/usage limits with the operator.
- [ ] Verify actual serving-provider/model diagnostics from the live Cloud Run release.
- [ ] Establish alert thresholds for sustained provider capacity failures and abnormal token spend.

## Security and access

- [x] Secrets are documented by environment-variable name only.
- [x] Production admin login fails closed if auth secrets are absent.
- [x] `SECURITY.md` defines production security/change-control rules.
- [x] Runtime database access is documented as separate from management-plane authorization.
- [ ] Before any production database/Supabase management action, verify the exact APEX target and separate intended credentials.
- [ ] Define/test recovery for any future production schema migration before applying it.
- [ ] Prefer Google Workload Identity for unattended Cloud Run deployment automation instead of long-lived service-account keys.

## Documentation hygiene

- [x] `README.md` reflects Google Cloud Run and OpenRouter.
- [x] `AGENTS.md` is the canonical agent/contributor operating contract.
- [x] `docs/ARCHITECTURE_DECISIONS.md` records durable architecture decisions.
- [x] `docs/PRODUCTION_OPERATIONS.md` contains the Cloud Run release/rollback runbook.
- [x] `docs/deploy-provenance.md` defines source → image → live-SHA proof.
- [x] `CONTRIBUTING.md` defines change-control expectations.
- [x] `APEX_CHARTER.md` retains mission/governance while marking dated technical material historical.
- [x] `BUSINESS_PROFILE.md` is explicitly a dated business snapshot, not current production truth.
- [x] Superseded Qwen, Convex-resumption, lead-engine, integration, AWS, Replit, screenshot, and one-off goal artifacts have been removed.
- [ ] When architecture or operating rules change, update code and canonical docs in the same work item.

## Experimental Convex path

- [x] Convex is explicitly classified as experimental rather than production authority.
- [ ] Do not enable `APEX_CONVEX_AUTONOMY_ENABLED` in production without a deliberate architecture decision, migration plan, rollback plan, and live verification.
- [ ] Remove remaining experimental Convex code later only after confirming no current package/import depends on it; do not delete merely because an old migration plan was retired.

## Business/portfolio operations

- [ ] Re-verify current BuildMyBot pricing/features/payment state against the live BuildMyBot system before customer-facing use.
- [ ] Re-verify the current connector contract in `packages/core/src/buildmybot-connector.ts` against the live BuildMyBot backend.
- [ ] Verify lead research → CRM/outreach handoff end to end before scaling campaigns.
- [ ] Measure business outcomes (contact, qualification, conversion, follow-up), not generated-lead counts alone.

## Rule for checking boxes

Only check an item when the relevant evidence exists. If the item affects production, repository code or CI alone is insufficient; verify the live system.
