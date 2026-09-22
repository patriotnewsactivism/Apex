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
import {
  createPortfolioWorkforce,
  isOnDemandPortfolioAgent,
} from './portfolio-workforce.js';
import type { BaseAgent } from '@workspace/core';

export * from './apex-ceo.js';
export * from './cto.js';
export * from './coo.js';
export * from './lead-developer.js';
export * from './specialists.js';
export * from './business.js';
export * from './qa-director.js';
export * from './portfolio-skills.js';
export * from './portfolio-workforce.js';

// ─── Workforce Registry ───────────────────────────────────────────────────────
//
// The original 13 stable IDs remain first-class runtime workers because goals,
// scheduled jobs, persisted tasks, dashboards, and historical telemetry already
// refer to them. The expanded portfolio organization is layered around those
// stable IDs rather than duplicating them.
//
// Most new specialists are on-demand: they are initialized/addressable at boot
// but their polling loop is activated only after work is queued to them. This
// keeps a 200+ role organization from becoming a 200+ idle-DB-poller problem.

export type WorkforceOptions = {
  approvalRequired?: boolean;
  llmProvider?: string;
  llmModel?: string;
};

function stableAgentOverrides(
  AgentClass: unknown,
  options: WorkforceOptions,
): Record<string, unknown> {
  const overrides: Record<string, unknown> =
    options.approvalRequired !== undefined ? { approvalRequired: options.approvalRequired } : {};

  if (AgentClass === ApexCEO) {
    overrides.name = 'Atlas';
  } else if (AgentClass === LeadDeveloperAgent) {
    overrides.name = 'Forge';
    overrides.parentId = 'apex-ceo-001';
  } else if (AgentClass === CTOAgent) {
    overrides.name = 'Architect';
    overrides.parentId = 'apex-lead-dev-001';
  } else if (AgentClass === DevOpsAgent) {
    overrides.name = 'Sentinel';
    overrides.parentId = 'apex-lead-dev-001';
  } else if (AgentClass === MarketingAgent) {
    overrides.name = 'Madison';
    overrides.parentId = 'apex-ceo-001';
  } else if (AgentClass === LeadResearchAgent) {
    overrides.name = 'Researcher';
    overrides.parentId = 'apex-revenue-chief-001';
  } else if (AgentClass === SalesAgent) {
    overrides.name = 'Sales Core';
    overrides.parentId = 'apex-revenue-chief-001';
  } else if (AgentClass === CustomerSuccessAgent) {
    overrides.name = 'CustomerSuccess';
    overrides.parentId = 'apex-revenue-chief-001';
  } else if (AgentClass === QADirectorAgent) {
    // The existing QA Director remains BuildMyBot-focused; the new portfolio
    // Breakers role is separate and cross-project.
    overrides.parentId = 'apex-bmb-commander-001';
  }

  if (AgentClass === LeadResearchAgent) {
    const configured = Number(process.env.APEX_LEAD_RESEARCH_CONCURRENCY ?? 5);
    overrides.concurrency = Number.isFinite(configured)
      ? Math.min(5, Math.max(1, Math.floor(configured)))
      : 5;
  }

  return overrides;
}

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
    const overrides = stableAgentOverrides(AgentClass, options);
    const agent = new (AgentClass as new (overrides?: Record<string, unknown>) => BaseAgent)(overrides);
    if (workforce.has(agent.id)) throw new Error(`Duplicate stable workforce id: ${agent.id}`);
    workforce.set(agent.id, agent);
  }

  const portfolio = createPortfolioWorkforce({ approvalRequired: options.approvalRequired });
  for (const [id, agent] of portfolio) {
    if (workforce.has(id)) throw new Error(`Portfolio workforce id collides with stable agent: ${id}`);
    workforce.set(id, agent);
  }

  return workforce;
}

/**
 * Initialize registered agents in bounded batches. A 200+ role organization
 * should not issue hundreds of concurrent Postgres upserts during a deploy.
 */
export async function initializeWorkforce(workforce: Map<string, BaseAgent>): Promise<void> {
  const agents = [...workforce.values()];
  const batchSize = Math.max(1, Number(process.env.APEX_AGENT_INIT_BATCH_SIZE ?? 12) || 12);
  for (let i = 0; i < agents.length; i += batchSize) {
    await Promise.all(agents.slice(i, i + batchSize).map((agent) => agent.initialize()));
  }
}

/**
 * Compatibility helper for callers outside runtime-bootstrap. On-demand
 * portfolio specialists are deliberately excluded until they have queued work.
 */
export async function startWorkforce(workforce: Map<string, BaseAgent>): Promise<void> {
  const standing = [...workforce.values()].filter((agent) => !isOnDemandPortfolioAgent(agent));
  await Promise.all(standing.map((agent) => agent.start()));
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
export * from './load-from-config.js';
