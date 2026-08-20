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

Note: `deploy_to_environment` / `rollback_deployment` are **not implemented** —
they fail with the runbook above rather than faking success. Shipping Apex is a
human action today.
Built: Sat Jul 11 12:34:20 UTC 2026
