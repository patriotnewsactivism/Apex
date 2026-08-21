import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { AGENT_CONFIGS } from './agentConfigs.js';

// ─── Workforce Bootstrap ─────────────────────────────────────────────────────
//
// Replaces packages/agents/src/index.ts's createWorkforce + initializeWorkforce
// + api-server's `agent.start()` fan-out. Run once (e.g. via `convex run
// bootstrap:bootstrapWorkforce`) to seed/reconcile the 13-agent roster and
// kick off every agent's tick chain. Safe to re-run — upsertByLegacyId and the
// per-role metadata patch are both idempotent; only the tick-kickoff at the
// end could in principle start a second chain for an already-running agent,
// so this should be run once per deployment, not on every boot (unlike the
// old code's per-process agent.start() calls, which were naturally idempotent
// against restarts since the old process itself owned the loop).

export const bootstrapWorkforce = internalAction({
  args: {},
  handler: async (ctx) => {
    const autonomyEnabled =
      (process.env.APEX_CONVEX_AUTONOMY_ENABLED ?? 'false').toLowerCase() === 'true';
    // Pass 1: upsert every agent so parent-legacyId resolution always finds
    // its parent regardless of array order.
    for (const cfg of AGENT_CONFIGS) {
      await ctx.runMutation(internal.agents.upsertByLegacyId, {
        legacyId: cfg.legacyId,
        name: cfg.name,
        role: cfg.role,
        tier: cfg.tier,
        parentLegacyId: cfg.parentLegacyId,
        systemPrompt: cfg.systemPrompt,
        // Cosmetic/legacy fields — the model actually used per LLM call is
        // resolved fresh each time via getDefaultLLMConfig(role) in llmConfig.ts.
        model: 'gpt-oss-120b',
        provider: 'cerebras',
      });
    }

    // Pass 2: stash per-role runtime config into metadata, then kick off
    // each agent's tick chain.
    const kicked: string[] = [];
    for (const cfg of AGENT_CONFIGS) {
      const agent = await ctx.runQuery(internal.agents.getByLegacyId, { legacyId: cfg.legacyId });
      if (!agent) continue;

      const concurrency = cfg.concurrency ?? 1;
      await ctx.runMutation(internal.agents.patchMetadata, {
        agentId: agent._id,
        metadata: {
          maxIterations: cfg.maxIterations ?? 20,
          concurrency,
          tools: cfg.tools,
          approvalRequired: cfg.approvalRequired,
        },
      });

      if (autonomyEnabled) {
        await ctx.scheduler.runAfter(0, internal.agentLoop.tick, { agentId: agent._id, concurrency });
        kicked.push(cfg.legacyId);
      }
    }

    return { seeded: AGENT_CONFIGS.length, kicked, autonomyEnabled };
  },
});
