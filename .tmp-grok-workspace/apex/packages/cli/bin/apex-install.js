#!/usr/bin/env node
/**
 * apex-install — CLI installer, v0.1 (MVP slice)
 *
 * Scaffolds the CORE of an Apex-managed project into any target repo:
 *   - .apex/agents.json      org chart (roles + reporting lines)
 *   - .apex/llm-chain.json   confirmed-live provider fallback chain + per-role token budgets
 *   - .apex/prompt-forge.json  wiring for the meta-prompt-optimization module
 *   - .apex/README.md        what's installed vs. what's roadmap
 *
 * Usage:
 *   node apex-install.js <target-dir> [--template=full|minimal] [--name="Project Name"]
 *
 * NOT yet built (see roadmap in generated README): CI/CD webhook wiring,
 * connector/integration opt-in, cron scheduling, billing/multi-tenant control
 * plane. This installs the swarm's BRAIN (org chart + LLM chain + prompt
 * optimization config) — the automation/connector layer is the next slice.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const targetDir = args.find((a) => !a.startsWith("--")) || ".";
const template = (args.find((a) => a.startsWith("--template="))?.split("=")[1]) || "full";
const projectName = (args.find((a) => a.startsWith("--name="))?.split("=")[1]) || path.basename(path.resolve(targetDir));
const requestedConnectors = (args.find((a) => a.startsWith("--connectors="))?.split("=")[1] || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const FULL_ORG_CHART = {
  roles: [
    { id: "CEO", reportsTo: null, tokenBudget: 16384 },
    { id: "CTO", reportsTo: "CEO", tokenBudget: 16384 },
    { id: "COO", reportsTo: "CEO", tokenBudget: 16384 },
    { id: "LEAD_DEV", reportsTo: "CTO", tokenBudget: 16384 },
    { id: "FRONTEND", reportsTo: "LEAD_DEV", tokenBudget: 8192 },
    { id: "BACKEND", reportsTo: "LEAD_DEV", tokenBudget: 8192 },
    { id: "DEVOPS", reportsTo: "LEAD_DEV", tokenBudget: 8192 },
    { id: "QA", reportsTo: "LEAD_DEV", tokenBudget: 8192 },
    { id: "LEAD_RESEARCH", reportsTo: "COO", tokenBudget: 16384, concurrency: 4 },
    { id: "SALES", reportsTo: "COO", tokenBudget: 16384 },
    { id: "MARKETING", reportsTo: "COO", tokenBudget: 8192 },
    { id: "CUSTOMER_SUCCESS", reportsTo: "COO", tokenBudget: 8192 },
    { id: "QA_DIRECTOR", reportsTo: "CEO", tokenBudget: 16384, concurrency: 4, note: "13th agent — nightly automated cross-project QA sweep" },
  ],
};

const MINIMAL_ORG_CHART = {
  roles: [
    { id: "LEAD_DEV", reportsTo: null, tokenBudget: 16384 },
    { id: "QA", reportsTo: "LEAD_DEV", tokenBudget: 8192 },
  ],
};

const LLM_CHAIN = {
  fallbackOrder: ["cerebras", "groq", "cohere", "mistral"],
  disabled: {
    qwen: "dead — invalid/blocked keys portfolio-wide as of last audit",
    kilo: "billing-blocked — negative balance",
    deepseek: "billing-blocked — insufficient balance",
    xai: "billing-blocked — credits exhausted",
  },
  note: "Verify each provider is still live before relying on this in production — re-run a real completion call, don't trust this file blindly after time has passed.",
};

const PROMPT_FORGE_CONFIG = {
  enabled: true,
  module: "prompt-forge",
  description: "Meta-prompt optimization: generate -> critique (clarity/success-rate/persona-match) -> test-drive -> refine, converges on plateau or maxIterations.",
  defaultMaxIterations: 8,
  scoringAxes: ["clarity", "success_rate", "persona_match"],
};

const force = args.includes("--force");

/**
 * Writes relPath UNLESS it already exists (true idempotency — re-running
 * apex-install, e.g. from the CI sync workflow, must never silently clobber
 * a project owner's manual edits to their own .apex/ config). Pass --force
 * to intentionally overwrite (e.g. after bumping a template default).
 */
/**
 * Connector catalog — declarative only. Installing a connector here does NOT
 * perform any OAuth flow or network call; it just declares which optional
 * integrations this project WANTS, and which env vars each one needs. The
 * runtime loader (getConnectorStatus) then cross-checks actual process.env
 * to report real configured/missing status — no guessing, no faking "connected".
 */
const CONNECTOR_CATALOG = {
  slack: {
    description: "Slack notifications (agent status posts, alerts)",
    requiredEnvVars: ["SLACK_BOT_TOKEN"],
  },
  stripe: {
    description: "Stripe billing (subscriptions, one-off charges)",
    requiredEnvVars: ["STRIPE_SECRET_KEY"],
  },
  supabase: {
    description: "Supabase (Postgres + auth + storage backend)",
    requiredEnvVars: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
  },
};

