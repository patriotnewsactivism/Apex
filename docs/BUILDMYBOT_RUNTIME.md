# BuildMyBot2 Runtime Authority

**Current production authority:** Railway.

- Repository: `patriotnewsactivism/buildmybot2`
- Production branch: `main`
- Railway service: `buildmybot2-web`
- Railway service ID: `60b6d260-f5d8-463d-87be-58339545eaaf`
- Railway production environment ID: `6ce38db0-789b-4fe9-ad02-f068fe6866ae`
- Public domains: `buildmybot.app` and `www.buildmybot.app`
- Runtime: Node/Express (`server.ts`), with handlers under `api/*.ts`
- Durable application state (as assumed by current APEX connector/source): Neon/Postgres. Verify against the BuildMyBot2 repository/live configuration before database-level work.

Railway automatically deploys BuildMyBot2 from `main`. APEX's `buildmybot_deploy` tool exists only as an approval-gated manual Railway redeploy/recovery path; it is not required after every normal merge.

Google Cloud Run was the prior BuildMyBot2 production platform before the move to Railway. It is not the current BuildMyBot2 production authority unless explicitly reactivated.

Vercel is not a BuildMyBot2 deployment, runtime, analytics, preview, or serverless-function target. Do not add Vercel-specific dependencies, deployment hooks, request/response types, config files, or operational instructions to BuildMyBot2.

This is distinct from APEX itself: APEX's control-plane/autonomous workforce also currently runs on Railway (project `APEX`, service `apex-backend`). Do not infer one product's service, environment, database, or deployment state from the other.

## APEX connector data-plane status

APEX currently exposes BuildMyBot service-control capabilities such as health checks, workforce triggers, engineering dispatch, and approval-gated redeploy/recovery. The legacy direct data-plane tools for BuildMyBot status, briefings, errors, lead push, and recent-lead reads are intentionally filtered out in `packages/core/src/buildmybot-connector.ts` until their query layer is genuinely Neon-backed or a BuildMyBot management API exposes those operations.

Therefore, do not treat `buildmybot_status`, `buildmybot_send_briefing`, `buildmybot_open_errors`, `buildmybot_resolve_error`, `buildmybot_push_leads`, or `buildmybot_recent_leads` as available runtime tools. Product-usage/visitor analytics are also not provided by the current APEX connector.

