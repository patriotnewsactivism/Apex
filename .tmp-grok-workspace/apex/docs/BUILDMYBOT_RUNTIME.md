# BuildMyBot2 Runtime Authority

**Current production authority:** Railway.

- Repository: `patriotnewsactivism/buildmybot2`
- Production branch: `main`
- Railway service: `buildmybot2-web`
- Railway service ID: `60b6d260-f5d8-463d-87be-58339545eaaf`
- Railway production environment ID: `6ce38db0-789b-4fe9-ad02-f068fe6866ae`
- Public domains: `buildmybot.app` and `www.buildmybot.app`
- Runtime: Node/Express (`server.ts`), with handlers under `api/*.ts`
- Durable application state: Supabase

Railway automatically deploys BuildMyBot2 from `main`. APEX's `buildmybot_deploy` tool exists only as an approval-gated manual Railway redeploy/recovery path; it is not required after every normal merge.

Google Cloud Run was the prior BuildMyBot2 production platform before the move to Railway. It is not the current BuildMyBot2 production authority unless explicitly reactivated.

Vercel is not a BuildMyBot2 deployment, runtime, analytics, preview, or serverless-function target. Do not add Vercel-specific dependencies, deployment hooks, request/response types, config files, or operational instructions to BuildMyBot2.

This is distinct from APEX itself: APEX's control-plane/autonomous workforce runs on Google Cloud Run. Do not infer BuildMyBot2's hosting platform from APEX's hosting platform, or vice versa.
