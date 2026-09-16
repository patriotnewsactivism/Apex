import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery, mutation } from './_generated/server';
import type { ActionCtx } from './_generated/server';
import { internal, api } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { getConfiguredProviders } from './llmConfig';
import { TOOL_DEFS } from './toolRegistry';

// ─── Health (M4) ─────────────────────────────────────────────────────────────
//
// Convex port of @workspace/health-monitor's HealthMonitor.runAll() (8 checks)
// and AlertManager (4 default rules + dedup/ack/summary).
//
// This is the REAL, authoritative, STATEFUL successor to the earlier
// stateless port inlined in toolRegistry.ts (buildHealthReport /
// evaluateAlertsStateless / summarizeAlerts, used by the health_check /
// get_system_status / get_active_alerts tools). That port was explicit about
// its own regression: a Convex action has no process-lifetime singleton, so
// it recomputed "what's firing" fresh on every call with zero memory of what
// already fired or got acknowledged. This file fixes that by moving the old
// AlertManager's in-memory `activeAlerts` Map / `firedRules` Set onto the
// `alerts` table (schema.ts) — dedup, auto-resolve, and acknowledge are now
// real DB reads/writes instead of instance fields on a class that Convex
// never keeps alive between calls.
//
// buildHealthReport/evaluateAlertsStateless/summarizeAlerts/safeCheck/
// checkBuildMyBotAITeam in toolRegistry.ts are module-private (no `export`),
// so they can't be imported here — the 8 checks and safeCheck wrapper below
// are re-implemented rather than reached-across-files-for, same call as that
// file made for the old @workspace/health-monitor package itself (see its
// header comment: injected deps instead of a cyclic import). TOOL_DEFS and
// getConfiguredProviders ARE exported already (agentLoop.ts already imports
// TOOL_DEFS the same way), so those two are imported, not duplicated.
//
// `runHealthCheck` is called by the M4 job-scheduler's HealthCheckJob handler
// via `ctx.runAction(internal.health.runHealthCheck, {})` — the export name
// and internalAction-with-no-required-args shape are load-bearing for that.

type ComponentStatus = 'healthy' | 'degraded' | 'critical';
type ComponentCheckResult = { status: ComponentStatus; detail: string; ms?: number };
type HealthReport = { overall: ComponentStatus; checks: Record<string, ComponentCheckResult>; timestamp: string };

const componentStatusValidator = v.union(v.literal('healthy'), v.literal('degraded'), v.literal('critical'));
const alertSeverityValidator = v.union(v.literal('warning'), v.literal('critical'));

const componentCheckValidator = v.object({
  status: componentStatusValidator,
  detail: v.string(),
  ms: v.optional(v.number()),
});
/** Record<string, ComponentCheckResult> — keys are the 8 fixed check names
 * (database, llmProviders, memorySystem, toolRegistry, webSocket,
 * taskBacklog, buildMyBotAITeam, ariaDispatch), but validated as a generic
 * string-keyed record rather than a closed literal union to keep this file
 * the single place that needs updating if a 9th check is ever added. */
const checksValidator = v.record(v.string(), componentCheckValidator);

// ─── 8 checks, ported from HealthMonitor (packages/health-monitor/src/index.ts) ──
// Same rules as the old class: read-only, no live LLM calls, each wrapped in
// safeCheck so a single failing check reports 'critical' with the real error
// instead of throwing and killing the whole runAll().

async function safeCheck(fn: () => Promise<{ status: ComponentStatus; detail: string }>): Promise<ComponentCheckResult> {
  const start = Date.now();
  try {
    const result = await fn();
    return { ...result, ms: Date.now() - start };
  } catch (err) {
    return { status: 'critical', detail: err instanceof Error ? err.message : String(err), ms: Date.now() - start };
  }
}

async function checkDatabase(ctx: ActionCtx): Promise<ComponentCheckResult> {
  return safeCheck(async () => {
    await ctx.runQuery(api.agents.list, {});
    return { status: 'healthy', detail: 'query succeeded' };
  });
}

