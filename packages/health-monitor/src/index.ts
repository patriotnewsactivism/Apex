// ─── HealthMonitor ─────────────────────────────────────────────────────────────
//
// Phase 1 of the standing observability roadmap (see ROADMAP.md / CHECKLIST.md
// in the repo root). Extracted out of the inline `health_check` tool
// (packages/core/src/tool-registry.ts, commit 546ae3d) into its own reusable
// class so the tool, a future scheduled HealthCheckJob, and a future
// AlertManager can all call the same checks without duplicating logic.
//
// Design constraints carried over from the tool version:
// - Every check is read-only, no side effects.
// - No live LLM API calls (slow, costs real requests every check) -- LLM
//   provider health is reported as "which providers have keys configured",
//   not "which providers actually respond right now".
// - Each check must be fast (<5s) and must never throw -- a failing check
//   reports 'critical' with the real error message, it doesn't crash the caller.

// Deliberately NO import from @workspace/core here -- core depends on this
// package (for the health_check tool), so importing back would create a
// cyclic workspace dependency (pnpm flags this explicitly). Instead, the
// caller injects whatever core-owned data this class needs to check.

export type ComponentStatus = 'healthy' | 'degraded' | 'critical';

export interface ComponentCheckResult {
  status: ComponentStatus;
  detail: string;
  ms?: number;
}

export interface HealthReport {
  overall: ComponentStatus;
  checks: Record<string, ComponentCheckResult>;
  timestamp: string;
}

/** Injected so this package never has to import @workspace/api-server (which
 * would be a backwards dependency -- api-server depends on things, things
 * don't depend on api-server). The api-server process passes its own
 * `getConnectedClientCount` in when it wires HealthMonitor up. */
export type WebSocketLivenessChecker = () => { serverRunning: boolean; connectedClients: number };

/** Same reasoning as WebSocketLivenessChecker: injected instead of imported
 * to avoid a cyclic workspace dependency with @workspace/core (core owns the
 * real llm-client.ts provider list and tool-registry.ts registry). */
export interface HealthMonitorDeps {
  getConfiguredProviders?: () => Array<{ name: string; configured: boolean; enabled?: boolean }>;
  // Reports whether the LLM chain has recently served tool-bearing requests
  // from a provider that cannot reliably emit structured tool calls. Injected
  // (rather than imported) to keep this package free of a @workspace/core
  // dependency — core already depends on health-monitor.
  getDegradedToolCalling?: () => { degraded: boolean; count: number; providers: string[]; since: string | null };
  getRegisteredToolCount?: () => number;
  wsChecker?: WebSocketLivenessChecker;
}

async function safeCheck(fn: () => Promise<ComponentCheckResult>): Promise<ComponentCheckResult> {
  const start = Date.now();
  try {
    return await fn();
  } catch (err) {
    return {
      status: 'critical',
      detail: err instanceof Error ? err.message : String(err),
      ms: Date.now() - start,
    };
  }
}

export class HealthMonitor {
  constructor(private deps: HealthMonitorDeps = {}) {}

  async checkDatabase(): Promise<ComponentCheckResult> {
    return safeCheck(async () => {
      const start = Date.now();
      const { db, agents } = await import('@workspace/db');
      await db.select().from(agents).limit(1);
      return { status: 'healthy', detail: 'query succeeded', ms: Date.now() - start };
    });
  }

