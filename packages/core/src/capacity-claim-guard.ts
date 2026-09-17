import { TaskQueue } from './task-queue.js';
import { capacityPauseRemainingMs, getCapacityDeferralStats } from './base-agent.js';
import type { Task } from '@workspace/db';

const DEFAULT_RECOVERY_CLAIM_GAP_MS = 5_000;
const DEFAULT_RECENT_DEFERRAL_WINDOW_MS = 60_000;

const configuredGap = Number(process.env.APEX_CAPACITY_RECOVERY_CLAIM_GAP_MS ?? DEFAULT_RECOVERY_CLAIM_GAP_MS);
const RECOVERY_CLAIM_GAP_MS = Number.isFinite(configuredGap)
  ? Math.max(1_000, Math.min(30_000, Math.floor(configuredGap)))
  : DEFAULT_RECOVERY_CLAIM_GAP_MS;

const configuredWindow = Number(
  process.env.APEX_CAPACITY_RECOVERY_WINDOW_MS ?? DEFAULT_RECENT_DEFERRAL_WINDOW_MS,
);
const RECENT_DEFERRAL_WINDOW_MS = Number.isFinite(configuredWindow)
  ? Math.max(10_000, Math.min(5 * 60_000, Math.floor(configuredWindow)))
  : DEFAULT_RECENT_DEFERRAL_WINDOW_MS;

let lastObservedDeferralCount = 0;
let lastDeferralObservedAtMs = 0;
let nextRecoveryClaimAtMs = 0;
let installed = false;

/**
 * Prevent the post-capacity "thundering herd" without reducing normal APEX
 * concurrency.
 *
 * BaseAgent already has a workspace-wide pause latch. The remaining production
 * failure was at the instant that latch opened: every agent loop observed zero
 * pause at nearly the same time, and roles with concurrency >1 could fill
 * several slots before the first attempted LLM call had time to discover that
 * the free provider was still paced. One recovery probe therefore became a
 * burst of task claims, context rebuilds, and identical capacity deferrals.
 *
 * This guard sits at the durable claim boundary. After any observed capacity
 * deferral it admits at most one new dequeue every RECOVERY_CLAIM_GAP_MS for a
 * short recovery window. If the probe still has no capacity, BaseAgent records
 * another deferral and its normal workspace latch parks everyone again. If the
 * probe succeeds, no new deferrals arrive and this guard ages out automatically
 * after the recovery window. Outside recovery it is a zero-policy pass-through.
 */
export function installCapacityClaimGuard(): void {
  if (installed) return;
  installed = true;

  const originalDequeue = TaskQueue.prototype.dequeue;

  TaskQueue.prototype.dequeue = async function (): Promise<Task | null> {
    const now = Date.now();
    const stats = getCapacityDeferralStats(now);

    // Track fresh deferrals without needing access to BaseAgent's private
    // capacityDeferralsAtMs array. The count is monotonic within its rolling
    // window except when old entries age out; an increase means a new pause was
    // just observed by some task.
    if (stats.last15Minutes > lastObservedDeferralCount) {
      lastObservedDeferralCount = stats.last15Minutes;
      lastDeferralObservedAtMs = now;
      nextRecoveryClaimAtMs = Math.max(nextRecoveryClaimAtMs, now + RECOVERY_CLAIM_GAP_MS);
    } else if (stats.last15Minutes < lastObservedDeferralCount) {
      // Rolling-window expiry can lower the count. Reset the baseline so the
      // next real increase is detected instead of being masked by old history.
      lastObservedDeferralCount = stats.last15Minutes;
    }

    // BaseAgent normally avoids calling dequeue while parked, but keep this
    // check here too because TaskQueue has other callers and because
    // capacityPauseRemainingMs() may release a stale long pause early.
    if (capacityPauseRemainingMs(now) > 0) return null;

    const inRecoveryWindow =
      lastDeferralObservedAtMs > 0 && now - lastDeferralObservedAtMs < RECENT_DEFERRAL_WINDOW_MS;

    if (inRecoveryWindow) {
      if (now < nextRecoveryClaimAtMs) return null;
      // JavaScript runs this check/set synchronously before the first await, so
      // simultaneous agent loops in this process cannot all win the same slot.
      nextRecoveryClaimAtMs = now + RECOVERY_CLAIM_GAP_MS;
    }

    return originalDequeue.call(this);
  };
}

installCapacityClaimGuard();
