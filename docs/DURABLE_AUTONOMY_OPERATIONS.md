# Durable Autonomy Operations

This runbook governs browser-independent APEX execution on Google Cloud Run.

It supplements `docs/PRODUCTION_OPERATIONS.md` and ADR-011 in `docs/ARCHITECTURE_DECISIONS.md`. If this document conflicts with live production evidence or a higher-precedence governing document, stop and resolve the conflict before changing production.

## Release invariant

APEX is not durably autonomous merely because:

- the dashboard is reachable;
- the API process is alive;
- an agent says it scheduled work;
- `scheduled_jobs` contains a future timestamp;
- a JavaScript polling loop started;
- a Cloud Run revision is Ready.

Durable autonomy requires both:

1. durable Postgres-backed work/schedule/claim state; and
2. a verified Cloud Run execution source that receives CPU independently of an open dashboard/browser request.

## Dedicated worker command

The repository exposes:

```sh
pnpm --filter @workspace/api-server run start:worker
```

The worker command uses the same immutable production image and the same governed workforce/scheduler implementation as the HTTP control plane.

The worker performs a read-only database readiness probe before starting. It does **not** call the application migration routine and must not be used as a schema-management mechanism.

## Before any infrastructure change

Resolve these values from trusted production configuration or direct Google Cloud evidence. Do not infer them from repository names, domains, historical notes, another project, or an old deployment:

- Google Cloud project;
- Cloud Run region;
- exact existing HTTP service;
- current image/revision and build SHA;
- runtime service account;
- Secret Manager/environment bindings;
- current min/max instance configuration;
- current CPU allocation/throttling mode;
- ingress/authentication configuration;
- production database target.

If any required identifier cannot be verified, stop. Missing target information is a failed precondition, not permission to guess.

## Determine the existing runtime behavior

Inspect the exact existing HTTP service before selecting a topology.

The inspection must establish whether background CPU remains available when no HTTP request is active and whether at least one instance is intentionally kept available. Do not assume either behavior from application code.

Record the observed configuration and its source as release evidence.

## Allowed architecture decision paths

Choose one reviewed path based on verified existing configuration and operational needs.

### Path A — existing HTTP service intentionally provides autonomous CPU

This path is valid only when the existing service is deliberately configured so the APEX process continues receiving CPU without active requests and the required minimum instance count is intentionally maintained.

Do not create a replacement service. Any change to scaling or CPU allocation is an infrastructure mutation and must follow the repository approval/rollback rules.

The existing API entrypoint already starts the workforce and scheduler; atomic Postgres task/job claiming protects correctness when multiple instances are live.

### Path B — dedicated Cloud Run worker execution

A separate Cloud Run-native worker execution resource may run the same immutable image using the `start:worker` command.

A new Worker Pool or other additional Cloud Run resource is an explicit topology change. Before creating one:

- verify exact project/region;
- document the resource design and cost/scaling policy;
- bind only the required runtime secrets/service account;
- preserve least privilege;
- define rollback/removal steps;
- verify the image/build SHA;
- confirm it cannot run migrations;
- confirm task/job claims remain safe with HTTP instances also present.

Do not clone the HTTP service configuration by guessing. Read required configuration from the actual existing service and Secret Manager bindings.

### Path C — finite Scheduler/Job wake design

Cloud Scheduler and/or Cloud Run Jobs are acceptable only if the complete design keeps processing long enough to execute the durable workload, not merely long enough to insert another task.

A request that wakes an HTTP endpoint and then returns is **not** sufficient if request-scoped CPU can stop before queued agent work executes.

If a finite drain-worker design is introduced later, it must have explicit idle/drain termination semantics, bounded runtime, durable claims, and restart tests before this path is considered production-ready.

## Production activation sequence

Do not activate a durable worker topology until all applicable repository gates are green:

1. `pnpm install --frozen-lockfile`
2. `pnpm run typecheck:production`
3. deterministic production guards
4. dashboard build
5. required branch/review guards
6. immutable Cloud Build from the intended clean commit using `cloudbuild.apex.yaml`
7. infrastructure approval if scaling/CPU/additional resources change

A new image does not authorize a new infrastructure topology by itself.

## No-browser acceptance test

Before declaring durable autonomy operational:

1. Record the expected immutable build SHA.
2. Create a harmless scheduled test job with a unique durable identifier and a future due time.
3. Verify the schedule row exists in Postgres and is not duplicated.
4. Close the dashboard/browser and stop sending user traffic intended to keep the service warm.
5. Wait for the verified Cloud Run execution source to process the due occurrence.
6. Verify exactly one scheduled execution log exists for the occurrence.
7. Verify any child task is durably persisted, claimed, and completed from backend evidence.
8. Verify no duplicate child task or duplicate external action exists.
9. Repeat while replacing/terminating a worker during execution.
10. Verify stale durable claims recover and the work progresses without duplicate side effects.
11. Verify production `/health` reports the expected `build.sha` and a healthy task-queue verdict.

Do not substitute agent narration for database/tool/provider evidence.

## Timeout quarantine acceptance test

For a controlled test task whose execution exceeds the BaseAgent hard wall-clock ceiling:

1. verify the task transitions to `blocked` with the timeout-quarantine reason;
2. verify `next_retry_at` is null;
3. verify no second worker claims the task automatically;
4. verify a late failure from the original execution does not reopen it;
5. verify an independently cancelled terminal task cannot be overwritten as completed by a late promise;
6. verify operator recovery/unblock remains deliberate.

## Approval acceptance test

For a gated action:

1. create the exact proposed action;
2. verify a durable pending approval exists;
3. verify execution stops before the side effect;
4. race two resolution attempts and verify only one can transition the pending row;
5. verify an escalation cannot be approved as a gated action;
6. verify rejection stays rejected;
7. verify stale/replayed approval requests return conflict instead of rewriting history.

Restart-safe approval continuation and immutable normalized payload binding remain separate release requirements until their implementation and acceptance tests are complete.

## Rollback

Application rollback continues to use the existing Cloud Run rollback process and exact build-SHA verification.

If a newly approved worker topology causes incorrect behavior:

- stop the additional worker execution source or restore the previously verified scaling/CPU setting according to its approved rollback plan;
- do not delete durable task/job/approval evidence to make the dashboard look clean;
- inspect running/blocked/retry state for partially executed work;
- verify external side effects before resuming tasks;
- preserve execution logs for incident analysis;
- confirm the HTTP control plane remains the exact existing service.

## Completion standard

Durable autonomy is complete only after production evidence demonstrates useful work progressing with no browser session, safe restart/replacement behavior, deduplicated scheduled execution, and exact build provenance.
