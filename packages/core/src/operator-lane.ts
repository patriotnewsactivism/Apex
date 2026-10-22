/**
 * Reserved operator chat lane.
 *
 * Production 2026-10-22: the workspace-wide capacity pause (and the shared
 * APEX_MAX_CONCURRENT_LLM_CALLS queue) parked the operator's Command chat
 * behind hundreds of background tasks. A human typing one message at a time
 * cannot cause runaway burn, so operator/Command chat gets its own small lane:
 *
 *  - its own concurrency slots (APEX_OPERATOR_LLM_CONCURRENCY, default 2) that
 *    background agents never consume, so it never waits in the shared queue;
 *  - its own small daily request budget (APEX_OPERATOR_DAILY_REQUESTS, default
 *    200, resets at UTC midnight) which is exempt from the workspace token /
 *    emergency-request governors that cause the capacity pause;
 *  - the paid route is appended for this lane ONLY while the paid spend ledger
 *    still has headroom under APEX_DAILY_SPEND_USD, so it never spends past the
 *    configured daily cap.
 *
 * When the lane's budget is exhausted the call falls back to the normal
 * (governed) path, so the lane can never become an unbounded bypass.
 */

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || process.env[name] === undefined || process.env[name]?.trim() === '') {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

export function operatorLaneConcurrency(): number {
  return envInt('APEX_OPERATOR_LLM_CONCURRENCY', 2, 1, 8);
}

export function operatorLaneDailyRequests(): number {
  return envInt('APEX_OPERATOR_DAILY_REQUESTS', 200, 0, 5_000);
}

let activeOperatorCalls = 0;
let operatorRequestsToday = 0;
let operatorDayKey = '';

function utcDayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function rollover(at: number): void {
  const key = utcDayKey(at);
  if (key !== operatorDayKey) {
    operatorDayKey = key;
    operatorRequestsToday = 0;
  }
}

export interface OperatorLaneTicket {
  release(): void;
}

/**
 * Try to enter the reserved operator lane. Returns null (caller should use the
 * normal governed path) when the lane's concurrency or daily budget is used up.
 */
export function tryEnterOperatorLane(at: number = Date.now()): OperatorLaneTicket | null {
  rollover(at);
  if (activeOperatorCalls >= operatorLaneConcurrency()) return null;
  if (operatorRequestsToday >= operatorLaneDailyRequests()) return null;
  activeOperatorCalls++;
  operatorRequestsToday++;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      activeOperatorCalls = Math.max(0, activeOperatorCalls - 1);
    },
  };
}

/**
 * Provider order for an operator-lane call: the normal order, plus the paid
 * route(s) at the end when the daily spend cap still has headroom. Never adds a
 * paid route when the cap is spent.
 */
export function operatorLaneProviderOrder<T extends string>(
  baseOrder: readonly T[],
  paidRoutes: readonly T[],
  paidSpendHeadroom: boolean,
): T[] {
  const order = [...baseOrder];
  if (!paidSpendHeadroom) return order.filter((name) => !paidRoutes.includes(name));
  for (const route of paidRoutes) if (!order.includes(route)) order.push(route);
  return order;
}

export function getOperatorLaneStats(at: number = Date.now()): {
  active: number;
  concurrency: number;
  requestsToday: number;
  dailyBudget: number;
} {
  rollover(at);
  return {
    active: activeOperatorCalls,
    concurrency: operatorLaneConcurrency(),
    requestsToday: operatorRequestsToday,
    dailyBudget: operatorLaneDailyRequests(),
  };
}

/** Test seam. */
export function __resetOperatorLaneForTest(): void {
  activeOperatorCalls = 0;
  operatorRequestsToday = 0;
  operatorDayKey = '';
}