async function checkLLMProviders(): Promise<ComponentCheckResult> {
  return safeCheck(async () => {
    const providers = getConfiguredProviders();
    const configuredCount = providers.filter((p) => p.configured).length;
    const status: ComponentStatus =
      configuredCount === 0 ? 'critical' : configuredCount < providers.length ? 'degraded' : 'healthy';
    return { status, detail: providers.map((p) => `${p.name}:${p.configured ? 'ok' : 'missing'}`).join(', ') };
  });
}

async function checkMemorySystem(ctx: ActionCtx): Promise<ComponentCheckResult> {
  return safeCheck(async () => {
    // Reachability ping only (mirrors the old class's comment: recall() goes
    // through createEmbedding(), a real paid/rate-limited call — not what a
    // fast health sweep should be doing).
    await ctx.runQuery(internal.toolRegistry.memories_listGlobal, { limit: 1 });
    return { status: 'healthy', detail: 'memories table reachable' };
  });
}

async function checkToolRegistry(): Promise<ComponentCheckResult> {
  return safeCheck(async () => {
    const toolCount = Object.keys(TOOL_DEFS).length;
    return { status: toolCount > 0 ? 'healthy' : 'critical', detail: `${toolCount} tools registered` };
  });
}

async function checkTaskBacklog(ctx: ActionCtx): Promise<ComponentCheckResult> {
  return safeCheck(async () => {
    // Threshold matches the task_backlog_high alert rule below (>50) — same
    // property the old code called out (ROADMAP.md-specced, shared constant
    // in spirit even though it's duplicated as a literal in both places).
    const all = await ctx.runQuery(api.tasks.list, {});
    // Explicit Doc<'tasks'> annotation: api.tasks.list has no `returns`
    // validator, so its FunctionReference's TS return type resolves to
    // `any[]` here (same pre-existing gap toolRegistry.ts's buildHealthReport
    // already has for this exact call — not introduced by this file).
    const count = all.filter((t: Doc<'tasks'>) => t.status === 'pending' || t.status === 'in_progress').length;
    return { status: count > 50 ? 'degraded' : 'healthy', detail: `${count} pending/in_progress tasks` };
  });
}

async function checkWebSocket(): Promise<ComponentCheckResult> {
  return safeCheck(async () => ({
    status: 'degraded',
    // Honest degraded state, not a fabricated 'healthy' — same convention as
    // the old class: this check literally cannot answer for itself from a
    // Convex action (no live WebSocket server to query in this runtime).
    detail: 'no WebSocket checker injected (only wireable from a live process, not a Convex action)',
  }));
}

/** Ported from HealthMonitor.checkBuildMyBotAITeam — pure HTTP via env-configured
 * Supabase REST, no DB dependency. Duplicated (not imported) from
 * toolRegistry.ts's private checkBuildMyBotAITeam for the same reason the old
 * health-monitor package duplicated it out of buildmybot-connector.ts: no
 * import across module-private boundaries. */
