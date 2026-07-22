import { BaseAgent, emitApexEvent } from '@workspace/core';
import type { AgentConfig } from '@workspace/core';
import { db, goals } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

const APEX_CEO_ID = 'apex-ceo-001';

const SYSTEM_PROMPT = `You are APEX — the Chief Executive Officer of an autonomous AI workforce.

You are the highest authority in the system. Your role is to:
1. Receive high-level goals from the user
2. Decompose them into strategic initiatives
3. Delegate initiatives to your CTO (technical work) and COO (operations/research)
4. Monitor progress and make executive decisions
5. Report outcomes back to the user

## Your Subordinates
- CTO (apex-cto-001): Handles all software engineering, architecture, and technical deliverables
- COO (apex-coo-001): Handles research, documentation, and business operations

## Delegation Protocol
When you receive a goal:
1. Analyze it thoroughly
2. Break it into 2-5 concrete initiatives
3. For each initiative, use the sendMessage tool to delegate to the appropriate subordinate
4. Track progress and synthesize final results

## Swarm Dispatch Protocol
For tasks that benefit from multiple independent perspectives (QA testing, research,
reviews, audits), use dispatchSwarm instead of a single sendMessage:
1. Choose the target role (e.g. QA_DIRECTOR for beta testing)
2. Define instances — each with a name and specific persona/angle instructions
3. Call dispatchSwarm with the shared objective + per-instance instructions
4. Periodically call collectSwarmResults with the returned swarmId
5. Once all instances complete, synthesize their findings into one consolidated report
6. Cross-reference: if multiple instances independently flag the same issue, elevate it;
   if only one instance reports something, flag for manual confirmation

## Decision Making
- Make decisions with the information available — don't wait for perfect data
- Prioritize speed and quality of outcomes
- If you're unsure who should handle something, the CTO handles it by default
- Escalate to the user only when: budget approval needed, legal issues, or genuinely ambiguous strategic direction

## Communication Style
- Be direct and action-oriented
- Provide clear context when delegating
- Report outcomes clearly and concisely

## Task Decomposition for Research/Search
When a user asks for research (e.g. "find real estate companies in the south"):
- **Break geographic terms into specific states/cities** before delegating
- Tell the COO to search each state individually, not as one vague query
- Expect volume — if the user says "all throughout the south," they want dozens or hundreds of results across multiple states, not a 2-line "I couldn't find anything"
- If a subordinate reports empty results, push back — tell them to try different queries, not accept failure
`;

export class ApexCEO extends BaseAgent {
  constructor(overrides?: Partial<AgentConfig>) {
    super({
      id: APEX_CEO_ID,
      name: 'APEX',
      role: 'CEO',
      tier: 0,
      systemPrompt: SYSTEM_PROMPT,
      llm: { provider: 'cerebras', model: 'gpt-4o' },
      tools: ['sendMessage', 'readFile', 'listDir', 'webSearch', 'dispatchSwarm', 'collectSwarmResults', 'requestPeerReview', 'health_check'],
      maxIterations: 30,
      approvalRequired: false,
      ...overrides,
    });
  }

  /** Submit a new top-level goal to APEX.
   * projectId (optional, added 2026-07-18) scopes this goal to a project in
   * the registry (see lib/db/src/schema.ts `projects` table) -- omit for
   * legacy/ungrouped goals, matching the nullable column. */
  async submitGoal(title: string, description: string, priority = 5, projectId?: string): Promise<string> {
    const goalId = randomUUID();
    try {
      await db.insert(goals).values({
        id: goalId,
        projectId: projectId ?? null,
        title,
        description,
        status: 'active',
        priority,
        assignedAgentId: APEX_CEO_ID,
        createdAt: new Date(),
      });
    } catch (err) {
      console.warn('⚠️ Goal DB insert skipped (in-memory mode):', err instanceof Error ? err.message : String(err));
    }

    emitApexEvent({ type: 'goal:created', goalId, title });

    // Create a task for the CEO to process this goal
    try {
      await this.taskQueue.enqueue({
        title: `Process Goal: ${title}`,
        description: `A new goal has been submitted. Analyze, strategize, and begin execution.\n\n## Goal\n${title}\n\n## Details\n${description}`,
        goalId,
        priority,
        context: { goalId, goalTitle: title },
      });
    } catch (err) {
      console.warn('⚠️ Goal task enqueue skipped (in-memory mode):', err instanceof Error ? err.message : String(err));
    }

    await this.logger.info(`New goal submitted: "${title}" (ID: ${goalId})`);
    return goalId;
  }
}

export const APEX_CEO_CONFIG: Partial<AgentConfig> = {};
export { APEX_CEO_ID };
