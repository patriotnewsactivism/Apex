import crypto from 'node:crypto';

/**
 * Login brute-force controls for POST /api/auth/login.
 *
 * Counters live in process memory. A second Railway replica, or a restart,
 * has its own counters — limits are not a distributed lock.
 *
 * `req.ip` is the rate-limit key. That value is only the real client when
 * Express `trust proxy` is the exact hop count in front of the app (Railway's
 * edge is one hop). Trusting the whole X-Forwarded-For chain lets a caller
 * pick their own key.
 */

export interface LoginGuardConfig {
  perIpMax: number;
  perIpWindowMs: number;
  globalMax: number;
  globalWindowMs: number;
  failureThreshold: number;
  lockoutBaseMs: number;
  lockoutMaxMs: number;
}

/** Safe when every optional APEX_LOGIN_* variable is unset. */
export const DEFAULT_LOGIN_GUARD_CONFIG: LoginGuardConfig = {
  perIpMax: 10,
  perIpWindowMs: 15 * 60 * 1000,
  globalMax: 60,
  globalWindowMs: 15 * 60 * 1000,
  failureThreshold: 5,
  lockoutBaseMs: 60 * 1000,
  lockoutMaxMs: 15 * 60 * 1000,
};

const MAX_TRACKED_IPS = 10_000;
const IDLE_IP_MS = 24 * 60 * 60 * 1000;

export type LoginDenialReason = 'per_ip' | 'global' | 'lockout';

export type LoginAdmission =
  | { allowed: true }
  | { allowed: false; reason: LoginDenialReason; retryAfterSeconds: number };

export interface LoginFailureResult {
  lockoutTriggered: boolean;
  retryAfterSeconds: number;
  failures: number;
}

interface FixedWindow {
  start: number;
  count: number;
}

interface IpState {
  window: FixedWindow;
  failures: number;
  strikes: number;
  lockedUntil: number;
  lastSeen: number;
}

function emptyWindow(): FixedWindow {
  return { start: 0, count: 0 };
}

function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Positive integer in range, or `fallback`. Invalid values never disable the
 * control — a typo must not open the login route.
 * The rejected raw value is not logged; these knobs are not secrets, but a
 * mis-set variable should not be copied into logs anyway.
 */
function readBoundedInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.warn(`[auth] invalid ${name}; using default ${fallback}`);
    return fallback;
  }
  return value;
}

export function loadLoginGuardConfig(
  env: NodeJS.ProcessEnv = process.env,
): LoginGuardConfig {
  const config: LoginGuardConfig = {
    perIpMax: readBoundedInt(
      env,
      'APEX_LOGIN_PER_IP_MAX',
      DEFAULT_LOGIN_GUARD_CONFIG.perIpMax,
      1,
      10_000,
    ),
    perIpWindowMs: readBoundedInt(
      env,
      'APEX_LOGIN_PER_IP_WINDOW_MS',
      DEFAULT_LOGIN_GUARD_CONFIG.perIpWindowMs,
      1_000,
      24 * 60 * 60 * 1000,
    ),
    globalMax: readBoundedInt(
      env,
      'APEX_LOGIN_GLOBAL_MAX',
      DEFAULT_LOGIN_GUARD_CONFIG.globalMax,
      1,
      100_000,
    ),
    globalWindowMs: readBoundedInt(
      env,
      'APEX_LOGIN_GLOBAL_WINDOW_MS',
      DEFAULT_LOGIN_GUARD_CONFIG.globalWindowMs,
      1_000,
      24 * 60 * 60 * 1000,
    ),
    failureThreshold: readBoundedInt(
      env,
      'APEX_LOGIN_FAILURE_THRESHOLD',
      DEFAULT_LOGIN_GUARD_CONFIG.failureThreshold,
      1,
      1_000,
    ),
    lockoutBaseMs: readBoundedInt(
      env,
      'APEX_LOGIN_LOCKOUT_BASE_MS',
      DEFAULT_LOGIN_GUARD_CONFIG.lockoutBaseMs,
      1_000,
      24 * 60 * 60 * 1000,
    ),
    lockoutMaxMs: readBoundedInt(
      env,
      'APEX_LOGIN_LOCKOUT_MAX_MS',
      DEFAULT_LOGIN_GUARD_CONFIG.lockoutMaxMs,
      1_000,
      24 * 60 * 60 * 1000,
    ),
  };
  if (config.lockoutMaxMs < config.lockoutBaseMs) {
    console.warn(
      '[auth] APEX_LOGIN_LOCKOUT_MAX_MS is below APEX_LOGIN_LOCKOUT_BASE_MS; using the base duration as the cap',
    );
    config.lockoutMaxMs = config.lockoutBaseMs;
  }
  return config;
}

/**
 * Hop count for Express `trust proxy`. Default 1 is Railway's edge proxy.
 * `true` is rejected: it trusts every X-Forwarded-For entry the client sent.
 * Values above 5 are rejected so a typo cannot trust a long spoofed chain.
 * 0 means the socket peer is the client (no proxy).
 */
export function resolveTrustProxyHops(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readBoundedInt(env, 'APEX_TRUST_PROXY_HOPS', 1, 0, 5);
}

