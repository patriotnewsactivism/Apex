import {
  recordAgentLoopAbandoned,
  recordAgentLoopCrash,
  recordAgentLoopRestart,
} from './runtime-health.js';

// ─── Agent loop supervision ──────────────────────────────────────────────────
//
// Both entrypoints used to start agents fire-and-forget:
//
//   api-server/src/index.ts : agent.start().catch((err) => console.error(...))
//   api-server/src/worker.ts: agent.start().catch((err) => { log; throw err; })
//
// The polling loop body catches its own errors, but the pre-loop setup
// (`logger.info`, `setStatus` — both DB-backed) can reject on a boot-time
// database blip. When it did, that agent never polled again, nothing restarted
// it, and `/health` still reported `agents: 13` because that number is the size
// of the constructed workforce map, not a liveness measurement. The workforce
// silently shrinks and the service still answers `status: ok`.
//
// This supervisor restarts a crashed loop with bounded, jittered exponential
// backoff. Bounded on purpose: an agent that crashes instantly and forever must
// not become an infinite restart loop burning DB/LLM capacity. After
// `maxRestarts` the supervisor stops and records the agent as abandoned, which
// `/health.workforce.abandoned` surfaces for an operator.

export interface SupervisableAgent {
  id: string;
  start(): Promise<void>;
  stop(): void;
}

export interface AgentSupervisorOptions {
  /** Restart attempts after the first start. Default 5. */
  maxRestarts?: number;
  /** First backoff step; doubles per attempt. Default 5s. */
  baseDelayMs?: number;
  /** Ceiling for the backoff ladder. Default 5 min. */
  maxDelayMs?: number;
  /** Initial stagger so 13 agents do not start in the same event-loop tick. */
  startDelayMs?: number;
  onEvent?: (message: string) => void;
}

export interface AgentSupervisorHandle {
  /** Stop supervising: cancels pending restarts and stops the agent loop. */
  stop(): void;
  /** Resolves once the supervised loop has settled after stop(). */
  settled(): Promise<void>;
}

export function superviseAgentLoop(
  agent: SupervisableAgent,
  options: AgentSupervisorOptions = {},
): AgentSupervisorHandle {
  const maxRestarts = options.maxRestarts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 5_000;
  const maxDelayMs = options.maxDelayMs ?? 5 * 60 * 1000;
  const log = options.onEvent ?? ((message: string) => console.error(message));

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> = Promise.resolve();

  const run = (attempt: number): void => {
    if (stopped) return;
    current = agent
      .start()
      .then(() => {
        // A clean return means stop() was called — not a crash.
      })
      .catch((err: unknown) => {
        if (stopped) return;
        recordAgentLoopCrash(agent.id, err);
        const detail = err instanceof Error ? err.message : String(err);

        if (attempt >= maxRestarts) {
          recordAgentLoopAbandoned(agent.id);
          log(
            `❌ Agent ${agent.id} loop crashed ${attempt} time(s); supervisor giving up. ` +
              `Reported at /health.workforce.abandoned. Last error: ${detail}`,
          );
          return;
        }

        // Exponential backoff with jitter so agents failing on the same shared
        // dependency (Postgres, OpenRouter) do not retry in lockstep.
        const delay =
          Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs) +
          Math.floor(Math.random() * 1000);
        log(
          `⚠️  Agent ${agent.id} loop crashed (attempt ${attempt}/${maxRestarts}): ${detail}. ` +
            `Restarting in ${Math.round(delay / 1000)}s`,
        );
        timer = setTimeout(() => {
          timer = undefined;
          if (stopped) return;
          recordAgentLoopRestart(agent.id);
          run(attempt + 1);
        }, delay);
      });
  };

  const startDelayMs = options.startDelayMs ?? 0;
  if (startDelayMs > 0) {
    timer = setTimeout(() => {
      timer = undefined;
      run(1);
    }, startDelayMs);
  } else {
    run(1);
  }

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      agent.stop();
    },
    settled() {
      return current;
    },
  };
}