async function checkBuildMyBotAITeam(): Promise<ComponentCheckResult> {
  return safeCheck(async () => {
    const url = process.env.BUILDMYBOT_SUPABASE_URL;
    const key = process.env.BUILDMYBOT_SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      return { status: 'degraded', detail: 'BUILDMYBOT_SUPABASE_URL / BUILDMYBOT_SUPABASE_SERVICE_KEY not configured' };
    }
    // Guard a Railway misconfiguration: if the "URL" isn't a valid https://
    // URL it's usually a secret/JWT pasted into BUILDMYBOT_SUPABASE_URL (vars
    // swapped, or an encrypted value copied verbatim). Fail with a redacted
    // message instead of letting fetch throw "Failed to parse URL from eyJ…"
    // and echo the secret back out through this health response.
    let protocol = '';
    try {
      protocol = new URL(url).protocol;
    } catch {
      protocol = '';
    }
    if (protocol !== 'https:') {
      return {
        status: 'critical',
        detail:
          `BUILDMYBOT_SUPABASE_URL is not a valid https:// project URL ` +
          `(got "${url.slice(0, 30)}…"). It may hold a secret/JWT — check that ` +
          `BUILDMYBOT_SUPABASE_URL and BUILDMYBOT_SUPABASE_SERVICE_KEY are not ` +
          `swapped, and that the value is a plaintext URL (e.g. https://xyz.supabase.co).`,
      };
    }
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    const today = new Date().toISOString().slice(0, 10);
    const [shiftsRes, criticalsRes] = await Promise.all([
      fetch(`${url}/rest/v1/ai_team_log?shift_date=eq.${today}&select=role_name,flags,escalated_to&limit=100`, {
        headers,
        signal: AbortSignal.timeout(4_500),
      }),
      fetch(`${url}/rest/v1/error_logs?status=eq.open&level=eq.critical&select=source&limit=50`, {
        headers,
        signal: AbortSignal.timeout(4_500),
      }),
    ]);
    if (!shiftsRes.ok || !criticalsRes.ok) {
      return {
        status: 'critical',
        detail: `buildmybot2 Supabase unreachable (ai_team_log ${shiftsRes.status}, error_logs ${criticalsRes.status})`,
      };
    }
    const shifts = (await shiftsRes.json()) as Array<{ role_name: string; flags?: unknown; escalated_to?: unknown }>;
    const criticals = (await criticalsRes.json()) as Array<{ source: string }>;
    const flagged = shifts.filter((s) => s.flags || s.escalated_to).length;
    const chainExhaustions = criticals.filter((c) => c.source === 'llm-provider-chain').length;
    const status: ComponentStatus = criticals.length > 0 ? 'critical' : flagged > 0 ? 'degraded' : 'healthy';
    return {
      status,
      detail:
        `${shifts.length} AI Team shift(s) today, ${flagged} flagged/escalated, ` +
        `${criticals.length} open critical(s)` +
        (chainExhaustions ? ` (${chainExhaustions} provider-chain exhaustion!)` : ''),
    };
  });
}

async function checkAriaDispatch(ctx: ActionCtx): Promise<ComponentCheckResult> {
  return safeCheck(async () => {
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    const [allGoals, allTasks] = await Promise.all([
      ctx.runQuery(api.goals.list, {}),
      ctx.runQuery(api.tasks.list, {}),
    ]);
    // Same pre-existing any-return gap as checkTaskBacklog above (api.goals.list
    // / api.tasks.list have no `returns` validator) — annotated explicitly
    // rather than left as an implicit any.
    const goalCount = allGoals.filter((g: Doc<'goals'>) => g._creationTime >= yesterday).length;
    const taskCount = allTasks.filter((t: Doc<'tasks'>) => t._creationTime >= yesterday).length;
    return {
      status: 'healthy',
      detail: `${goalCount} goal(s) dispatched, ${taskCount} task(s) created in last 24h`,
    };
  });
}

/** Ported from HealthMonitor.runAll() — same 8 checks, same rollup rule, same
 * key order (load-bearing: the component_critical alert rule below fires on
 * the FIRST critical entry in iteration order, matching the old
 * AlertManager's `for (const [component, check] of Object.entries(...))
 * return`-on-first-match behavior). */
async function runAllChecks(ctx: ActionCtx): Promise<HealthReport> {
  const [database, llmProviders, memorySystem, toolRegistry, webSocket, taskBacklog, buildMyBotAITeam, ariaDispatch] =
    await Promise.all([
      checkDatabase(ctx),
      checkLLMProviders(),
      checkMemorySystem(ctx),
      checkToolRegistry(),
      checkWebSocket(),
      checkTaskBacklog(ctx),
      checkBuildMyBotAITeam(),
      checkAriaDispatch(ctx),
    ]);

  const checks: Record<string, ComponentCheckResult> = {
    database, llmProviders, memorySystem, toolRegistry, webSocket, taskBacklog, buildMyBotAITeam, ariaDispatch,
  };
  const statuses = Object.values(checks).map((c) => c.status);
  const overall: ComponentStatus = statuses.includes('critical')
    ? 'critical'
    : statuses.includes('degraded')
      ? 'degraded'
      : 'healthy';

  return { overall, checks, timestamp: new Date().toISOString() };
}

