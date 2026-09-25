# BuildMyBot2 Runtime Authority

**Current production authority:** Railway.

- Repository: `patriotnewsactivism/buildmybot2`
- Production branch: `main`
- Railway service: `buildmybot2-web`
- Railway service ID: `60b6d260-f5d8-463d-87be-58339545eaaf`
- Railway production environment ID: `6ce38db0-789b-4fe9-ad02-f068fe6866ae`
- Public domains: `buildmybot.app` and `www.buildmybot.app`
- Runtime: Node/Express (`server.ts`), with handlers under `api/*.ts`
- Durable application state: Supabase. APEX does not connect to that database. Lead handoff uses `POST`/`GET /api/integrations/apex/leads` on `BUILDMYBOT_API_BASE_URL` (default `https://www.buildmybot.app`) with `Authorization: Bearer $BUILDMYBOT_LEAD_INGEST_TOKEN`.

Railway automatically deploys BuildMyBot2 from `main`. APEX's `buildmybot_deploy` tool exists only as an approval-gated manual Railway redeploy/recovery path; it is not required after every normal merge.

Google Cloud Run was the prior BuildMyBot2 production platform before the move to Railway. It is not the current BuildMyBot2 production authority unless explicitly reactivated.

Vercel is not a BuildMyBot2 deployment, runtime, analytics, preview, or serverless-function target. Do not add Vercel-specific dependencies, deployment hooks, request/response types, config files, or operational instructions to BuildMyBot2.

This is distinct from APEX itself: APEX's control-plane/autonomous workforce also currently runs on Railway (project `APEX`, service `apex-backend`). Do not infer one product's service, environment, database, or deployment state from the other.

## APEX connector data-plane status

APEX exposes BuildMyBot service-control capabilities such as health checks, workforce triggers, engineering dispatch, and approval-gated redeploy/recovery.

Lead handoff is the authenticated ingest client:

- `buildmybot_push_leads` posts APEX researched leads. `dryRun` defaults to true. A real push (`dryRun: false`) is hard-gated like other outbound tools. Each lead uses a stable `externalId` of `apex:<researched_leads.id>`. Batches larger than 200 are chunked.
- `buildmybot_recent_leads` reads `GET /api/integrations/apex/leads`.
- If `BUILDMYBOT_LEAD_INGEST_TOKEN` is unset, both tools return a not-configured result and do not throw.
- `401` means the bearer token does not match BuildMyBot. `503` means ingest is disabled on the BuildMyBot side.

`buildmybot_status`, `buildmybot_send_briefing`, `buildmybot_open_errors`, and `buildmybot_resolve_error` stay unregistered because those operations have no API backend. Product-usage/visitor analytics are also not provided by this connector.

### Lead ingest environment

```text
BUILDMYBOT_API_BASE_URL=
BUILDMYBOT_LEAD_INGEST_TOKEN=
```

`BUILDMYBOT_API_BASE_URL` defaults to `https://www.buildmybot.app` when empty. `BUILDMYBOT_LEAD_INGEST_TOKEN` must be the same value as `APEX_LEAD_INGEST_TOKEN` on BuildMyBot, and the BuildMyBot API must be deployed before APEX can hand leads off.

