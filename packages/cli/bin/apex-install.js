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

function write(relPath, content) {
  const full = path.join(targetDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

const orgChart = template === "minimal" ? MINIMAL_ORG_CHART : FULL_ORG_CHART;

const written = [];
written.push(write(".apex/agents.json", JSON.stringify({ project: projectName, ...orgChart }, null, 2) + "\n"));
written.push(write(".apex/llm-chain.json", JSON.stringify(LLM_CHAIN, null, 2) + "\n"));
written.push(write(".apex/prompt-forge.json", JSON.stringify(PROMPT_FORGE_CONFIG, null, 2) + "\n"));
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

console.log(`apex-install: wrote ${written.length} files to ${path.resolve(targetDir)}/.apex/`);
written.forEach((w) => console.log(`  - ${w}`));
