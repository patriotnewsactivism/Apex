# Apex — Autonomous AI Workforce

Persistent hierarchical multi-agent platform.

## Where Apex runs (read this before touching deploys)

**Production is AWS Lightsail. Only Lightsail.**

| | |
|---|---|
| Host | AWS Lightsail container service **`apex-service`** |
| Image | `535203103662.dkr.ecr.us-east-1.amazonaws.com/apex-lightsail:latest` |
| Built by | AWS CodeBuild project **`apex-lightsail-build`** (pulls from GitHub) |
| Public URL | `apex.donmatthews.live` → the Lightsail service URL |
| Retired | Railway (2026-08-16). Apex has **never** been hosted on Vercel. |

Deploy sequence (canonical copy in `AGENTS.md`):

```bash
aws codebuild start-build --project-name apex-lightsail-build --region us-east-1
# wait for SUCCEEDED, then:
aws lightsail create-container-service-deployment --service-name apex-service ...
aws lightsail get-container-service-deployments --service-name apex-service   # poll
```

**Vercel and Railway still appear across this repo** in the CI/CD tooling and
BuildMyBot connectors — those are deploy targets for **client projects** Apex
manages, or historical notes. Neither is where Apex itself runs. Don't "fix" a
deploy problem by pointing Apex at one of them, and don't trust any doc below
that implies otherwise over this section and `AGENTS.md`.

Apex can now run that sequence itself: `deploy_to_environment` performs all four
steps and then verifies the live `/health` endpoint, and `rollback_deployment`
restores the previous ACTIVE deployment spec (also health-verified). Both are
approval-gated and both **refuse rather than fake** unless two things are true:

- `APEX_DEPLOY_ENABLED=production` (or `staging` / `all`) — AWS credentials
  merely existing in the process is not consent to ship.
- Scoped AWS credentials are attached. Use a dedicated IAM identity with the
  five actions in [`docs/aws-deploy-iam-policy.json`](docs/aws-deploy-iam-policy.json)
  — **never AWS root-account keys**, which cannot be scoped or cleanly rotated
  and would be handed to 13 autonomous agents.

A throw from either tool means nothing shipped.
Built: Sat Jul 11 12:34:20 UTC 2026
