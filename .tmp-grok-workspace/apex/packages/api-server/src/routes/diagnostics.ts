import { Router } from 'express';
import { statfsSync } from 'fs';
import {
  getCapacityDeferralStats,
  getDequeueHealth,
  isTaskQueueBroken,
  getBuildInfo,
  getTokenLedgerSnapshot,
  getProviderBackpressureSnapshot,
  getConfiguredProviders,
} from '@workspace/core';
import type { BaseAgent } from '@workspace/core';

/**
 * One endpoint that answers "what is wrong with APEX right now".
 *
 * Every check here exists because diagnosing it once meant reading a wall of
 * log output by eye. A parked workforce and an idle one are byte-identical
 * from outside; a capacity spin looks like healthy activity unless you count
 * the deferrals; a container killed for memory reports nothing at all because
 * the memory was in tmpfs. Each of those cost real downtime before it was
 * understood, so each is a row here with the action that resolves it.
 *
 * `?format=text` returns the same findings as a paste-ready report.
 */

type Severity = 'critical' | 'warning' | 'ok';

interface Finding {
  severity: Severity;
  code: string;
  title: string;
  detail: string;
  action?: string;
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, ok: 2 };

export function createDiagnosticsRouter(workforce: Map<string, BaseAgent>) {
  const router = Router();

  router.get('/', (req, res) => {
    const now = Date.now();
    const findings: Finding[] = [];
    const build = getBuildInfo();
    const queue = getDequeueHealth();
    const deferrals = getCapacityDeferralStats(now);
    const ledger = getTokenLedgerSnapshot();
    const backpressure = getProviderBackpressureSnapshot();

    const statuses = [...workforce.values()].reduce<Record<string, number>>((acc, agent) => {
      const s = agent.getStatus();
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});
    const errored = statuses.error ?? 0;

    // ── Task queue ─────────────────────────────────────────────────────────
    if (isTaskQueueBroken()) {
      findings.push({
        severity: 'critical',
        code: 'queue_broken',
        title: 'Task queue is failing to dequeue',
        detail: `${queue.consecutiveFailures} consecutive failures. Last: ${queue.lastFailureMessage ?? 'unknown'}`,
        action: 'Check DATABASE_URL and the Postgres connection pool. ECHECKOUTTIMEOUT means pool exhaustion.',
      });
    } else {
      findings.push({
        severity: 'ok',
        code: 'queue_ok',
        title: 'Task queue is dequeuing',
        detail: `${queue.successes}/${queue.attempts} attempts succeeded, ${queue.failures} failures.`,
      });
    }

    // ── Capacity spin ──────────────────────────────────────────────────────
    // A claim that ends in a deferral still paid for a task claim, a history
    // rebuild and a learning-context assembly. Sustained deferrals mean the
    // workforce is doing that work to learn nothing.
    if (deferrals.lastMinute >= 20) {
      findings.push({
        severity: 'critical',
        code: 'capacity_spin',
        title: 'Workforce is spinning on LLM capacity',
        detail: `${deferrals.lastMinute} capacity deferrals in the last minute (${deferrals.last15Minutes} in 15m). Each one claimed a task and rebuilt its context before being refused.`,
        action: 'A pacing window is reporting a resume-at that has already elapsed, so the pause is zero-length. Check CAPACITY_PAUSE_FLOOR_MS in base-agent.ts.',
      });
    } else if (deferrals.lastMinute > 0) {
      findings.push({
        severity: 'warning',
        code: 'capacity_deferrals',
        title: 'Some tasks are being deferred for capacity',
        detail: `${deferrals.lastMinute} in the last minute, ${deferrals.last15Minutes} in 15m. Normal during a pacing window.`,
      });
    }

    // ── Parked workforce ───────────────────────────────────────────────────
    if (deferrals.parkedForMs > 5 * 60_000) {
      findings.push({
        severity: 'critical',
        code: 'workforce_parked',
        title: 'Workforce is parked and not claiming work',
        detail: `Every agent is waiting ${Math.round(deferrals.parkedForMs / 60_000)} more minutes for LLM capacity. This is indistinguishable from idle in agentStatusCounts.`,
        action: 'Check llmCapacity.pausedProviders. A single paced provider must not gate the workspace — see llmCapacityAvailableNow().',
      });
    }

    // ── Agents in error ────────────────────────────────────────────────────
    if (errored > 0) {
      findings.push({
        severity: errored >= workforce.size / 2 ? 'critical' : 'warning',
        code: 'agents_errored',
        title: `${errored} of ${workforce.size} agents in error`,
        detail: `Status counts: ${JSON.stringify(statuses)}`,
        action: 'Read the feed for the failing agent id. A provider-chain failure across all agents is a credential or model-policy problem, not an agent problem.',
      });
    }

    // ── Providers ──────────────────────────────────────────────────────────
    const configured = getConfiguredProviders();
    if (configured.length === 0) {
      findings.push({
        severity: 'critical',
        code: 'no_providers',
        title: 'No LLM provider credentials configured',
        detail: 'The workforce cannot do any work.',
        action: 'Set OPENROUTER_API_KEY (and ideally OPENROUTER_API_KEY_2) in the Cloud Run service.',
      });
    }
    if (backpressure.pausedProviders.length > 0) {
      findings.push({
        severity: 'warning',
        code: 'providers_paused',
        title: `${backpressure.pausedProviders.length} provider(s) paused`,
        detail: backpressure.pausedProviders.join(', ') + (backpressure.nextResumeAt ? ` — next resume ${backpressure.nextResumeAt}` : ''),
      });
    }
    if (ledger.totalCapReached) {
      findings.push({
        severity: 'warning',
        code: 'daily_cap',
        title: 'Daily token cap reached',
        detail: 'Work resumes at the UTC rollover.',
        action: 'POST /api/tokens/reset clears the ledger if the spend was wasted on a broken provider.',
      });
    }

    // ── Memory, including the part process.memoryUsage() cannot see ────────
    const usage = process.memoryUsage();
    const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;
    let tmpUsedMb: number | null = null;
    try {
      const st = statfsSync('/tmp');
      tmpUsedMb = mb((st.blocks - st.bfree) * st.bsize);
    } catch { /* not fatal */ }

    if (tmpUsedMb !== null && tmpUsedMb > 300) {
      findings.push({
        severity: 'critical',
        code: 'tmpfs_growing',
        title: `/tmp holds ${tmpUsedMb}MB`,
        detail: 'On Cloud Run /tmp is RAM and counts against the container memory limit, while being invisible to process.memoryUsage().',
        action: 'Something is writing to /tmp — a CI workspace or a cache. This is what silently OOM-killed the container on 2026-09-04.',
      });
    }

    // ── Uptime ─────────────────────────────────────────────────────────────
    if (build.uptimeSeconds < 300) {
      findings.push({
        severity: 'warning',
        code: 'recently_restarted',
        title: `Container started ${build.uptimeSeconds}s ago`,
        detail: `sha ${build.sha?.slice(0, 8) ?? 'unknown'}, built ${build.builtAt ?? 'unknown'}.`,
        action: 'If the sha did not change, this was a restart, not a deploy. Repeated same-sha restarts mean an OOM kill — check tmpUsedMb above.',
      });
    }

    findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
    const worst = findings.find((f) => f.severity !== 'ok')?.severity ?? 'ok';

    const payload = {
      status: worst,
      generatedAt: new Date(now).toISOString(),
      build,
      agents: { total: workforce.size, statuses },
      taskQueue: queue,
      capacity: { deferrals, pausedProviders: backpressure.pausedProviders, configuredProviders: configured.length },
      memory: { rssMb: mb(usage.rss), heapUsedMb: mb(usage.heapUsed), tmpUsedMb },
      findings,
    };

    if (String(req.query.format) === 'text') {
      const icon: Record<Severity, string> = { critical: '[CRIT]', warning: '[WARN]', ok: '[ ok ]' };
      const lines = [
        `APEX diagnostics — ${payload.generatedAt}`,
        `sha ${build.sha?.slice(0, 8) ?? '?'}  up ${Math.floor(build.uptimeSeconds / 60)}m  agents ${workforce.size} ${JSON.stringify(statuses)}`,
        `queue ${queue.successes}/${queue.attempts} (${queue.failures} failures)  rss ${payload.memory.rssMb}MB  tmp ${tmpUsedMb ?? '?'}MB`,
        `capacity deferrals: ${deferrals.lastMinute}/min, ${deferrals.last15Minutes}/15m  parked ${Math.round(deferrals.parkedForMs / 1000)}s`,
        '',
        ...findings.flatMap((f) => [
          `${icon[f.severity]} ${f.title}`,
          `        ${f.detail}`,
          ...(f.action ? [`        → ${f.action}`] : []),
        ]),
      ];
      res.type('text/plain').send(lines.join('\n'));
      return;
    }

    res.json(payload);
  });

  return router;
}
