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
  getConfiguredProviders?: () => Array<{ name: string; configured: boolean }>;
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
      const configuredCount = providers.filter((p) => p.configured).length;
      return {
        status: configuredCount === 0 ? 'critical' : configuredCount < providers.length ? 'degraded' : 'healthy',
        detail: providers.map((p) => `${p.name}:${p.configured ? 'ok' : 'missing'}`).join(', '),
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
        // Honest degraded state rather than a fabricated 'healthy' -- this
        // check literally cannot answer for itself unless the api-server
        // process wires in a checker (see WebSocketLivenessChecker above).
        return {
          status: 'degraded',
          detail: 'no WebSocket checker injected (only wireable from the api-server process)',
        };
      }
      const { serverRunning, connectedClients } = this.deps.wsChecker();
      return {
        status: serverRunning ? 'healthy' : 'critical',
        detail: serverRunning ? `running, ${connectedClients} client(s) connected` : 'WebSocket server not running',
      };
    });
  }

  /** Run every check and roll them up into one report. */
  async runAll(): Promise<HealthReport> {
    const [database, llmProviders, memorySystem, toolRegistry, webSocket, taskBacklog] = await Promise.all([
      this.checkDatabase(),
      this.checkLLMProviders(),
      this.checkMemorySystem(),
      this.checkToolRegistry(),
      this.checkWebSocket(),
      this.checkTaskBacklog(),
    ]);

    const checks = { database, llmProviders, memorySystem, toolRegistry, webSocket, taskBacklog };
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