// ─── runHealthCheck: the entry point the M4 HealthCheckJob handler calls ────

export const runHealthCheck = internalAction({
  args: {},
  returns: v.object({
    overall: componentStatusValidator,
    componentCount: v.number(),
    newAlerts: v.number(),
    timestamp: v.string(),
  }),
  // Explicit return-type annotation is load-bearing, not decorative: this
  // handler calls internal.health.recordHealthSnapshot/evaluateAlerts, both
  // defined later in *this same file*. Convex's generated api.d.ts types
  // `internal.health.X` as `typeof health.X`, so resolving those calls
  // requires the whole `health` module's export types — including
  // runHealthCheck's own inferred type — a circular reference TS can't
  // unwind without an explicit annotation here to break the cycle.
  handler: async (
    ctx,
  ): Promise<{ overall: ComponentStatus; componentCount: number; newAlerts: number; timestamp: string }> => {
    const report = await runAllChecks(ctx);
    await ctx.runMutation(internal.health.recordHealthSnapshot, { checks: report.checks });
    const alertResult: { newAlertCount: number; resolvedRuleCount: number } = await ctx.runMutation(
      internal.health.evaluateAlerts,
      { checks: report.checks },
    );
    return {
      overall: report.overall,
      componentCount: Object.keys(report.checks).length,
      newAlerts: alertResult.newAlertCount,
      timestamp: report.timestamp,
    };
  },
});

// ─── recordHealthSnapshot: upsert componentHealth + append healthMetrics ────
//
// One transactional mutation for all 8 components rather than 16 separate
// ctx.runMutation round-trips from the action — same reasoning as every other
// batched-write mutation in this codebase (e.g. taskRuns.upsert).

export const recordHealthSnapshot = internalMutation({
  args: { checks: checksValidator },
  returns: v.null(),
  handler: async (ctx, { checks }) => {
    const now = Date.now();
    for (const [component, check] of Object.entries(checks)) {
      const existing = await ctx.db
        .query('componentHealth')
        .withIndex('by_component', (q) => q.eq('component', component))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          status: check.status,
          detail: check.detail,
          lastCheckTime: now,
          consecutiveFailures: check.status === 'healthy' ? 0 : existing.consecutiveFailures + 1,
        });
      } else {
        await ctx.db.insert('componentHealth', {
          component,
          status: check.status,
          detail: check.detail,
          lastCheckTime: now,
          consecutiveFailures: check.status === 'healthy' ? 0 : 1,
        });
      }
      await ctx.db.insert('healthMetrics', {
        component,
        status: check.status,
        responseTimeMs: check.ms,
        detail: check.detail,
        errorMessage: check.status === 'critical' ? check.detail : undefined,
        checkedAt: now,
      });
    }
    return null;
  },
});

// ─── evaluateAlerts: AlertManager.evaluate(), ported onto the `alerts` table ─
//
// The old AlertManager kept two in-memory structures across repeated polls
// from one long-lived process instance:
//   - firedRules: Set<ruleName>        — "is this rule currently active"
//   - activeAlerts: Map<alertId, Alert> — the alerts themselves
// A Convex mutation has no equivalent process lifetime, so both collapse onto
// the `alerts` table: "is this rule currently active" becomes "does an
// un-acknowledged row with this `rule` value exist", and the Map becomes the
// table itself. This preserves the old semantics exactly:
//   - A rule that's already firing does NOT get a new row on every re-eval
//     (dedup) — the message/firedAt of the original alert stays frozen until
//     it clears, exactly like the old code never updating an existing Map
//     entry.
//   - A rule that stops firing deletes its un-acknowledged row(s)
//     (auto-resolve) but leaves acknowledged ones alone — mirrors
//     `if (!alert.acknowledgedAt) this.activeAlerts.delete(id)` verbatim.
//   - component_critical still only ever produces ONE alert per evaluation
//     cycle (the first critical component found, in fixed check order), not
//     one per critical component — same as the old rule.evaluate()'s
//     `for...return` early exit.