/**
 * Rate-limit identity. Uses Express `req.ip` (which applies trust proxy) and
 * never parses X-Forwarded-For itself.
 */
export function clientAddress(req: {
  ip?: string;
  socket?: { remoteAddress?: string | null };
}): string {
  const fromProxy = req.ip?.trim();
  if (fromProxy) return fromProxy;
  const remote = req.socket?.remoteAddress?.trim();
  if (remote) return remote;
  return 'unknown';
}

/**
 * Compare two passwords without leaking length or byte-wise prefix differences
 * through `timingSafeEqual`'s length precondition. SHA-256 digests are always
 * 32 bytes, so the comparison itself is fixed-width.
 */
export function passwordsMatch(candidate: string, configured: string): boolean {
  const left = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  const right = crypto.createHash('sha256').update(configured, 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

function windowOpen(
  window: FixedWindow,
  now: number,
  windowMs: number,
): boolean {
  return window.start !== 0 && now - window.start < windowMs;
}

function retryAfterMs(
  window: FixedWindow,
  now: number,
  windowMs: number,
): number {
  if (!windowOpen(window, now, windowMs)) return windowMs;
  return Math.max(0, window.start + windowMs - now);
}

/** Count one admitted attempt. Call only after the ceiling check. */
function countAttempt(
  window: FixedWindow,
  now: number,
  windowMs: number,
): void {
  if (!windowOpen(window, now, windowMs)) {
    window.start = now;
    window.count = 0;
  }
  window.count += 1;
}

export class LoginAttemptGuard {
  private readonly ips = new Map<string, IpState>();
  private readonly globalWindow: FixedWindow = emptyWindow();

  constructor(
    private readonly config: LoginGuardConfig,
    private readonly now: () => number = Date.now,
    private readonly maxTrackedIps = MAX_TRACKED_IPS,
  ) {}

  admit(ip: string): LoginAdmission {
    const now = this.now();
    this.prune(now);
    const state = this.stateFor(ip, now);
    if (!state) {
      return {
        allowed: false,
        reason: 'global',
        retryAfterSeconds: retryAfterSeconds(this.config.perIpWindowMs),
      };
    }
    state.lastSeen = now;

    // Rejected traffic must not consume the other budget. One IP hammering a
    // per-IP ceiling, or a lockout, would otherwise exhaust the global window
    // and block the operator.
    if (state.lockedUntil > now) {
      return {
        allowed: false,
        reason: 'lockout',
        retryAfterSeconds: retryAfterSeconds(state.lockedUntil - now),
      };
    }
    if (
      windowOpen(state.window, now, this.config.perIpWindowMs) &&
      state.window.count >= this.config.perIpMax
    ) {
      return {
        allowed: false,
        reason: 'per_ip',
        retryAfterSeconds: retryAfterSeconds(
          retryAfterMs(state.window, now, this.config.perIpWindowMs),
        ),
      };
    }
    if (
      windowOpen(this.globalWindow, now, this.config.globalWindowMs) &&
      this.globalWindow.count >= this.config.globalMax
    ) {
      return {
        allowed: false,
        reason: 'global',
        retryAfterSeconds: retryAfterSeconds(
          retryAfterMs(this.globalWindow, now, this.config.globalWindowMs),
        ),
      };
    }

    countAttempt(state.window, now, this.config.perIpWindowMs);
    countAttempt(this.globalWindow, now, this.config.globalWindowMs);
    return { allowed: true };
  }

  recordFailure(ip: string): LoginFailureResult {
    const now = this.now();
    const state = this.ips.get(ip);
    if (!state) {
      return { lockoutTriggered: false, retryAfterSeconds: 0, failures: 0 };
    }
    state.failures += 1;
    state.lastSeen = now;
    if (state.failures < this.config.failureThreshold) {
      return {
        lockoutTriggered: false,
        retryAfterSeconds: 0,
        failures: state.failures,
      };
    }
    state.failures = 0;
    state.strikes += 1;
    const exponent = Math.min(state.strikes - 1, 20);
    const duration = Math.min(
      this.config.lockoutMaxMs,
      this.config.lockoutBaseMs * 2 ** exponent,
    );
    state.lockedUntil = now + duration;
    return {
      lockoutTriggered: true,
      retryAfterSeconds: retryAfterSeconds(duration),
      failures: this.config.failureThreshold,
    };
  }

  /** Clears failure/lockout state for this IP. Rate-limit windows stay consumed. */
  recordSuccess(ip: string): void {
    const state = this.ips.get(ip);
    if (!state) return;
    state.failures = 0;
    state.strikes = 0;
    state.lockedUntil = 0;
  }

  private stateFor(ip: string, now: number): IpState | null {
    const existing = this.ips.get(ip);
    if (existing) return existing;
    if (this.ips.size >= this.maxTrackedIps) return null;
    const created: IpState = {
      window: emptyWindow(),
      failures: 0,
      strikes: 0,
      lockedUntil: 0,
      lastSeen: now,
    };
    this.ips.set(ip, created);
    return created;
  }

  private prune(now: number): void {
    for (const [ip, state] of this.ips) {
      const idle =
        now - state.lastSeen >= IDLE_IP_MS && state.lockedUntil <= now;
      if (idle) this.ips.delete(ip);
    }
  }
}
