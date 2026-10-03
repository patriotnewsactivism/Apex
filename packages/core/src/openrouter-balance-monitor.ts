/**
 * OpenRouter balance monitor + paid auto-pause.
 *
 * WHY THIS EXISTS
 * ------------------------------------------------------------------
 * A negative OpenRouter balance does not only stop paid models: OpenRouter
 * answers 402 for `:free` models on an overdrawn account too, which would take
 * that account's 1,000 free requests/day with it. The credit probe in
 * provider-credits.ts already reads every account's balance through its
 * management key, and provider-account-exclusions.ts already excluded paid
 * routing at a balance of exactly $0 — too late, because OpenRouter settles a
 * request's cost after it finishes, so calls in flight overshoot.
 *
 * This module turns that probe into a guard with operator-tunable thresholds:
 *
 *   remaining <= APEX_OR_BALANCE_WARN_USD   (default 2.00) -> warning alert
 *   remaining <  APEX_OR_BALANCE_CRITICAL_USD (default 1.00) -> critical alert
 *   remaining <= APEX_OR_BALANCE_PAUSE_USD  (default 0.50) -> PAUSE paid
 *   remaining <= 0.01 (hard floor, not configurable below) -> PAUSE paid
 *   remaining >= APEX_OR_BALANCE_RESUME_USD (default 3.00) for
 *     APEX_OR_BALANCE_RESUME_CHECKS (default 2) consecutive checks -> resume
 *
 * A pause blocks PAID routing through that account inside APEX only (the
 * `balance_pause` exclusion). `:free` models keep flowing on the same key.
 *
 * Optional, default OFF (APEX_OR_AUTO_KEY_LIMIT=false): on pause, also set the
 * account's live APEX inference key `limit` to $0 through the OpenRouter
 * management API, after saving the prior limit. A $0-limit key still serves
 * `:free` models (verified 2026-10-03 on account 3: limit 0, ~750 free
 * requests served). Restoring the prior limit is ALWAYS an operator action
 * (POST /api/settings/openrouter-balance/:account/restore-key-limit); the
 * monitor never raises a key limit on its own.
 *
 * Alerts land as operator escalations (the approvals queue, kind=escalation,
 * deduplicated per account+level), as audit rows in `logs`, and — only when
 * APEX_OR_BALANCE_ALERT_WEBHOOK_URL is set — as a JSON POST to that webhook.
 *
 * Never logs or returns a key. Key hashes are shown as a 6-char suffix.
 */

import { createHash } from 'crypto';
import {
  clearOpenRouterPaidBalancePause,
  setOpenRouterPaidBalancePause,
} from './provider-account-exclusions.js';

// ─── Config ──────────────────────────────────────────────────────────────────

export const OPENROUTER_BALANCE_HARD_FLOOR_USD = 0.01;
const COMPONENT = 'openrouter-balance-monitor';
const KEYS_URL = 'https://openrouter.ai/api/v1/keys';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_EVENTS = 50;
const UNKNOWN_ALERT_AFTER = 3;

export interface BalanceMonitorConfig {
  warnUsd: number;
  criticalUsd: number;
  pauseUsd: number;
  floorUsd: number;
  resumeUsd: number;
  resumeConsecutiveChecks: number;
  fastIntervalMs: number;
  idleIntervalMs: number;
  realertMs: number;
  autoKeyLimit: boolean;
  webhookUrl: string | null;
}

function envNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min = 0,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((env[name] ?? '').trim().toLowerCase());
}