function buildConnectorsConfig() {
  const connectors = {};
  for (const [id, def] of Object.entries(CONNECTOR_CATALOG)) {
    connectors[id] = {
      enabled: requestedConnectors.includes(id),
      description: def.description,
      requiredEnvVars: def.requiredEnvVars,
    };
  }
  const unknown = requestedConnectors.filter((id) => !CONNECTOR_CATALOG[id]);
  if (unknown.length > 0) {
    console.warn(`apex-install: warning — unknown connector id(s) ignored: ${unknown.join(", ")}. Known: ${Object.keys(CONNECTOR_CATALOG).join(", ")}`);
  }
  return connectors;
}

function write(relPath, content) {
  const full = path.join(targetDir, relPath);
  if (fs.existsSync(full) && !force) {
    return { path: full, skipped: true };
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return { path: full, skipped: false };
}

const orgChart = template === "minimal" ? MINIMAL_ORG_CHART : FULL_ORG_CHART;

const written = [];
written.push(write(".apex/agents.json", JSON.stringify({ project: projectName, ...orgChart }, null, 2) + "\n"));
written.push(write(".apex/llm-chain.json", JSON.stringify(LLM_CHAIN, null, 2) + "\n"));
written.push(write(".apex/prompt-forge.json", JSON.stringify(PROMPT_FORGE_CONFIG, null, 2) + "\n"));
written.push(write(".apex/connectors.json", JSON.stringify(buildConnectorsConfig(), null, 2) + "\n"));
written.push(
  write(
    ".apex/crons.json",
    JSON.stringify(
      {
        note:
          "Standard 5-field cron (minute hour day month weekday), evaluated in UTC unless a 'timezone' field is added per-entry. Disabled by default — flip enabled:true once you've confirmed the schedule with getNextRunTimes() from @workspace/core's cron-utils.",
        crons: [
          {
            id: "nightly-qa-sweep",
            schedule: "0 3 * * *",
            roleId: orgChart.roles.some((r) => r.id === "QA_DIRECTOR") ? "QA_DIRECTOR" : "QA",
            description: "Nightly QA sweep across this project's live surfaces",
            enabled: false,
          },
        ],
      },
      null,
      2,
    ) + "\n",
  ),
);
written.push(
  write(
    ".github/workflows/apex-swarm-sync.yml",
    `name: Apex Swarm Config Sync

# Keeps this project's .apex/ config in sync on every push to main.
# NOTE: this is the CONFIG-SYNC layer only — it re-runs apex-install
# idempotently (never overwrites files that already exist) so the org
# chart / LLM chain / prompt-forge config stay present and don't get
# accidentally deleted. It does NOT yet trigger an actual live swarm run
# against this repo — that's separate follow-on work (the runtime needs
# API keys/secrets wired in via repo secrets before it could safely do that).

on:
  push:
    branches: [main]
  workflow_dispatch: {}

jobs:
  sync-apex-config:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout this repo
        uses: actions/checkout@v4

      - name: Sparse-checkout Apex CLI
        run: |
          git clone --depth 1 --filter=blob:none --sparse https://github.com/patriotnewsactivism/Apex.git /tmp/apex-cli-src
          cd /tmp/apex-cli-src
          git sparse-checkout set packages/cli

      - name: Run apex-install (idempotent — will not overwrite existing .apex/ files)
        run: node /tmp/apex-cli-src/packages/cli/bin/apex-install.js . --name="\${{ github.repository }}"

      - name: Commit any newly-scaffolded files
        run: |
          if [ -n "$(git status --porcelain .apex .github/workflows/apex-swarm-sync.yml)" ]; then
            git config user.email "apex-bot@users.noreply.github.com"
            git config user.name "apex-swarm-sync"
            git add .apex .github/workflows/apex-swarm-sync.yml
            git commit -m "chore: sync Apex swarm config [skip ci]"
            git push
          else
            echo "No config drift — nothing to commit."
          fi
`
  )
);

written.push(
  write(
    ".apex/README.md",
    `# ${projectName} — Apex-managed project

Installed by \`apex-install\` v0.1 (template: ${template}).

## What's live right now
- **Org chart** (\`agents.json\`) — ${orgChart.roles.length} role(s), reporting lines defined.
- **LLM fallback chain** (\`llm-chain.json\`) — confirmed-live provider order, dead providers documented and excluded.
- **Prompt Forge config** (\`prompt-forge.json\`) — meta-prompt optimization loop wired for this project's agents to self-improve their own prompts.

## Roadmap — not yet installed by this CLI
- CI/CD webhook wiring (GitHub Actions / Railway / Vercel deploy hooks auto-configured)
- Connector opt-in (Slack, Stripe, Supabase, etc. — per-project integration catalog)
- Cron scheduling for recurring agent work (e.g. nightly QA sweeps)
- Delegation/reasoning runtime — this CLI only writes CONFIG; the actual swarm runtime that reads this config and executes agents still needs to be pointed at this project
- Multi-tenant billing/control-plane (this is currently a local CLI, not a hosted product)

This is v0.1 — the core config layer. Next slice: wire the CI/CD + connector installers.
`
  )
);

const created = written.filter((w) => !w.skipped);
const skipped = written.filter((w) => w.skipped);
console.log(`apex-install: ${created.length} file(s) created, ${skipped.length} already present (left untouched) in ${path.resolve(targetDir)}`);
created.forEach((w) => console.log(`  + ${w.path}`));
skipped.forEach((w) => console.log(`  = ${w.path} (unchanged)`));
if (skipped.length > 0 && !force) {
  console.log("Pass --force to overwrite existing files instead of skipping them.");
}