  async checkLLMProviders(): Promise<ComponentCheckResult> {
    return safeCheck(async () => {
      if (!this.deps.getConfiguredProviders) {
        return { status: 'degraded', detail: 'no provider source injected (caller must pass getConfiguredProviders)' };
      }
      const providers = this.deps.getConfiguredProviders();
      const enabledProviders = providers.filter((p) => p.enabled !== false);
      const configuredCount = enabledProviders.filter((p) => p.configured).length;
      const detail = providers
        .map((p) =>
          p.enabled === false
            ? `${p.name}:disabled`
            : `${p.name}:${p.configured ? 'ok' : 'missing'}`,
        )
        .join(', ');

      // Key-presence alone says nothing about whether the workforce can
      // actually WORK. On 2026-07-29 every key was present and healthy-looking
      // while cerebras/groq were exhausted and 11 of 13 agents had fallen
      // through to cohere/command-r-plus, which does not reliably call tools —
      // so agents answered in prose instead of acting and the business quietly
      // stopped producing. That must not read as 'healthy' again.
      const degraded = this.deps.getDegradedToolCalling?.();
      if (degraded?.degraded) {
        return {
          status: 'degraded',
          detail:
            `TOOL CALLING DEGRADED — ${degraded.count} tool-bearing request(s) served by ` +
            `${degraded.providers.join(', ')} since ${degraded.since}, which cannot reliably emit ` +
            `structured tool calls. Agents will answer in prose instead of acting (empty search ` +
            `results, "I am unable to…", no leads saved). Restore capacity on an earlier provider ` +
            `in the chain. Keys: ${detail}`,
        };
      }

      return {
        status:
          configuredCount === 0
            ? 'critical'
            : configuredCount < enabledProviders.length
              ? 'degraded'
              : 'healthy',
        detail,
      };
    });
  }

  async checkMemorySystem(): Promise<ComponentCheckResult> {
    return safeCheck(async () => {
      const start = Date.now();
      // Read-only reachability check against the memories table. Deliberately
      // NOT calling MemoryManager.remember()/recall() here -- recall() goes
      // through createEmbedding(), which is a real (paid/rate-limited) API
      // call. A reachability ping is the fast, honest, zero-cost proxy;
      // actual embedding/vector-search health is a separate, heavier check
      // that a future scheduled job (not this fast path) should own.
      const { db, memories } = await import('@workspace/db');
      await db.select().from(memories).limit(1);
      return { status: 'healthy', detail: 'memories table reachable', ms: Date.now() - start };
    });
  }

  async checkToolRegistry(): Promise<ComponentCheckResult> {
    return safeCheck(async () => {
      if (!this.deps.getRegisteredToolCount) {
        return { status: 'degraded', detail: 'no registry source injected (caller must pass getRegisteredToolCount)' };
      }
      const toolCount = this.deps.getRegisteredToolCount();
      return {
        status: toolCount > 0 ? 'healthy' : 'critical',
        detail: `${toolCount} tools registered`,
      };
    });
  }

  async checkTaskBacklog(): Promise<ComponentCheckResult> {
    return safeCheck(async () => {
      // Threshold matches the AlertManager rule already specced in
      // ROADMAP.md (backlog > 50 = degraded) so this check won't need to
      // change when a real AlertManager is built on top of it.
      const { db, tasks } = await import('@workspace/db');
      const { sql, inArray } = await import('drizzle-orm');
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(inArray(tasks.status, ['pending', 'in_progress']));
      return {
        status: count > 50 ? 'degraded' : 'healthy',
        detail: `${count} pending/in_progress tasks`,
      };
    });
  }

  async checkWebSocket(): Promise<ComponentCheckResult> {
    return safeCheck(async () => {
      if (!this.deps.wsChecker) {
        // A worker-only runtime does not own the browser WebSocket server, so
        // absence of this API-process dependency is "not applicable", not a
        // degradation. The HTTP control plane injects a real checker and will
        // still report critical if its WebSocket server is actually down.
        return {
          status: 'healthy',
          detail: 'not applicable in this runtime (WebSocket liveness is checked by the API control plane)',
        };
      }
      const { serverRunning, connectedClients } = this.deps.wsChecker();
      return {
        status: serverRunning ? 'healthy' : 'critical',
        detail: serverRunning ? `running, ${connectedClients} client(s) connected` : 'WebSocket server not running',
      };
    });
  }

