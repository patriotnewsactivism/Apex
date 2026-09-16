# APEX Decision Protocol

## Evidence hierarchy

Prefer, in order:

1. Direct live response/log/data from the affected system.
2. Source code for the deployed/target commit.
3. Current repository operational instructions (`AGENTS.md`).
4. Current tests/CI/deployment records.
5. Current planning/checklist docs.
6. Historical notes/conversation memory.

## Incident classification

Classify before editing:

- **Security** — exposure, auth bypass, secret leak, unauthorized action.
- **Availability** — service/queue/agent unavailable.
- **Capacity** — provider/token/CPU/memory/concurrency bottleneck.
- **Correctness** — logic/data/results wrong.
- **Deployment** — intended code not live or rollout unhealthy.
- **Integration** — external API/credential/contract failure.
- **Business** — sales/support/billing workflow blocked.
- **Observability** — system cannot prove what happened.

## Root-cause standard

A root cause is not "the last error message." It is the earliest verified condition that explains the failure and predicts the observed behavior.

For each proposed root cause, capture:

- Evidence for it.
- Evidence against alternatives.
- A test that would falsify it.
- The smallest fix that addresses it.

## Prioritization score

When several tasks compete, estimate:

`priority = impact × urgency × confidence / effort`

Use qualitative values if exact numbers are unavailable. Penalize speculative work with low confidence. Security/data-loss P0s override the formula.

## Approval decision packet

Use:

- **Action** — exact action and target.
- **Why now** — direct reason.
- **Evidence** — decisive facts.
- **Change** — what will be modified.
- **Blast radius** — users/services/data affected.
- **Risk** — likely failure modes.
- **Rollback** — exact recovery target/steps.
- **Verification** — success proof.
- **Recommendation** — approve/decline and why.

Do not bundle unrelated irreversible actions into one approval.

## Verification depth

- **Low-risk docs/config:** diff + syntax/format check.
- **Code:** typecheck/build/tests.
- **Runtime fix:** reproduce before/after.
- **Deployment:** build + active deployment + live commit + feature smoke test.
- **Data migration:** preflight counts + transaction/backup + postflight invariants.
- **Business workflow:** persisted record + correct status + externally observed result only if approved/executed.

## Reporting language

Use factual state verbs:

- "verified"
- "observed"
- "failed"
- "not yet verified"
- "blocked on approval"
- "prepared but not executed"

Avoid phrases such as "should be live" when live proof is available or required.
