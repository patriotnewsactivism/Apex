# Contributing to APEX

APEX is a production autonomous system. Contributions should improve capability without weakening provenance, security, approval controls, or operational truthfulness.

## Before changing code

1. Read `README.md` and `AGENTS.md`.
2. Check `docs/ARCHITECTURE_DECISIONS.md` for decisions that constrain the change.
3. If the work affects production behavior, read `docs/PRODUCTION_OPERATIONS.md` and `docs/deploy-provenance.md`.
4. Start from current `main`.
5. Do not assume old planning documents describe current infrastructure.

## Development workflow

Use the repository's pnpm workspace:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck:production
pnpm run build
```

For ordinary engineering work, prefer a focused branch/PR with one coherent purpose. Keep changes small enough to review and verify.

Do not introduce another package-manager lockfile.

## Required validation

At minimum, production code changes should pass:

```bash
pnpm run typecheck:production
pnpm --filter @workspace/dashboard run build
```

Run deterministic guards relevant to the change. CI currently covers provider routing/backpressure, token-budget pauses, deployment provenance, malformed tool calls, non-completion, and branch/review behavior.

A test or build failure is a defect to diagnose, not a reason to delete the guard.

## High-risk changes

Changes involving any of the following require explicit review/approval and a rollback plan:

- production deploy/rollback;
- auth or authorization;
- secret handling;
- schema/destructive database operations;
- provider/model routing policy;
- agent tool permissions;
- approval bypasses;
- financial actions;
- externally sent communications;
- production infrastructure configuration.

## Documentation is part of the change

Update documentation in the same work item when a change affects:

- production hosting or release procedure;
- LLM provider/model policy;
- environment variable names;
- auth/security boundaries;
- database architecture or management permissions;
- workforce composition;
- CI or deterministic guards;
- durable architecture decisions.

Use `docs/ARCHITECTURE_DECISIONS.md` for decisions that future contributors should not silently reverse.

Do not leave a stale “current” statement in `README.md`, `AGENTS.md`, `ROADMAP.md`, `CHECKLIST.md`, or operational docs after migrating the code.

## Production release expectations

Merging code is not the same as deploying it.

For production work, record separately:

- reviewed/merged SHA;
- CI result;
- Cloud Build result;
- Cloud Run revision/update result;
- public `/health.build.sha`;
- task queue health;
- feature smoke-test result.

Do not report a release complete unless the live public endpoint is serving the intended SHA.

## Security

Follow `SECURITY.md`.

Never commit or paste secret values. Never reuse another application's production credential to make APEX work. Never create substitute infrastructure because access to the intended production target is unavailable.

## Code-review posture

Review for both correctness and unintended autonomy expansion.

Ask:

- Does this change broaden what an agent can do without approval?
- Can concurrent agents oversubscribe a resource or duplicate work?
- Can a provider outage be mistaken for task failure or success?
- Does the code verify external side effects rather than trusting narration?
- Can it accidentally target the wrong production project/service/database?
- Does rollback remain possible?
- Are logs useful without leaking secrets?

## Completion standard

A change is complete when implementation, validation, and documentation agree about reality.

Unknowns should remain explicitly unknown. Do not mark checklist items complete, claim deployments, or manufacture status because the intended work looks plausible.
