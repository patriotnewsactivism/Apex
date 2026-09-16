/**
 * A capacity pause must actually pause.
 *
 * capacityPauseError() reports Math.min() of every blocking provider's
 * resume-at. Under "daily allowance pacing" that is a few hundred milliseconds
 * out and has usually elapsed by the time the agent records it, so the latch
 * was zero-length: the gate reopened on the next lap, the agent claimed a task,
 * rebuilt its history and learning context, hit the same gate and deferred.
 * Production showed ~57 of those cycles in 50 seconds on 2026-09-05.
 *
 * #104 removed that waste for long pauses. This covers the short end.
 */
import assert from 'node:assert/strict';
import {
  capacityPauseRemainingMs,
  __resetCapacityLatchForTest,
  __setCapacityLatchForTest,
} from '../packages/core/src/base-agent.js';

function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  console.log(`  ok  ${label}`);
}

async function main() {
  // ── A resume-at that has already elapsed must still pause ────────────────
  __resetCapacityLatchForTest();
  __setCapacityLatchForTest(Date.now() - 5_000);
  const elapsed = capacityPauseRemainingMs();
  check(
    `an already-elapsed resume-at still parks the workforce (got ${elapsed}ms)`,
    elapsed > 1_000,
  );

  // ── The pacing case that actually span in production ─────────────────────
  __resetCapacityLatchForTest();
  __setCapacityLatchForTest(Date.now() + 300);
  const pacing = capacityPauseRemainingMs();
  check(
    `a sub-second pacing resume-at is floored, not passed through (got ${pacing}ms)`,
    pacing > 1_000,
  );

  // ── Simulate the loop: the gate must not reopen on the very next lap ──────
  __resetCapacityLatchForTest();
  let claims = 0;
  const startedAt = Date.now();
  for (let lap = 0; lap < 200; lap++) {
    if (capacityPauseRemainingMs() === 0) {
      claims++;
      // The agent claims, does its setup, and is refused again with a
      // resume-at that is effectively now — exactly what pacing returns.
      __setCapacityLatchForTest(Date.now() + 200);
    }
  }
  check(
    `200 tight laps produce one claim, not a spin (got ${claims} in ${Date.now() - startedAt}ms)`,
    claims === 1,
  );

  // ── A genuinely long pause is preserved, not shortened to the floor ───────
  __resetCapacityLatchForTest();
  const dayOut = Date.now() + 22 * 60 * 60 * 1000;
  __setCapacityLatchForTest(dayOut);
  const long = capacityPauseRemainingMs();
  check(
    `a 22h daily-cap pause is not truncated by the floor (got ${Math.round(long / 3_600_000)}h)`,
    long > 21 * 60 * 60 * 1000,
  );

  __resetCapacityLatchForTest();
  console.log('✅ CAPACITY PAUSE FLOOR PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
