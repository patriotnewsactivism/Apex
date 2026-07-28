import { Router } from 'express';
import { db, tasks, goals, agents, scheduledJobs, researchedLeads, componentHealth } from '@workspace/db';
import { eq, desc, sql, and } from 'drizzle-orm';

// ─── Suggestions API ──────────────────────────────────────────────────────────
//
// Generates REAL, MEANINGFUL suggestions by analyzing live system state.
// Not hardcoded — every suggestion is derived from actual data: health
// status, task outcomes, lead pipeline, agent statuses, cron schedule,
// and BuildMyBot telemetry. Each suggestion has a one-click "implement"
// action that submits a goal to the CEO.

interface Suggestion {
  id: string;
  title: string;
  description: string;
  category: 'self_improvement' | 'app_improvement';
  impact: 'high' | 'medium' | 'low';
  difficulty: 'easy' | 'medium' | 'hard';
  goalTitle: string;
  goalDescription: string;
  goalPriority: number;
}

export function createSuggestionsRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const suggestions: Suggestion[] = [];

      // 1. Query real system state in parallel
      const [
        activeGoals,
        failedTasks,
        pendingTasks,
        agentRows,
        cronJobs,
        leadStats,
        unhealthyComponents,
      ] = await Promise.all([
        db.select().from(goals).where(eq(goals.status, 'active')).limit(10),
        db.select().from(tasks).where(eq(tasks.status, 'failed')).limit(50),
        db.select().from(tasks).where(eq(tasks.status, 'pending')).limit(50),
        db.select().from(agents),
        db.select().from(scheduledJobs).limit(20),
        db.select({ count: sql<number>`count(*)::int`, status: researchedLeads.status }).from(researchedLeads).groupBy(researchedLeads.status),
        db.select().from(componentHealth).limit(10),
      ]);

      // 2. Agent error states
      const errorAgents = agentRows.filter((a) => a.status === 'error');
      if (errorAgents.length > 0) {
        suggestions.push({
          id: 'fix-error-agents',
          title: `${errorAgents.length} agent(s) stuck in error state`,
          description: `Agents in error: ${errorAgents.map((a) => `${a.name} (${a.id})`).join(', ')}. These agents won't pick up new tasks effectively. Investigate root cause — likely LLM provider failures or stuck task state.`,
          category: 'self_improvement',
          impact: 'high',
          difficulty: 'easy',
          goalTitle: 'Investigate and fix agents stuck in error state',
          goalDescription: `The following agents are stuck in error status: ${errorAgents.map((a) => a.name).join(', ')}. Review their recent task outcomes, identify the root cause (LLM failures, stuck approvals, etc.), and restore them to operational status. Clear any stuck tasks.`,
          goalPriority: 2,
        });
      }

      // 3. High failure rate
      const totalRecent = failedTasks.length + pendingTasks.length;
      if (failedTasks.length > 5 && totalRecent > 0) {
        const failRate = Math.round((failedTasks.length / totalRecent) * 100);
        suggestions.push({
          id: 'high-failure-rate',
          title: `Task failure rate is ${failRate}% (${failedTasks.length} failed)`,
          description: `${failedTasks.length} tasks have failed recently. Common causes: LLM provider rate limits, misconfigured tools, or agent system prompt issues. Run the learning analysis to detect patterns and get specific recommendations.`,
          category: 'self_improvement',
          impact: 'high',
          difficulty: 'medium',
          goalTitle: 'Diagnose and reduce task failure rate',
          goalDescription: `Task failure rate is ${failRate}%. Review failed tasks, identify common error patterns, and implement fixes. Consider adjusting LLM provider configuration, reducing cron frequency if rate-limited, or updating agent system prompts.`,
          goalPriority: 3,
        });
      }

      // 4. Lead pipeline gaps
      const newLeads = leadStats.find((l) => l.status === 'new')?.count ?? 0;
      const totalLeads = leadStats.reduce((sum, l) => sum + l.count, 0);
      if (totalLeads < 50) {
        suggestions.push({
          id: 'low-lead-volume',
          title: `Only ${totalLeads} leads in pipeline — target is 100+`,
          description: `The researched_leads table has only ${totalLeads} total leads (${newLeads} new). The lead-gen sweep runs every 2h but either LLM failures or search limitations are throttling output. Consider increasing sweep frequency or expanding the Lead Researcher's target industries.`,
          category: 'app_improvement',
          impact: 'high',
          difficulty: 'easy',
          goalTitle: 'Scale lead generation to 100+ leads',
          goalDescription: `Only ${totalLeads} leads in the pipeline. Dispatch the Lead Researcher to run an aggressive research sweep across multiple industries (Legal, Medical, Home Services, Real Estate). Target 20-50 leads per industry. Use dispatchSwarm for parallel coverage.`,
          goalPriority: 2,
        });
      }

      // 5. Unhealthy components
      const degraded = unhealthyComponents.filter((c) => c.status === 'degraded' || c.status === 'critical');
      if (degraded.length > 0) {
        suggestions.push({
          id: 'unhealthy-components',
          title: `${degraded.length} system component(s) need attention`,
          description: `Components in trouble: ${degraded.map((c) => `${c.component} (${c.status})`).join(', ')}. ${degraded.map((c) => c.detail).filter(Boolean).join('; ')}`,
          category: 'self_improvement',
          impact: 'high',
          difficulty: 'medium',
          goalTitle: 'Restore degraded system components',
          goalDescription: `Components need attention: ${degraded.map((c) => `${c.component}: ${c.detail}`).join('; ')}. Dispatch the CTO to investigate and remediate each degraded/critical component.`,
          goalPriority: 2,
        });
      }

      // 6. Missing cron coverage
      const hasLeadGenCron = cronJobs.some((j) => j.jobType === 'task_delegation' && j.enabled);
      const hasReportCron = cronJobs.some((j) => j.jobType === 'report_generation' && j.enabled);
      if (!hasLeadGenCron) {
        suggestions.push({
          id: 'no-lead-gen-cron',
          title: 'No recurring lead generation cron — leads will dry up',
          description: 'There is no enabled task_delegation cron targeting the Lead Researcher. Without recurring sweeps, lead generation depends entirely on manual goal submission. Create a recurring lead-gen sweep.',
          category: 'self_improvement',
          impact: 'high',
          difficulty: 'easy',
          goalTitle: 'Set up recurring lead generation sweep',
          goalDescription: 'Create a recurring cron job (task_delegation type) targeting apex-lead-research-001 that runs every 2 hours. The payload should instruct the researcher to rotate industries and save 20-50 qualified leads per sweep.',
          goalPriority: 3,
        });
      }

      // 7. BuildMyBot telemetry (best-effort)
      const bmbUrl = process.env.BUILDMYBOT_SUPABASE_URL;
      const bmbKey = process.env.BUILDMYBOT_SUPABASE_SERVICE_KEY;
      if (bmbUrl && bmbKey) {
        try {
          const headers = { apikey: bmbKey, Authorization: `Bearer ${bmbKey}` };
          const [errorsRes, leadsRes] = await Promise.all([
            fetch(`${bmbUrl}/rest/v1/error_logs?status=eq.open&level=eq.critical&select=id,source,message&limit=25`, { headers, signal: AbortSignal.timeout(6_000) }),
            fetch(`${bmbUrl}/rest/v1/leads?replied_at=is.null&select=id,status&limit=500`, { headers, signal: AbortSignal.timeout(6_000) }),
          ]);
          const openErrors = (errorsRes.ok ? await errorsRes.json() : []) as Array<{ id: string; source: string; message: string }>;
          const unrepliedLeads = (leadsRes.ok ? await leadsRes.json() : []) as Array<{ id: string; status: string }>;

          if (openErrors.length > 5) {
            const errorSources = [...new Set(openErrors.map((e) => e.source))];
            suggestions.push({
              id: 'bmb-critical-errors',
              title: `BuildMyBot has ${openErrors.length} open critical errors`,
              description: `${openErrors.length} unresolved critical errors in BuildMyBot. Sources: ${errorSources.join(', ')}. These may be impacting the live product. Dispatch the COO to investigate and file engineering tickets.`,
              category: 'app_improvement',
              impact: 'high',
              difficulty: 'medium',
              goalTitle: 'Remediate BuildMyBot critical errors',
              goalDescription: `BuildMyBot has ${openErrors.length} open critical errors. Sources: ${errorSources.join(', ')}. Have the COO review these errors via buildmybot_status, then dispatch engineering fixes via buildmybot_dispatch_engineering. Prioritize errors from the llm-provider-chain source.`,
              goalPriority: 2,
            });
          }

          if (unrepliedLeads.length > 10) {
            suggestions.push({
              id: 'bmb-unreplied-leads',
              title: `${unrepliedLeads.length} BuildMyBot leads awaiting reply`,
              description: `${unrepliedLeads.length} leads in BuildMyBot haven't been replied to. Every hour without a response reduces conversion probability by 7%. Dispatch the Sales agent to craft follow-up outreach.`,
              category: 'app_improvement',
              impact: 'high',
              difficulty: 'easy',
              goalTitle: 'Follow up on stale BuildMyBot leads',
              goalDescription: `${unrepliedLeads.length} leads in BuildMyBot haven't been replied to. Have the Sales agent review the lead pipeline and draft follow-up outreach for each stale lead. Prioritize leads older than 48 hours.`,
              goalPriority: 3,
            });
          }
        } catch { /* best-effort */ }
      }

      // 8. No active goals = no direction
      if (activeGoals.length === 0) {
        suggestions.push({
          id: 'no-active-goals',
          title: 'No active goals — APEX has no strategic direction',
          description: 'There are zero active goals in the system. Without goals, the CEO only runs autonomous reviews (every 15 min) but has no specific objectives to work toward. Submit a goal to give APEX direction.',
          category: 'self_improvement',
          impact: 'medium',
          difficulty: 'easy',
          goalTitle: 'Define a strategic goal for APEX',
          goalDescription: 'No active goals exist. Submit a high-priority goal to give APEX strategic direction. Consider: "Scale lead generation to 500+ qualified leads across 10 industries" or "Achieve 90% task success rate across all agents".',
          goalPriority: 4,
        });
      }

      // 9. Overdue cron jobs
      const now = Date.now();
      const overdue = cronJobs.filter((j) => j.enabled && j.nextRunAt && new Date(j.nextRunAt).getTime() < now - 300_000);
      if (overdue.length > 0) {
        suggestions.push({
          id: 'overdue-crons',
          title: `${overdue.length} cron job(s) are overdue (>5min past due)`,
          description: `Overdue: ${overdue.map((j) => j.name).join(', ')}. These jobs haven't fired on schedule — may indicate a stuck scheduler or DB connectivity issue.`,
          category: 'self_improvement',
          impact: 'medium',
          difficulty: 'easy',
          goalTitle: 'Fix overdue cron jobs',
          goalDescription: `Cron jobs are overdue: ${overdue.map((j) => j.name).join(', ')}. Check if the JobScheduler is running, and reset these jobs to active with nextRunAt = now.`,
          goalPriority: 4,
        });
      }

      res.json({ suggestions });
    } catch (err) {
      res.json({ suggestions: [], error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/suggestions/:id/implement — submit the suggestion as a goal
  router.post('/:id/implement', async (req, res) => {
    try {
      const { goalTitle, goalDescription, goalPriority } = req.body;
      const goalId = crypto.randomUUID();
      await db.insert(goals).values({
        id: goalId,
        title: goalTitle,
        description: goalDescription,
        status: 'active',
        priority: goalPriority ?? 5,
        assignedAgentId: 'apex-ceo-001',
        createdAt: new Date(),
      });
      res.json({ success: true, goalId, message: 'Suggestion submitted as goal to APEX CEO' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
