# APEX Security Policy

APEX is an autonomous workforce with access to production systems, external APIs, deployment tooling, and business operations. Security rules in this repository are therefore operational controls, not suggestions.

## Supported code

Security fixes target the current `main` branch and the currently deployed production revision. Historical branches and retired infrastructure are not considered supported production environments unless explicitly reactivated through a reviewed architecture decision.

## Reporting a vulnerability

Do not publish credentials, tokens, exploit details, or customer-sensitive data in a public issue.

Use a private GitHub Security Advisory or another private maintainer channel for reports that could expose secrets, authentication bypasses, remote-code execution, destructive actions, production data, or active abuse paths.

A good report includes:

- affected component/path;
- reproducible steps;
- impact;
- whether production is currently exposed;
- the smallest safe mitigation you know of;
- evidence without including secret values.

## Secrets

Secret values must never be committed to source control or copied into documentation, issues, PR descriptions, screenshots, logs, build output, agent memory, or generated reports.

Use environment variables and Google Secret Manager references for production secrets.

Important production secret classes include, but are not limited to:

- `OPENROUTER_API_KEY`
- `OPENROUTER_API_KEY_2`
- `APEX_ADMIN_PASSWORD`
- `APEX_ADMIN_TOKEN`
- `DATABASE_URL`
- provider/service API keys and OAuth credentials

If a credential is exposed, treat it as compromised: revoke/rotate it at the provider, remove it from current configuration, assess logs/history for misuse, and document the incident without reproducing the secret.

## Authentication

All `/api/*` routes except `/api/auth/login` and `/health` are expected to remain behind `requireAdminAuth` unless a reviewed design explicitly changes the boundary.

`APEX_ADMIN_PASSWORD` and `APEX_ADMIN_TOKEN` are deployment secrets. There is deliberately no hardcoded source fallback. Missing auth configuration must fail closed rather than activating a credential stored in the repository.

Authentication or authorization changes require focused tests and production smoke verification.

## Production deployment security

APEX production is the existing Google Cloud Run service behind `https://apex.donmatthews.live`.

Production releases must:

- use an authenticated Google identity or Workload Identity rather than committed service-account JSON keys;
- build an immutable image from the exact reviewed Git SHA;
- update only the exact existing Cloud Run service;
- preserve existing Secret Manager references, service account, ingress, scaling, resources, and environment configuration unless a separately reviewed change intentionally modifies them;
- verify the live `/health.build.sha` after rollout;
- keep deploy and rollback approval-gated.

Never create a substitute Cloud Run service because the intended service cannot be found or accessed. Missing access is a failed precondition, not permission to invent infrastructure.

The retired AWS Lightsail/CodeBuild deployment path must not be restored as a fallback.

## Database and Supabase safety

Application runtime access is not equivalent to management-plane authority.

A `DATABASE_URL`, service-role token, or other application credential does not by itself authorize:

- production schema changes;
- destructive SQL;
- migrations against an unverified project;
- project settings changes;
- auth policy changes;
- secret rotation;
- management API operations.

Before production data or management changes, verify the exact target project/environment, verify that the credential is intended for that target, obtain the required approval, and prepare a rollback/recovery path.

Never reuse credentials from another application merely because they work technically.

## Autonomous-agent safeguards

Do not weaken these controls to make agents appear faster or more autonomous:

- per-tool approval gates;
- shell-command approval;
- task deduplication;
- provider backpressure and circuit breakers;
- token reservation/pacing;
- malformed-tool-call detection;
- non-completion detection;
- branch/review guards;
- deployment provenance verification.

An agent narrative is not proof that an external action occurred. Verify side effects against the system of record.

## Dependency and supply-chain changes

Dependency changes must use the existing pnpm workspace and update `pnpm-lock.yaml` consistently.

For production dependencies:

1. prefer maintained packages with clear provenance;
2. avoid unnecessary SDKs and platform clients;
3. run a frozen install after lockfile changes;
4. run production typecheck and the relevant deterministic guards;
5. remove retired provider/platform dependencies when the code path is removed.

Do not add executable install hooks or unreviewed binary downloads without a clear need and explicit review.

## Logging and observability

Logs should contain enough metadata to diagnose failures without exposing secrets or customer-sensitive payloads.

Prefer identifiers, provider/model names, status codes, request IDs, failure classes, and timestamps over raw request/response bodies.

Provider failures, capacity pauses, deploy failures, and repeated task failures must be reported accurately rather than converted into false success states.

## High-risk changes

Require explicit human approval and focused verification for:

- production deploy/rollback;
- authentication or authorization changes;
- secret handling changes;
- destructive database/schema changes;
- financial actions;
- externally sent communications;
- protected branch writes;
- changes that broaden agent tool permissions;
- changes that bypass approval or provenance controls.

## Incident rule

When production is degraded, prioritize containment and recoverability over new features.

Do not stack speculative fixes. Establish the live SHA, current health, recent relevant changes, provider state, and rollback option first. Then make the smallest evidence-backed correction and verify it end to end.

See `docs/PRODUCTION_OPERATIONS.md` for the operational incident and rollback procedure.