export const evaluateAlerts = internalMutation({
  args: { checks: checksValidator },
  returns: v.object({ newAlertCount: v.number(), resolvedRuleCount: v.number() }),
  handler: async (ctx, { checks }) => {
    type FiredAlert = { rule: string; severity: 'warning' | 'critical'; message: string; component: string };

    // Rule 1: component_critical — any component critical, first one wins.
    let componentCritical: FiredAlert | null = null;
    for (const [component, check] of Object.entries(checks)) {
      if (check.status === 'critical') {
        componentCritical = {
          rule: 'component_critical',
          severity: 'critical',
          message: `Component '${component}' is critical: ${check.detail}`,
          component,
        };
        break;
      }
    }

    // Rule 2: task_backlog_high — backlog > 50 (parsed from the check detail
    // string, same "^(\d+)" regex the old rule used).
    let taskBacklogHigh: FiredAlert | null = null;
    const backlog = checks.taskBacklog;
    if (backlog) {
      const match = backlog.detail.match(/^(\d+)/);
      const count = match ? parseInt(match[1], 10) : 0;
      if (count > 50) {
        taskBacklogHigh = {
          rule: 'task_backlog_high',
          severity: 'warning',
          message: `Task backlog is ${count} (threshold: 50)`,
          component: 'taskBacklog',
        };
      }
    }

    // Rule 3: approval_backlog_high — pending approvals > 10.
    //
    // JUDGMENT CALL: the old AlertManager.evaluate() only read
    // `report.checks.approvalBacklog`, a field HealthMonitor.runAll() never
    // populated — so this rule was permanently dormant in the old system
    // (confirmed in toolRegistry.ts's evaluateAlertsStateless comment: "never
    // actually fired... a faithful (still-unwired) no-op"). The old pure
    // evaluate(report) function had no DB access to fix that itself. This
    // mutation does (ctx.db), so it queries the live pending-approval count
    // directly instead of perpetuating a dead field lookup. This makes the
    // rule live for the first time — a deliberate upgrade over a literal
    // port, not a behavior change anyone would notice as a regression.
    // Capped at 500 reads (well under the ~16k document-read ceiling) since
    // only ">10" matters for firing; if the cap is hit the message says
    // "500+" rather than claiming a precise count it didn't read.
    let approvalBacklogHigh: FiredAlert | null = null;
    const pendingApprovals = await ctx.db
      .query('approvals')
      .withIndex('by_status', (q) => q.eq('status', 'pending'))
      .take(500);
    if (pendingApprovals.length > 10) {
      approvalBacklogHigh = {
        rule: 'approval_backlog_high',
        severity: 'warning',
        message: `Approval backlog is ${pendingApprovals.length}${pendingApprovals.length === 500 ? '+' : ''} (threshold: 10)`,
        component: 'approvalBacklog',
      };
    }

    // Rule 4: system_degraded — 3+ components degraded.
    let systemDegraded: FiredAlert | null = null;
    const degradedCount = Object.values(checks).filter((c) => c.status === 'degraded').length;
    if (degradedCount >= 3) {
      systemDegraded = {
        rule: 'system_degraded',
        severity: 'warning',
        message: `${degradedCount} components are degraded`,
        component: 'system',
      };
    }

    const firing: Record<string, FiredAlert | null> = {
      component_critical: componentCritical,
      task_backlog_high: taskBacklogHigh,
      approval_backlog_high: approvalBacklogHigh,
      system_degraded: systemDegraded,
    };

    const now = Date.now();
    let newAlertCount = 0;
    let resolvedRuleCount = 0;

    for (const ruleName of Object.keys(firing)) {
      const alert = firing[ruleName];

      // At most one row per rule should ever be un-acknowledged at a time
      // (this loop enforces that invariant on every insert below), so the
      // active row — if any — is always among the most recent rows for that
      // rule. Reading only the most recent 20 keeps this bounded regardless
      // of how much acknowledged history has piled up for the rule over the
      // deployment's lifetime, instead of an unbounded `.collect()`.
      const recentForRule = await ctx.db
        .query('alerts')
        .withIndex('by_rule', (q) => q.eq('rule', ruleName))
        .order('desc')
        .take(20);
      const activeRows = recentForRule.filter((a) => a.acknowledgedAt === undefined);

      if (alert) {
        if (activeRows.length === 0) {
          await ctx.db.insert('alerts', {
            rule: alert.rule,
            severity: alert.severity,
            message: alert.message,
            component: alert.component,
            firedAt: now,
          });
          newAlertCount++;
        }
        // else: already firing and un-acknowledged — dedup, no-op. Message
        // stays frozen from the first fire, exactly like the old Map never
        // overwriting an existing entry.
      } else if (activeRows.length > 0) {
        // Rule stopped firing — auto-resolve every un-acknowledged row for
        // it; acknowledged history is left untouched.
        for (const row of activeRows) {
          await ctx.db.delete(row._id);
        }
        resolvedRuleCount++;
      }
    }

    return { newAlertCount, resolvedRuleCount };
  },
});

