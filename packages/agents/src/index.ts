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
import {
  LeadResearchAgent,
  SalesAgent,
  MarketingAgent,
  CustomerSuccessAgent,
} from './business.js';
import { QADirectorAgent } from './qa-director.js';
import type { BaseAgent } from '@workspace/core';

export * from './apex-ceo.js';
export * from './cto.js';
export * from './coo.js';
export * from './lead-developer.js';
export * from './specialists.js';
export * from './business.js';
export * from './qa-director.js';

// ─── Workforce Registry ───────────────────────────────────────────────────────
//
// 12-role org chart (2026-07-12 revision):
//
// APEX CEO (Tier 0)
// ├── CTO (Tier 1)
// │   └── Lead Developer (Tier 2)
// │       ├── Frontend Agent (Tier 3)
// │       ├── Backend Agent (Tier 3)
// │       ├── DevOps Agent (Tier 3)
// │       └── QA Agent (Tier 3)
// └── COO (Tier 1)
//     ├── Lead Researcher (Tier 3)           — real outbound lead-gen, ICP-grounded
//     ├── Sales & Business Development (Tier 3) — pipeline mgmt, honest re: no live calling yet
//     ├── Marketing & Social Media (Tier 3)  — draft-only, honest re: no publish API yet
//     └── Customer Success & Support (Tier 3) — grounded in BUSINESS_PROFILE.md truth
//
// QA Director (Tier 1) — Beta Tester Division. Reasons through named personas
// (novice, security-minded power user, accessibility, buyer, UX reviewer)
// against REAL fetched content from live BuildMyBot surfaces. v1 is
// content-reasoning based, not full browser-interaction automation.
//
// The generic Research/Documentation/Operations trio is kept exported for reuse
// (e.g. ad-hoc internal research/doc tasks) but is NOT part of the standing
// 12-person workforce — the business-specific roles replace them operationally.

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
    LeadResearchAgent,
    SalesAgent,
    MarketingAgent,
    CustomerSuccessAgent,
    QADirectorAgent,
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

export {
  ApexCEO,
  CTOAgent,
  COOAgent,
  LeadDeveloperAgent,
  ResearchAgent,
  DocumentationAgent,
  OperationsAgent,
  QADirectorAgent,
};
