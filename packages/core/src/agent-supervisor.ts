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
// In both cases a rejected start() was logged once and the agent then never
// polled again. Nothing restarted it, and `/health` still reported
// `agents: 13` because that number is the size of the constructed workforce
// map, not a liveness measurement. The workforce silently shrinks while the
// service keeps answering `status: ok`.
//
// Honest scope note (raised in review, and correct): today's known DB-blip
// paths do NOT reject start(). AgentLogger.log() swallows its own insert
// error, and setStatus() fires its update without awaiting it (that unhandled
// rejection is fixed separately in base-agent.ts). So this supervisor is not
// primarily a fix for one reproduced crash — it closes the structural hole
// that any future rejection out of start(), or any refactor that makes those
// paths awaited, would fall straight through. The paired heartbeat/liveness
// reporting in runtime-health.ts is what covers the other half: a loop that is
// wedged rather than crashed.
//
// Restarts use bounded, jittered exponential backoff. Bounded on purpose: an
// agent that crashes instantly and forever must not become an infinite restart
// loop burning DB/LLM capacity. After `maxRestarts` the supervisor stops and
// records the agent as abandoned, which `/health.workforce.abandoned` surfaces
// for an operator.
//
// KNOWN LIMITATION (also raised in review): the liveness registry is
// process-local. When the dedicated `start:worker` runtime is used, the API
// process serving `/health` cannot see the worker's loops, and the worker has
// no health endpoint of its own. Cross-process liveness needs a durable or
// aggregated channel and is deliberately out of scope here; the worker logs
// supervisor events through its own onEvent hook in the meantime.

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