  /** BuildMyBot2 portfolio health.
   *
   * BuildMyBot is Neon/Postgres-backed. APEX must not depend on BuildMyBot's
   * database credentials or backend vendor to decide whether the product is
   * alive; the product owns that concern. Probe its public health contract
   * instead. This keeps APEX decoupled from database migrations and prevents
   * retired backend configuration from generating false degradation.
   */
  async checkBuildMyBotAITeam(): Promise<ComponentCheckResult> {
    return safeCheck(async () => {
      const start = Date.now();
      const appUrl = (process.env.BUILDMYBOT_APP_URL ?? 'https://www.buildmybot.app').replace(/\/$/, '');
      const response = await fetch(`${appUrl}/api/health`, {
        signal: AbortSignal.timeout(4_500),
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        return {
          status: 'critical',
          detail: `BuildMyBot health endpoint returned HTTP ${response.status}`,
          ms: Date.now() - start,
        };
      }

      let payload: {
        status?: string;
        service?: string;
        build?: { sha?: string | null };
        voice?: { engine?: string | null };
      } = {};
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        return {
          status: 'degraded',
          detail: 'BuildMyBot health endpoint returned non-JSON content',
          ms: Date.now() - start,
        };
      }

      const healthy = payload.status === 'ok' && payload.service === 'buildmybot2';
      const build = payload.build?.sha ? ` build=${payload.build.sha}` : '';
      const voice = payload.voice?.engine ? ` voice=${payload.voice.engine}` : '';
      return {
        status: healthy ? 'healthy' : 'degraded',
        detail: healthy
          ? `BuildMyBot API healthy (Neon-backed).${build}${voice}`
          : `BuildMyBot health payload unexpected: status=${payload.status ?? 'unknown'} service=${payload.service ?? 'unknown'}`,
        ms: Date.now() - start,
      };
    });
  }

  /** ARIA dispatch volume — goals submitted to the swarm in the last 24h.
   * ARIA's control room submits work via POST /api/goals, so goal-creation
   * volume IS the dispatch volume. Informational: only ever 'healthy' or
   * (via safeCheck) 'critical' if the query itself fails. */
  async checkAriaDispatch(): Promise<ComponentCheckResult> {
    return safeCheck(async () => {
      const start = Date.now();
      const { db, goals, tasks } = await import('@workspace/db');
      const { sql, gte } = await import('drizzle-orm');
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [[goalRow], [taskRow]] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(goals).where(gte(goals.createdAt, yesterday)),
        db.select({ count: sql<number>`count(*)::int` }).from(tasks).where(gte(tasks.createdAt, yesterday)),
      ]);
      return {
        status: 'healthy',
        detail: `${goalRow.count} goal(s) dispatched, ${taskRow.count} task(s) created in last 24h`,
        ms: Date.now() - start,
      };
    });
  }

  /** Run every check and roll them up into one report. */
  async runAll(): Promise<HealthReport> {
    const [database, llmProviders, memorySystem, toolRegistry, webSocket, taskBacklog, buildMyBotAITeam, ariaDispatch] = await Promise.all([
      this.checkDatabase(),
      this.checkLLMProviders(),
      this.checkMemorySystem(),
      this.checkToolRegistry(),
      this.checkWebSocket(),
      this.checkTaskBacklog(),
      this.checkBuildMyBotAITeam(),
      this.checkAriaDispatch(),
    ]);

    const checks = { database, llmProviders, memorySystem, toolRegistry, webSocket, taskBacklog, buildMyBotAITeam, ariaDispatch };
    const statuses = Object.values(checks).map((c) => c.status);
    const overall: ComponentStatus = statuses.includes('critical')
      ? 'critical'
      : statuses.includes('degraded')
        ? 'degraded'
        : 'healthy';

    return { overall, checks, timestamp: new Date().toISOString() };
  }
}

// Re-export AlertManager
export { AlertManager } from './alert-manager.js';
export type { Alert, AlertSeverity, AlertRule } from './alert-manager.js';

