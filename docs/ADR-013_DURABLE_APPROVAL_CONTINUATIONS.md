# ADR-013 — Human approvals are exact, durable, one-shot capabilities

**Status:** Accepted  
**Last confirmed:** 2026-08-30

## Decision

A gated tool approval authorizes exactly one execution of the tool's **normalized validated payload**. It is not a reusable boolean and it is not permission for a similar future action.

The production approval path therefore has four independent invariants:

1. **Normalize before binding.** Before an approval row is created, APEX re-parses the proposed arguments through the registered tool's current Zod schema. `approvals.tool_args` stores that normalized object. The raw model-emitted argument object is not the approval authority.
2. **Compare-and-set resolution.** Human approve/reject remains a pending-only, kind=`approval` transition. Replays and races fail closed.
3. **One-shot consumption.** An `approved` or `rejected` decision is atomically changed to `consumed_approved` / `consumed_rejected` before a recovered execution is allowed to use it. A crash after consumption cannot automatically replay a side effect.
4. **Restart recovery.** A task waiting for approval is durable in Postgres. If the worker that created the wait disappears, another worker may requeue the task only after the original five-minute in-process waiter plus a safety grace has elapsed and only when a human decision already exists.

## Why the grace exists

Several Cloud Run workers may coexist. Immediately requeuing every resolved `awaiting_approval` task would let a second process race the first process, which may still be polling the same approval. The recovery cutoff is deliberately longer than the maximum live approval wait. That makes the old waiter provably expired before another worker can claim the task.

## Recovered approved actions

A recovered approval is not handed back to the model as free-form authority. The claiming agent:

- verifies the approval still belongs to the task and agent;
- verifies the tool is still registered, allowed for the agent, and still approval-gated;
- re-validates `tool_args` through the current schema;
- requires the re-normalized payload to equal the approved payload exactly;
- compare-and-set consumes the decision;
- only then executes the tool once.

If tool policy or normalization changed, the approval becomes `stale` and the action is not executed. Fresh approval is required.

After the recovered action, the normal governed reasoning loop continues from the verified tool result. It is explicitly told not to repeat the gated action without a new approval.

## Recovered rejection

A recovered rejection is also consumed once. The task may continue looking for a safe alternative, but the rejected exact action is not silently retried.

## Timeout behavior

The existing five-minute live wait remains. If no human decision arrives, the timeout is recorded directly as `consumed_rejected`, the live task returns to `in_progress`, and the agent can react to the rejection. A timeout cannot later be mistaken for a reusable human decision.

## Failure behavior

Approval integrity always fails closed:

- changed normalized args => new approval;
- changed tool policy/schema => stale approval, no execution;
- decision-consumption race => no execution by the losing claimant;
- crash after decision consumption => no automatic replay;
- database/recovery failure => no process-local authorization fallback.

No database migration is required. Existing text status columns and JSONB tool arguments already represent these states.

## Verification

`scripts/verify-approval-state-integrity.ts` guards:

- pending-only API resolution;
- normalized-payload storage;
- exact canonical payload equality;
- tool/agent authorization checks;
- recovery only after the live-wait safety window;
- resolved-only recovery;
- compare-and-set decision consumption;
- consume-before-side-effect ordering;
- stale-on-policy/schema-drift behavior;
- non-reusable timeout rejection.

These approval rules do not weaken any existing tool approval requirement, deployment approval, database-management boundary, or side-effect idempotency requirement.
