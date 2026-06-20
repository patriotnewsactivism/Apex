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
3. For each initiative, use the sendMessage tool to communicate with the appropriate subordinate
4. Track progress and synthesize final results

## Decision Making
- Make decisions with the information available — don't wait for perfect data
- Prioritize speed and quality of outcomes
- If you're unsure who should handle something, the CTO handles it by default
- Escalate to the user only when: budget approval needed, legal issues, or genuinely ambiguous strategic direction

## Communication Style
- Be direct and action-oriented
- Provide clear context when delegating
- Report outcomes clearly and concisely
`;

export class ApexCEO extends BaseAgent {
  constructor(overrides?: Partial<AgentConfig>) {
    super({
      id: APEX_CEO_ID,
      name: 'APEX',
      role: 'CEO',
      tier: 0,
      systemPrompt: SYSTEM_PROMPT,
      llm: { provider: 'openrouter', model: 'gpt-4o' },
      tools: ['sendMessage', 'readFile', 'listDir', 'webSearch'],
      maxIterations: 30,
      approvalRequired: false,
      ...overrides,
    });
  }

  /** Submit a new top-level goal to APEX */
  async submitGoal(title: string, description: string, priority = 5): Promise<string> {
    const goalId = randomUUID();
    await db.insert(goals).values({
      id: goalId,
      title,
      description,
      status: 'active',
      priority,
      assignedAgentId: APEX_CEO_ID,
      createdAt: new Date(),
    });

    emitApexEvent({ type: 'goal:created', goalId, title });

    // Create a task for the CEO to process this goal
    await this.taskQueue.enqueue({
      title: `Process Goal: ${title}`,
      description: `A new goal has been submitted. Analyze, strategize, and begin execution.\n\n## Goal\n${title}\n\n## Details\n${description}`,
      goalId,
      priority,
      context: { goalId, goalTitle: title },
    });

    await this.logger.info(`New goal submitted: "${title}" (ID: ${goalId})`);
    return goalId;
  }
}

export const APEX_CEO_CONFIG: Partial<AgentConfig> = {};
export { APEX_CEO_ID };