function webhookFrom(env: NodeJS.ProcessEnv): string | null {
  const raw = env.APEX_OR_BALANCE_ALERT_WEBHOOK_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function readBalanceMonitorConfig(
  env: NodeJS.ProcessEnv = process.env,
): BalanceMonitorConfig {
  const floorUsd = OPENROUTER_BALANCE_HARD_FLOOR_USD;
  const pauseUsd = Math.max(floorUsd, envNumber(env, 'APEX_OR_BALANCE_PAUSE_USD', 0.5));
  const criticalUsd = Math.max(pauseUsd, envNumber(env, 'APEX_OR_BALANCE_CRITICAL_USD', 1));
  const warnUsd = Math.max(criticalUsd, envNumber(env, 'APEX_OR_BALANCE_WARN_USD', 2));
  const resumeUsd = Math.max(pauseUsd, envNumber(env, 'APEX_OR_BALANCE_RESUME_USD', 3));
  return {
    warnUsd,
    criticalUsd,
    pauseUsd,
    floorUsd,
    resumeUsd,
    resumeConsecutiveChecks: Math.max(
      1,
      Math.floor(envNumber(env, 'APEX_OR_BALANCE_RESUME_CHECKS', 2, 1)),
    ),
    fastIntervalMs: Math.max(15, envNumber(env, 'APEX_OR_BALANCE_CHECK_SEC', 60, 15)) * 1000,
    idleIntervalMs: Math.max(60, envNumber(env, 'APEX_OR_BALANCE_IDLE_CHECK_SEC', 300, 60)) * 1000,
    realertMs: Math.max(5, envNumber(env, 'APEX_OR_BALANCE_REALERT_MIN', 360, 5)) * 60_000,
    autoKeyLimit: envFlag(env, 'APEX_OR_AUTO_KEY_LIMIT'),
    webhookUrl: webhookFrom(env),
  };
}

// ─── State ───────────────────────────────────────────────────────────────────

export type BalanceLevel = 'ok' | 'warn' | 'critical' | 'paused' | 'unknown';

const LEVEL_RANK: Record<BalanceLevel, number> = {
  unknown: -1,
  ok: 0,
  warn: 1,
  critical: 2,
  paused: 3,
};

export interface KeyLimitRecord {
  /** OpenRouter key hash (sha256 of the key). Internal; never returned whole. */
  keyHash: string;
  priorLimit: number | null;
  priorLimitReset: string | null;
  appliedAt: string;
  status: 'applied' | 'already_zero' | 'failed' | 'restored';
  detail: string | null;
  restoredAt: string | null;
}

export interface AccountBalanceState {
  account: string;
  env: string;
  remaining: number | null;
  level: BalanceLevel;
  paidPaused: boolean;
  pausedAt: string | null;
  pauseReason: string | null;
  resumeStreak: number;
  unknownStreak: number;
  lastAlertLevel: BalanceLevel | null;
  lastAlertAt: number | null;
  lastCheckedAt: string | null;
  keyLimit: KeyLimitRecord | null;
}

export interface BalanceObservation {
  account: string;
  env: string;
  remaining: number | null;
}

export type BalanceMonitorAction =
  | {
      type: 'alert';
      severity: 'info' | 'warning' | 'critical';
      account: string;
      level: BalanceLevel;
      remaining: number | null;
      subject: string;
      message: string;
      dedupeKey: string;
    }
  | { type: 'pause'; account: string; reason: string; remaining: number }
  | { type: 'resume'; account: string; remaining: number }
  | { type: 'key_limit'; account: string };

export interface BalanceMonitorEvent {
  at: string;
  account: string;
  type: BalanceMonitorAction['type'] | 'key_limit_result' | 'key_limit_restore';
  detail: string;
}

function emptyState(observation: BalanceObservation): AccountBalanceState {
  return {
    account: observation.account,
    env: observation.env,
    remaining: null,
    level: 'unknown',
    paidPaused: false,
    pausedAt: null,
    pauseReason: null,
    resumeStreak: 0,
    unknownStreak: 0,
    lastAlertLevel: null,
    lastAlertAt: null,
    lastCheckedAt: null,
    keyLimit: null,
  };
}

const usd = (value: number): string => `$${value.toFixed(2)}`;

function classify(remaining: number, config: BalanceMonitorConfig): {
  level: Exclude<BalanceLevel, 'unknown'>;
  pauseReason: string | null;
} {
  if (remaining <= config.floorUsd) {
    return { level: 'paused', pauseReason: `balance ${usd(remaining)} at or below the ${usd(config.floorUsd)} hard floor` };
  }
  if (remaining <= config.pauseUsd) {
    return { level: 'paused', pauseReason: `balance ${usd(remaining)} at or below the ${usd(config.pauseUsd)} pause threshold` };
  }
  if (remaining < config.criticalUsd) return { level: 'critical', pauseReason: null };
  if (remaining <= config.warnUsd) return { level: 'warn', pauseReason: null };
  return { level: 'ok', pauseReason: null };
}

function label(state: { account: string; env: string }): string {
  return state.env ? `${state.account} (${state.env})` : state.account;
}

/**
 * Pure transition: previous per-account state + one round of observations ->
 * next state + the actions to carry out. No I/O, no clock reads.
 */
export function evaluateBalanceObservations(
  previous: ReadonlyMap<string, AccountBalanceState>,
  observations: readonly BalanceObservation[],
  config: BalanceMonitorConfig,
  now: number,
): { next: Map<string, AccountBalanceState>; actions: BalanceMonitorAction[] } {
  const next = new Map<string, AccountBalanceState>();
  for (const [account, state] of previous) next.set(account, { ...state });
  const actions: BalanceMonitorAction[] = [];
  const nowIso = new Date(now).toISOString();

  for (const observation of observations) {
    const prior = next.get(observation.account) ?? emptyState(observation);
    const state: AccountBalanceState = { ...prior, env: observation.env || prior.env, lastCheckedAt: nowIso };
    next.set(observation.account, state);

    const remaining = observation.remaining;
    if (remaining === null || !Number.isFinite(remaining)) {
      state.unknownStreak += 1;
      state.resumeStreak = 0;
      if (!state.paidPaused) state.level = 'unknown';
      if (state.unknownStreak === UNKNOWN_ALERT_AFTER) {
        actions.push({
          type: 'alert',
          severity: 'critical',
          account: state.account,
          level: 'unknown',
          remaining: null,
          subject: `OpenRouter balance unreadable for ${label(state)}`,
          message:
            `The balance check for ${label(state)} failed ${UNKNOWN_ALERT_AFTER} times in a row. ` +
            'APEX cannot tell whether this account is about to go negative. ' +
            (state.paidPaused ? 'Paid routing stays paused.' : 'Paid routing is not paused by this alone.'),
          dedupeKey: `openrouter-balance:${state.account}:unknown`,
        });
      }
      continue;
    }

    state.unknownStreak = 0;
    state.remaining = remaining;
    const { level, pauseReason } = classify(remaining, config);

    if (state.paidPaused) {
      if (remaining >= config.resumeUsd) {
        state.resumeStreak += 1;
        if (state.resumeStreak >= config.resumeConsecutiveChecks) {
          state.paidPaused = false;
          state.pausedAt = null;
          state.pauseReason = null;
          state.resumeStreak = 0;
          state.level = level;
          state.lastAlertLevel = level;
          state.lastAlertAt = now;
          actions.push({ type: 'resume', account: state.account, remaining });
          const keyLimitNote =
            state.keyLimit && (state.keyLimit.status === 'applied')
              ? ` The OpenRouter key limit is still $0 (was ${state.keyLimit.priorLimit === null ? 'unlimited' : usd(state.keyLimit.priorLimit)}); restoring it requires an operator.`
              : '';
          actions.push({
            type: 'alert',
            severity: 'info',
            account: state.account,
            level,
            remaining,
            subject: `OpenRouter paid usage resumed for ${label(state)}`,
            message:
              `Balance ${usd(remaining)} has been at or above ${usd(config.resumeUsd)} for ` +
              `${config.resumeConsecutiveChecks} consecutive checks; APEX paid routing through this account is allowed again.` +
              keyLimitNote,
            dedupeKey: `openrouter-balance:${state.account}:resumed`,
          });
          continue;
        }
      } else {
        state.resumeStreak = 0;
      }
      state.level = 'paused';
      // Escalate the reason (e.g. pause threshold -> hard floor) without re-alerting.
      if (pauseReason && remaining <= config.floorUsd) state.pauseReason = pauseReason;
      continue;
    }

    if (level === 'paused' && pauseReason) {
      state.paidPaused = true;
      state.pausedAt = nowIso;
      state.pauseReason = pauseReason;
      state.resumeStreak = 0;
      state.level = 'paused';
      state.lastAlertLevel = 'paused';
      state.lastAlertAt = now;
      actions.push({ type: 'pause', account: state.account, reason: pauseReason, remaining });
      if (config.autoKeyLimit) actions.push({ type: 'key_limit', account: state.account });
      actions.push({
        type: 'alert',
        severity: 'critical',
        account: state.account,
        level: 'paused',
        remaining,
        subject: `PAID usage paused on OpenRouter ${label(state)} at ${usd(remaining)}`,
        message:
          `APEX stopped routing paid requests through ${label(state)}: ${pauseReason}. ` +
          'Free (:free) models keep working on this account. ' +
          (config.autoKeyLimit
            ? 'The OpenRouter key limit is being set to $0 (prior limit saved; restore requires an operator). '
            : '') +
          `Top up the account; paid routing resumes automatically after ${config.resumeConsecutiveChecks} checks at or above ${usd(config.resumeUsd)}.`,
        dedupeKey: `openrouter-balance:${state.account}:paused`,
      });
      continue;
    }

    state.level = level;
    if (level === 'ok') {
      state.lastAlertLevel = 'ok';
      continue;
    }
    const lastRank = state.lastAlertLevel ? LEVEL_RANK[state.lastAlertLevel] : -1;
    const worse = LEVEL_RANK[level] > lastRank;
    const stale = state.lastAlertAt === null || now - state.lastAlertAt >= config.realertMs;
    if (LEVEL_RANK[level] < lastRank) state.lastAlertLevel = level;
    if (!worse && !(stale && state.lastAlertLevel === level)) continue;
    state.lastAlertLevel = level;
    state.lastAlertAt = now;
    actions.push({
      type: 'alert',
      severity: level === 'critical' ? 'critical' : 'warning',
      account: state.account,
      level,
      remaining,
      subject:
        level === 'critical'
          ? `OpenRouter ${label(state)} balance ${usd(remaining)} is below ${usd(config.criticalUsd)}`
          : `OpenRouter ${label(state)} balance ${usd(remaining)} is at or below the ${usd(config.warnUsd)} warning`,
      message:
        (level === 'critical'
          ? `Balance ${usd(remaining)} is below the ${usd(config.criticalUsd)} critical line. A negative balance would also block this account's free models (1,000 requests/day). `
          : `Balance ${usd(remaining)} is at or below the ${usd(config.warnUsd)} early-warning line. `) +
        `Paid usage is still allowed; it pauses automatically at ${usd(config.pauseUsd)}. Top up to stay clear.`,
      dedupeKey: `openrouter-balance:${state.account}:${level}`,
    });
  }

  return { next, actions };
}

// ─── Runtime ─────────────────────────────────────────────────────────────────

/** Credentials for one account, resolved by provider-credits. Never exported
 *  outside the process and never logged. */
export interface BalanceAccountCredentials {
  inferenceKey: string;
  managementKey: string | null;
}

export interface BalanceMonitorSinks {
  escalate(action: Extract<BalanceMonitorAction, { type: 'alert' }>): Promise<void>;
  audit(entry: { level: 'info' | 'warn' | 'error'; message: string; data: Record<string, unknown> }): Promise<void>;
  webhook(url: string, payload: Record<string, unknown>): Promise<void>;
  persist(state: Record<string, unknown>): Promise<void>;
  load(): Promise<Record<string, unknown> | null>;
  fetch: typeof fetch;
}

let state = new Map<string, AccountBalanceState>();
let events: BalanceMonitorEvent[] = [];
let lastCheckAt: string | null = null;
let nextCheckAt: string | null = null;
let currentIntervalMs: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let hydrated = false;
let sinks: BalanceMonitorSinks = defaultSinks();

function recordEvent(account: string, type: BalanceMonitorEvent['type'], detail: string): void {
  events = [{ at: new Date().toISOString(), account, type, detail }, ...events].slice(0, MAX_EVENTS);
}

function keyHashOf(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function serializeState(): Record<string, unknown> {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    accounts: [...state.values()],
  };
}

function isAccountState(value: unknown): value is AccountBalanceState {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<AccountBalanceState>;
  return typeof entry.account === 'string' && typeof entry.paidPaused === 'boolean';
}

/** Restore persisted pauses and saved key limits at boot, before the first probe. */
export async function initializeOpenRouterBalanceMonitor(): Promise<boolean> {
  try {
    const saved = await sinks.load();
    const accounts = Array.isArray(saved?.accounts) ? saved.accounts : [];
    for (const entry of accounts) {
      if (!isAccountState(entry)) continue;
      state.set(entry.account, { ...entry });
      if (entry.paidPaused) {
        setOpenRouterPaidBalancePause(
          entry.account,
          entry.pauseReason ?? 'low OpenRouter balance (restored after restart)',
          entry.pausedAt ? Date.parse(entry.pausedAt) || Date.now() : Date.now(),
        );
      }
    }
    hydrated = true;
    return true;
  } catch {
    hydrated = false;
    return false;
  }
}

async function safely(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch {
    // Alert/audit sinks must never break the balance probe or routing.
  }
}

async function applyZeroKeyLimit(
  account: string,
  credentials: BalanceAccountCredentials | undefined,
): Promise<void> {
  const current = state.get(account);
  if (!current) return;
  if (current.keyLimit?.status === 'applied') {
    return; // Prior limit is already saved; never overwrite it with $0.
  }
  const nowIso = new Date().toISOString();
  const fail = async (detail: string, keyHash = ''): Promise<void> => {
    current.keyLimit = {
      keyHash,
      priorLimit: null,
      priorLimitReset: null,
      appliedAt: nowIso,
      status: 'failed',
      detail,
      restoredAt: null,
    };
    recordEvent(account, 'key_limit_result', `failed: ${detail}`);
    await safely(() => sinks.audit({ level: 'error', message: `OpenRouter key-limit step failed for ${account}: ${detail}`, data: { account } }));
  };
  if (!credentials?.managementKey) {
    await fail('no management key is mapped to this account');
    return;
  }
  const keyHash = keyHashOf(credentials.inferenceKey);
  try {
    const listed = await fetchJson(sinks.fetch, KEYS_URL, credentials.managementKey, 'GET');
    const rows = rowsFrom(listed.body);
    const row = rows.find((candidate) => String(candidate.hash ?? '').toLowerCase() === keyHash);
    if (!listed.ok || !row) {
      await fail(listed.ok ? 'live APEX key not found in this account’s key list' : `keys HTTP ${listed.status}`, keyHash);
      return;
    }
    const priorLimit = row.limit === null || row.limit === undefined ? null : Number(row.limit);
    const priorLimitReset = typeof row.limit_reset === 'string' ? row.limit_reset : null;
    if (priorLimit === 0) {
      current.keyLimit = { keyHash, priorLimit, priorLimitReset, appliedAt: nowIso, status: 'already_zero', detail: null, restoredAt: null };
      recordEvent(account, 'key_limit_result', `key …${keyHash.slice(-6)} already at $0`);
      return;
    }
    const patched = await fetchJson(sinks.fetch, `${KEYS_URL}/${keyHash}`, credentials.managementKey, 'PATCH', { limit: 0 });
    if (!patched.ok) {
      await fail(`PATCH HTTP ${patched.status}`, keyHash);
      return;
    }
    current.keyLimit = { keyHash, priorLimit, priorLimitReset, appliedAt: nowIso, status: 'applied', detail: null, restoredAt: null };
    const prior = priorLimit === null ? 'unlimited' : usd(priorLimit);
    recordEvent(account, 'key_limit_result', `key …${keyHash.slice(-6)} limit set to $0 (was ${prior})`);
    await safely(() => sinks.audit({
      level: 'warn',
      message: `OpenRouter key …${keyHash.slice(-6)} on ${account} limit set to $0 (was ${prior}); restore requires an operator`,
      data: { account, keyHashSuffix: keyHash.slice(-6), priorLimit, priorLimitReset },
    }));
  } catch (error) {
    await fail(error instanceof Error ? error.message : 'key-limit request failed', keyHash);
  }
}

/**
 * Run one monitor round. Called by provider-credits after every balance probe.
 * Applies pauses/resumes synchronously (before returning) so routing reflects
 * the new balance immediately; alerts and key-limit writes follow.
 */
export async function runOpenRouterBalanceMonitor(
  observations: readonly BalanceObservation[],
  credentials: ReadonlyMap<string, BalanceAccountCredentials> = new Map(),
  options: { config?: BalanceMonitorConfig; now?: number } = {},
): Promise<BalanceMonitorAction[]> {
  const config = options.config ?? readBalanceMonitorConfig();
  const now = options.now ?? Date.now();
  const { next, actions } = evaluateBalanceObservations(state, observations, config, now);
  state = next;
  lastCheckAt = new Date(now).toISOString();

  for (const action of actions) {
    if (action.type === 'pause') {
      setOpenRouterPaidBalancePause(action.account, action.reason, now);
      recordEvent(action.account, 'pause', action.reason);
    } else if (action.type === 'resume') {
      clearOpenRouterPaidBalancePause(action.account);
      recordEvent(action.account, 'resume', `balance ${usd(action.remaining)}`);
    }
  }
  // Re-assert every pause the state says is active (e.g. after a test reset of
  // the exclusion map or a hydration race), and never leave a stale one.
  for (const entry of state.values()) {
    if (entry.paidPaused) {
      setOpenRouterPaidBalancePause(entry.account, entry.pauseReason ?? 'low OpenRouter balance', now);
    }
  }

  for (const action of actions) {
    if (action.type === 'key_limit') {
      await applyZeroKeyLimit(action.account, credentials.get(action.account));
    } else if (action.type === 'alert') {
      recordEvent(action.account, 'alert', `${action.severity}: ${action.subject}`);
      const payload = {
        source: 'apex.openrouter-balance-monitor',
        severity: action.severity,
        level: action.level,
        account: action.account,
        remainingUsd: action.remaining,
        subject: action.subject,
        message: action.message,
        at: new Date(now).toISOString(),
      };
      await safely(() => sinks.escalate(action));
      await safely(() => sinks.audit({
        level: action.severity === 'critical' ? 'error' : action.severity === 'warning' ? 'warn' : 'info',
        message: `[balance-monitor] ${action.subject}`,
        data: payload,
      }));
      if (config.webhookUrl) {
        const url = config.webhookUrl;
        await safely(() => sinks.webhook(url, payload));
      }
    } else if (action.type === 'pause' || action.type === 'resume') {
      await safely(() => sinks.audit({
        level: action.type === 'pause' ? 'warn' : 'info',
        message: `[balance-monitor] ${action.type} paid routing for ${action.account}`,
        data: { account: action.account, remainingUsd: action.remaining, ...(action.type === 'pause' ? { reason: action.reason } : {}) },
      }));
    }
  }

  await safely(() => sinks.persist(serializeState()));
  return actions;
}

/**
 * Operator action: put the saved prior limit back on the APEX inference key.
 * The only path that ever raises a key limit.
 */
export async function restoreOpenRouterKeyLimit(
  account: string,
  credentials: BalanceAccountCredentials | undefined,
  operator = 'operator',
): Promise<{ ok: boolean; detail: string }> {
  const current = state.get(account);
  const record = current?.keyLimit;
  if (!current || !record || record.status !== 'applied') {
    return { ok: false, detail: 'no applied key limit is recorded for this account' };
  }
  if (!credentials?.managementKey) {
    return { ok: false, detail: 'no management key is mapped to this account' };
  }
  const body: Record<string, unknown> = { limit: record.priorLimit };
  if (record.priorLimitReset) body.limit_reset = record.priorLimitReset;
  const patched = await fetchJson(sinks.fetch, `${KEYS_URL}/${record.keyHash}`, credentials.managementKey, 'PATCH', body);
  if (!patched.ok) return { ok: false, detail: `PATCH HTTP ${patched.status}` };
  const restoredAt = new Date().toISOString();
  current.keyLimit = { ...record, status: 'restored', restoredAt };
  const prior = record.priorLimit === null ? 'unlimited' : usd(record.priorLimit);
  recordEvent(account, 'key_limit_restore', `key …${record.keyHash.slice(-6)} limit restored to ${prior} by ${operator}`);
  await safely(() => sinks.audit({
    level: 'info',
    message: `OpenRouter key …${record.keyHash.slice(-6)} on ${account} limit restored to ${prior} by ${operator}`,
    data: { account, keyHashSuffix: record.keyHash.slice(-6), priorLimit: record.priorLimit, operator },
  }));
  await safely(() => sinks.persist(serializeState()));
  return { ok: true, detail: `limit restored to ${prior}` };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Re-arming timer: 60 s while paid routing is enabled, 5 min otherwise
 * (APEX_OR_BALANCE_CHECK_SEC / APEX_OR_BALANCE_IDLE_CHECK_SEC). The interval
 * is recomputed every round so flipping APEX_PAID_FALLBACK_ENABLED takes
 * effect without a restart of the monitor.
 */
export function startOpenRouterBalanceMonitor(deps: {
  paidRoutingEnabled: () => boolean;
  refresh: () => Promise<void>;
}): { stop(): void } {
  stopOpenRouterBalanceMonitor();
  const arm = (): void => {
    const config = readBalanceMonitorConfig();
    let paid = false;
    try {
      paid = deps.paidRoutingEnabled();
    } catch {
      paid = false;
    }
    currentIntervalMs = paid ? config.fastIntervalMs : config.idleIntervalMs;
    nextCheckAt = new Date(Date.now() + currentIntervalMs).toISOString();
    timer = setTimeout(() => {
      deps.refresh().catch(() => undefined).finally(arm);
    }, currentIntervalMs);
    timer.unref?.();
  };
  arm();
  return { stop: stopOpenRouterBalanceMonitor };
}

export function stopOpenRouterBalanceMonitor(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  nextCheckAt = null;
}

// ─── Status (authenticated /api/health/detail) ───────────────────────────────

export interface OpenRouterBalanceMonitorStatus {
  config: Omit<BalanceMonitorConfig, 'webhookUrl'> & { webhookConfigured: boolean };
  hydrated: boolean;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  checkIntervalSec: number | null;
  pausedAccounts: string[];
  accounts: Array<{
    account: string;
    env: string;
    remaining: number | null;
    level: BalanceLevel;
    paidPaused: boolean;
    pausedAt: string | null;
    pauseReason: string | null;
    resumeStreak: number;
    resumeChecksNeeded: number;
    lastCheckedAt: string | null;
    keyLimit: {
      status: KeyLimitRecord['status'];
      keyHashSuffix: string;
      priorLimit: number | null;
      appliedAt: string;
      restoredAt: string | null;
      restoreRequiresOperator: boolean;
      detail: string | null;
    } | null;
  }>;
  recentEvents: BalanceMonitorEvent[];
}

export function getOpenRouterBalanceMonitorStatus(
  config: BalanceMonitorConfig = readBalanceMonitorConfig(),
): OpenRouterBalanceMonitorStatus {
  const { webhookUrl, ...rest } = config;
  const accounts = [...state.values()].sort((a, b) => a.account.localeCompare(b.account));
  return {
    config: { ...rest, webhookConfigured: webhookUrl !== null },
    hydrated,
    lastCheckAt,
    nextCheckAt,
    checkIntervalSec: currentIntervalMs === null ? null : Math.round(currentIntervalMs / 1000),
    pausedAccounts: accounts.filter((entry) => entry.paidPaused).map((entry) => entry.account),
    accounts: accounts.map((entry) => ({
      account: entry.account,
      env: entry.env,
      remaining: entry.remaining,
      level: entry.level,
      paidPaused: entry.paidPaused,
      pausedAt: entry.pausedAt,
      pauseReason: entry.pauseReason,
      resumeStreak: entry.resumeStreak,
      resumeChecksNeeded: config.resumeConsecutiveChecks,
      lastCheckedAt: entry.lastCheckedAt,
      keyLimit: entry.keyLimit
        ? {
            status: entry.keyLimit.status,
            keyHashSuffix: entry.keyLimit.keyHash.slice(-6),
            priorLimit: entry.keyLimit.priorLimit,
            appliedAt: entry.keyLimit.appliedAt,
            restoredAt: entry.keyLimit.restoredAt,
            restoreRequiresOperator: entry.keyLimit.status === 'applied',
            detail: entry.keyLimit.detail,
          }
        : null,
    })),
    recentEvents: events.slice(0, 20),
  };
}

// ─── I/O helpers and default sinks ───────────────────────────────────────────

type KeyRow = { hash?: unknown; limit?: unknown; limit_reset?: unknown };

function rowsFrom(body: unknown): KeyRow[] {
  const root = body as { data?: unknown } | null;
  const data = root?.data ?? body;
  return Array.isArray(data) ? (data as KeyRow[]) : [];
}

async function fetchJson(
  fetcher: typeof fetch,
  url: string,
  apiKey: string,
  method: 'GET' | 'PATCH',
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { ok: response.ok, status: response.status, body: parsed };
  } finally {
    clearTimeout(timeout);
  }
}

function defaultSinks(): BalanceMonitorSinks {
  const testMode = (): boolean => process.env.NODE_ENV === 'test';
  return {
    async escalate(action) {
      if (testMode()) return;
      const [{ db, approvals }, { and, eq }, { randomUUID }] = await Promise.all([
        import('@workspace/db'),
        import('drizzle-orm'),
        import('crypto'),
      ]);
      const now = new Date();
      const urgency = action.severity === 'critical' ? 'high' : action.severity === 'warning' ? 'medium' : 'low';
      const toolArgs = {
        subject: action.subject,
        detail: action.message,
        urgency,
        category: 'provider_billing',
        account: action.account,
        level: action.level,
        remainingUsd: action.remaining,
      };
      const reason = `[${urgency.toUpperCase()} · provider_billing] ${action.subject}`;
      const [existing] = await db
        .select({ id: approvals.id, occurrences: approvals.occurrences })
        .from(approvals)
        .where(and(eq(approvals.kind, 'escalation'), eq(approvals.status, 'pending'), eq(approvals.dedupeKey, action.dedupeKey)))
        .limit(1);
      if (existing) {
        await db
          .update(approvals)
          .set({ occurrences: (existing.occurrences ?? 1) + 1, lastOccurredAt: now, toolArgs, reason })
          .where(eq(approvals.id, existing.id));
        return;
      }
      await db.insert(approvals).values({
        id: randomUUID(),
        taskId: 'system',
        agentId: 'system:openrouter-balance-monitor',
        toolName: 'openrouter_balance_monitor',
        toolArgs,
        reason,
        status: 'pending',
        kind: 'escalation',
        dedupeKey: action.dedupeKey,
        occurrences: 1,
        lastOccurredAt: now,
        createdAt: now,
      });
    },
    async audit(entry) {
      const line = `${entry.message}`;
      if (entry.level === 'error') console.error(line);
      else if (entry.level === 'warn') console.warn(line);
      else console.log(line);
      if (testMode()) return;
      const { db, logs } = await import('@workspace/db');
      await db.insert(logs).values({
        agentId: 'system:openrouter-balance-monitor',
        level: entry.level,
        message: entry.message,
        data: entry.data,
      });
    },
    async webhook(url, payload) {
      if (testMode()) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const secret = process.env.APEX_OR_BALANCE_ALERT_WEBHOOK_SECRET?.trim();
        await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
    async persist(snapshot) {
      if (testMode()) return;
      const { db, componentHealth } = await import('@workspace/db');
      const now = new Date();
      const accounts = (snapshot.accounts as AccountBalanceState[]) ?? [];
      const paused = accounts.filter((entry) => entry.paidPaused).length;
      const values = {
        status: paused > 0 ? 'degraded' : 'healthy',
        detail: paused > 0 ? `${paused} OpenRouter account(s) paid-paused for low balance` : 'all OpenRouter balances above pause threshold',
        lastCheckTime: now,
        consecutiveFailures: 0,
        metadata: snapshot,
      };
      await db
        .insert(componentHealth)
        .values({ component: COMPONENT, ...values })
        .onConflictDoUpdate({ target: componentHealth.component, set: values });
    },
    async load() {
      if (testMode()) return null;
      const [{ db, componentHealth }, { eq }] = await Promise.all([
        import('@workspace/db'),
        import('drizzle-orm'),
      ]);
      const [row] = await db
        .select()
        .from(componentHealth)
        .where(eq(componentHealth.component, COMPONENT))
        .limit(1);
      const metadata = row?.metadata as Record<string, unknown> | undefined;
      return metadata && metadata.version === 1 ? metadata : null;
    },
    fetch: (...args) => fetch(...args),
  };
}

/** Test seam: swap sinks (escalation/audit/webhook/persistence/fetch). */
export function __setBalanceMonitorSinksForTest(overrides: Partial<BalanceMonitorSinks>): void {
  sinks = { ...defaultSinks(), ...overrides };
}

export function __resetBalanceMonitorForTest(): void {
  stopOpenRouterBalanceMonitor();
  state = new Map();
  events = [];
  lastCheckAt = null;
  currentIntervalMs = null;
  hydrated = false;
  sinks = defaultSinks();
}