// ─── getActiveAlerts — matches old AlertManager.getActiveAlerts() ──────────

export const getActiveAlerts = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id('alerts'),
      _creationTime: v.number(),
      rule: v.string(),
      severity: alertSeverityValidator,
      message: v.string(),
      component: v.string(),
      firedAt: v.number(),
      acknowledgedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    // Bounded intrinsically: evaluateAlerts enforces at most one
    // un-acknowledged row per rule, and there are only 4 rules — this can
    // never return more than 4 rows regardless of table size.
    return await ctx.db
      .query('alerts')
      .withIndex('by_acknowledged', (q) => q.eq('acknowledgedAt', undefined))
      .collect();
  },
});

// ─── acknowledgeAlert — matches old AlertManager.acknowledge(alertId) ──────
//
// Public mutation, mirroring approvals.resolve's exposure in this codebase
// (a human/dashboard triggers it directly; this backend has no per-user auth
// foundation wired up yet, so — consistent with approvals.resolve — no
// ctx.auth check is added here either).

export const acknowledgeAlert = mutation({
  args: { alertId: v.id('alerts') },
  returns: v.boolean(),
  handler: async (ctx, { alertId }) => {
    const alert = await ctx.db.get(alertId);
    if (!alert || alert.acknowledgedAt !== undefined) return false;
    await ctx.db.patch(alertId, { acknowledgedAt: Date.now() });
    return true;
  },
});

// ─── getAlertSummary — matches old AlertManager.getSummary() ──────────────

/** Well under the ~16k document-read ceiling — bounds the acknowledged-count
 * scan below. If the alerts table grows large enough in production for this
 * to matter, swap this for a running counter or @convex-dev/aggregate rather
 * than raising the cap. */
const ACKNOWLEDGED_SCAN_CAP = 2000;

export const getAlertSummary = internalQuery({
  args: {},
  returns: v.object({
    total: v.number(),
    critical: v.number(),
    warning: v.number(),
    acknowledged: v.number(),
  }),
  handler: async (ctx) => {
    // Active (un-acknowledged) alerts are intrinsically bounded to at most 4
    // rows (see getActiveAlerts) — safe to collect in full.
    const active = await ctx.db
      .query('alerts')
      .withIndex('by_acknowledged', (q) => q.eq('acknowledgedAt', undefined))
      .collect();
    let critical = 0;
    let warning = 0;
    for (const a of active) {
      if (a.severity === 'critical') critical++;
      else warning++;
    }

    // Acknowledged rows are never deleted (they're kept as history), so this
    // is the one part of the table that can grow unbounded over the
    // deployment's lifetime — read most-recent-first and cap it rather than
    // an unbounded `.collect()` over the whole table.
    const recent = await ctx.db.query('alerts').order('desc').take(ACKNOWLEDGED_SCAN_CAP);
    const acknowledged = recent.filter((a) => a.acknowledgedAt !== undefined).length;

    return { total: active.length + acknowledged, critical, warning, acknowledged };
  },
});
