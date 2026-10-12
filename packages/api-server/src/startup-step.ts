// ─── Bounded startup steps ────────────────────────────────────────────────────
//
// Production returned 502 for hours because the HTTP listener sat behind
// startup work (migrate, provider/DB hydration) that could hang with no error
// and no timeout. Every awaited startup step goes through withStepTimeout() so
// a single stuck provider or database call is logged and skipped instead of
// silently taking the whole process offline.

const DEFAULT_STEP_TIMEOUT_MS = 20_000;

/** Per-step timeout. Overridable with APEX_STARTUP_STEP_TIMEOUT_MS. */
export function stepTimeoutMs(): number {
  const raw = Number(process.env.APEX_STARTUP_STEP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STEP_TIMEOUT_MS;
}

export type StepOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'timeout' }
  | { status: 'error'; error: unknown };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Races fn() against a timer and reports what happened. Never rejects.
 * The timer is always cleared once fn settles. If fn rejects after the timeout
 * already fired, the late rejection is logged rather than left unhandled.
 */
export async function runStepWithTimeout<T>(
  label: string,
  ms: number,
  fn: () => Promise<T>,
): Promise<StepOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const work = (async () => fn())();
  // Observe the original promise so a rejection after a timeout is logged,
  // never silently dropped and never an unhandled rejection.
  work.catch((err) => {
    if (timedOut) {
      console.warn(`⚠️  startup step '${label}' failed after timing out: ${errorMessage(err)}`);
    }
  });

  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve('timeout');
    }, ms);
  });

  try {
    const winner = await Promise.race([work.then((value) => ({ value })), timeout]);
    if (winner === 'timeout') {
      console.warn(`⚠️  startup step '${label}' exceeded ${ms}ms; continuing`);
      return { status: 'timeout' };
    }
    return { status: 'ok', value: winner.value };
  } catch (err) {
    console.warn(`⚠️  startup step '${label}' failed: ${errorMessage(err)}; continuing`);
    return { status: 'error', error: err };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs fn() with a timeout. Resolves to fn's value, or undefined if the step
 * timed out or threw (both are logged with console.warn).
 */
export async function withStepTimeout<T>(
  label: string,
  ms: number | undefined,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const outcome = await runStepWithTimeout(label, ms ?? stepTimeoutMs(), fn);
  return outcome.status === 'ok' ? outcome.value : undefined;
}
