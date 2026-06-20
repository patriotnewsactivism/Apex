import { ApexCEO } from './apex-ceo.js';
import { CTOAgent } from './cto.js';
import { COOAgent } from './coo.js';
import { LeadDeveloperAgent } from './lead-developer.js';
import {
  FrontendAgent,
  BackendAgent,
  DevOpsAgent,
  QAAgent,
  ResearchAgent,
  DocumentationAgent,
  OperationsAgent,
} from './specialists.js';
import type { BaseAgent } from '@workspace/core';

export * from './apex-ceo.js';
export * from './cto.js';
export * from './coo.js';
export * from './lead-developer.js';
export * from './specialists.js';

// ─── Workforce Registry ───────────────────────────────────────────────────────

export type WorkforceOptions = {
  approvalRequired?: boolean;
  llmProvider?: string;
  llmModel?: string;
};

export function createWorkforce(options: WorkforceOptions = {}): Map<string, BaseAgent> {
  const workforce = new Map<string, BaseAgent>();

  const agentClasses = [
    ApexCEO,
    CTOAgent,
    COOAgent,
    LeadDeveloperAgent,
    FrontendAgent,
    BackendAgent,
    DevOpsAgent,
    QAAgent,
    ResearchAgent,
    DocumentationAgent,
    OperationsAgent,
  ];

  for (const AgentClass of agentClasses) {
    const agent = new (AgentClass as new (overrides?: Record<string, unknown>) => BaseAgent)(
      options.approvalRequired !== undefined ? { approvalRequired: options.approvalRequired } : {},
    );
    workforce.set(agent.id, agent);
  }

  return workforce;
}

/** Initialize all agents (upsert DB records) */
export async function initializeWorkforce(workforce: Map<string, BaseAgent>): Promise<void> {
  await Promise.all([...workforce.values()].map((a) => a.initialize()));
}

/** Start all agents' autonomous execution loops */
export async function startWorkforce(workforce: Map<string, BaseAgent>): Promise<void> {
  // Start all agents concurrently — each runs its own polling loop
  await Promise.all([...workforce.values()].map((a) => a.start()));
}

export { ApexCEO, CTOAgent, COOAgent, LeadDeveloperAgent };
