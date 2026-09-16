/**
 * load-from-config.ts — reads an installed project's `.apex/agents.json`
 * (written by `apex-install`, see packages/cli) and instantiates a workforce
 * containing ONLY the roles that project's org chart asked for.
 *
 * Honest scope note: this does NOT make agent BEHAVIOR (system prompts,
 * business logic, tool sets) configurable per-project — each role's actual
 * class (ApexCEO, QADirectorAgent, etc.) is still the same hardcoded
 * TypeScript written for Don's own portfolio. What this DOES make
 * per-project-configurable is *which* of the existing generic roles get
 * instantiated and started for a given installed project, plus applying
 * that project's LLM chain preferences from `.apex/llm-chain.json`.
 *
 * Making agent BEHAVIOR itself generic/business-agnostic (so a QA Director
 * instantiated for a third party's SaaS reasons about THEIR product, not
 * BuildMyBot) is a separate, larger follow-on piece of work — not done here.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BaseAgent } from '@workspace/core';
import {
  ApexCEO,
  CTOAgent,
  COOAgent,
  LeadDeveloperAgent,
  FrontendAgent,
  BackendAgent,
  DevOpsAgent,
  QAAgent,
  LeadResearchAgent,
  SalesAgent,
  MarketingAgent,
  CustomerSuccessAgent,
  QADirectorAgent,
} from './index.js';

export interface InstalledAgentsConfig {
  project: string;
  roles: Array<{ id: string; reportsTo: string | null; tokenBudget: number; concurrency?: number; note?: string }>;
}

export interface InstalledLlmChainConfig {
  fallbackOrder: string[];
  disabled: Record<string, string>;
  note?: string;
}

const ALL_AGENT_CLASSES = [
  ApexCEO,
  CTOAgent,
  COOAgent,
  LeadDeveloperAgent,
  FrontendAgent,
  BackendAgent,
  DevOpsAgent,
  QAAgent,
  LeadResearchAgent,
  SalesAgent,
  MarketingAgent,
  CustomerSuccessAgent,
  QADirectorAgent,
];

export function readInstalledConfig(targetDir: string): {
  agents: InstalledAgentsConfig | null;
  llmChain: InstalledLlmChainConfig | null;
} {
  const agentsPath = path.join(targetDir, '.apex', 'agents.json');
  const llmChainPath = path.join(targetDir, '.apex', 'llm-chain.json');
  const agents = fs.existsSync(agentsPath) ? (JSON.parse(fs.readFileSync(agentsPath, 'utf-8')) as InstalledAgentsConfig) : null;
  const llmChain = fs.existsSync(llmChainPath)
    ? (JSON.parse(fs.readFileSync(llmChainPath, 'utf-8')) as InstalledLlmChainConfig)
    : null;
  return { agents, llmChain };
}

/**
 * Instantiates a workforce Map containing only the roles listed in the
 * target project's installed `.apex/agents.json`. Throws if `.apex/agents.json`
 * is missing (run `apex-install` on the target dir first) or if it names a
 * role this version of Apex doesn't have a class for.
 */
export function loadWorkforceFromConfig(
  targetDir: string,
  options: { approvalRequired?: boolean } = {},
): { workforce: Map<string, BaseAgent>; config: InstalledAgentsConfig; llmChain: InstalledLlmChainConfig | null } {
  const { agents, llmChain } = readInstalledConfig(targetDir);
  if (!agents) {
    throw new Error(
      `No .apex/agents.json found in ${targetDir} — run 'apex-install ${targetDir}' first to scaffold an org chart.`,
    );
  }

  const workforce = new Map<string, BaseAgent>();
  const wantedRoleIds = new Set(agents.roles.map((r) => r.id));
  const knownRoleIds = new Set<string>();

  for (const AgentClass of ALL_AGENT_CLASSES) {
    const overrides = options.approvalRequired !== undefined ? { approvalRequired: options.approvalRequired } : {};
    const instance = new (AgentClass as new (o?: Record<string, unknown>) => BaseAgent)(overrides);
    knownRoleIds.add((instance as unknown as { role: string }).role);
    if (wantedRoleIds.has((instance as unknown as { role: string }).role)) {
      workforce.set(instance.id, instance);
    }
  }

  const unknownRoles = [...wantedRoleIds].filter((r) => !knownRoleIds.has(r));
  if (unknownRoles.length > 0) {
    throw new Error(
      `.apex/agents.json requests role(s) [${unknownRoles.join(', ')}] that this Apex version has no agent class for. ` +
        `Known roles: ${[...knownRoleIds].join(', ')}.`,
    );
  }

  return { workforce, config: agents, llmChain };
}
