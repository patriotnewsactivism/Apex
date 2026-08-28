# Example APEX Tasks

## "Fix APEX"

Expected behavior:

1. Read current `AGENTS.md`.
2. Check live `/health` and build commit.
3. Inspect agent/queue/provider state.
4. Prove the causal layer.
5. Implement a safe fix on a branch if code is at fault.
6. Run verification.
7. Ask only for the production action if that action is gated.
8. After approval, deploy and prove the intended commit/behavior is live.

## "Make APEX fully autonomous"

Expected behavior:

- Audit missing tools/integrations.
- Audit where human approval is actually needed vs where the system asks unnecessarily.
- Add reversible automation, retries, idempotency, observability, and standing policy envelopes.
- Improve approval batching/decision packets.
- Preserve gates for irreversible/external actions.
- Measure autonomy by successful outcomes without daily intervention, not by number of ungated tools.

## "APEX says all LLM providers failed"

Expected behavior:

- Inspect `/api/tokens` and current OpenRouter provider roster.
- Separate missing credentials, spend/token limits, cooldowns, 401/402/429 responses, model availability, tool compatibility, and workspace caps.
- Inspect representative failed tasks.
- Do not assume a provider outage from the aggregate error string.
- Verify a real task succeeds after the remedy.

## "Deploy the fix"

Expected behavior:

- Verify the exact target commit and passed CI/tests.
- Present/consume the production approval.
- Resolve the configured **existing** Google Cloud project, region, and Cloud Run service from trusted configuration; never guess or create a substitute service.
- Build the exact clean commit with Google Cloud Build using `cloudbuild.apex.yaml` and an immutable SHA tag.
- Update only the existing Cloud Run service image.
- Wait for the new revision to become Ready.
- Verify public `/health.build.sha` equals the target commit and the task queue is healthy.
- Smoke-test the changed feature.
- Report actual live proof.

## "Run the company for me today"

Expected behavior:

- Confirm system health first.
- Check unresolved customer/revenue-impacting incidents.
- Check qualified sales/follow-up queue.
- Check billing failures/churn risk using read-only access.
- Check OpenRouter/token capacity and approvals that block work.
- Execute drafts, research, classification, internal preparation, and reversible fixes.
- Bundle external sends/spend/deployments into precise approval packets.
