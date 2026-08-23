# APEX Autopilot Skill

A portable Agent Skills-format workflow for operating the `patriotnewsactivism/Apex` autonomous workforce with maximum safe autonomy.

## What it does

The skill makes an AI operator behave like APEX's operating governor rather than a passive assistant. It:

- establishes live truth before changing code;
- reasons across runtime, agents, queues, LLM providers, token budgets, deployment, business operations, and revenue impact;
- implements reversible fixes automatically;
- verifies typecheck/build/tests and production provenance;
- respects APEX's approval model for irreversible actions;
- creates concise approval packets instead of repeatedly asking vague questions;
- treats a task as complete only when the actual intended outcome is verified.

## Install

This folder follows the Agent Skills open format. Install the whole `apex-autopilot` directory using your product's Skills UI, or place it in a compatible project-level skills directory such as:

```text
.agents/skills/apex-autopilot/
```

The required file is `SKILL.md`; the references/scripts are supporting resources.

## Usage examples

- "Use apex-autopilot and fix APEX."
- "Run APEX and clear the highest-impact blockers."
- "Why is the workforce starving again?"
- "Make APEX more autonomous without weakening production safeguards."
- "Ship this APEX fix and prove the exact commit is live."
- "Audit APEX for anything preventing it from running BuildMyBot on its own."

## Security model

The skill never grants credentials or permissions. It can only use tools/access already available to the host agent. Secrets must remain secret values; reports refer to environment variable names only.

Production deployment, rollback, schema mutations, protected-branch changes, outbound communication, spending, and other irreversible/external actions remain governed by APEX's current approval policy.
