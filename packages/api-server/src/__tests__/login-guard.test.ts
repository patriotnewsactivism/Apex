import crypto from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOGIN_GUARD_CONFIG,
  LoginAttemptGuard,
  clientAddress,
  loadLoginGuardConfig,
  passwordsMatch,
  resolveTrustProxyHops,
  type LoginGuardConfig,
} from '../login-guard.js';

process.env.APEX_ADMIN_TOKEN = 'test-admin-token';
process.env.APEX_ADMIN_PASSWORD = 'correct-horse-battery';

const { createAuthRouter } = await import('../routes/auth.js');

const WRONG_PASSWORD = 'wrong-password-do-not-log';
const here = dirname(fileURLToPath(import.meta.url));

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: { error?: string; token?: string; retryAfterSeconds?: number };
}

function guardConfig(
  overrides: Partial<LoginGuardConfig> = {},
): LoginGuardConfig {
  return {
    perIpMax: 100,
    perIpWindowMs: 60_000,
    globalMax: 1_000,
    globalWindowMs: 60_000,
    failureThreshold: 5,
    lockoutBaseMs: 60_000,
    lockoutMaxMs: 15 * 60_000,
    ...overrides,
  };
}

function listen(
  app: express.Express,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('test server did not bind a TCP port'));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}

function post(
  port: number,
  path: string,
  json: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const payload = JSON.stringify(json);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: HttpResult['body'] = {};
          try {
            body = JSON.parse(text) as HttpResult['body'];
          } catch {
            body = { error: text };
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function loginApp(guard: LoginAttemptGuard, hops = 1): express.Express {
  const app = express();
  app.set('trust proxy', hops);
  app.use(express.json());
  app.use('/api/auth', createAuthRouter({ guard }));
  return app;
}

describe('passwordsMatch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('compares SHA-256 digests with timingSafeEqual so length cannot bail out', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');

    expect(
      passwordsMatch('correct-horse-battery', 'correct-horse-battery'),
    ).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const [left, right] = spy.mock.calls[0] ?? [];
    expect(Buffer.isBuffer(left)).toBe(true);
    expect(Buffer.isBuffer(right)).toBe(true);
    expect((left as Buffer).length).toBe(32);
    expect((right as Buffer).length).toBe(32);
    expect((left as Buffer).equals(right as Buffer)).toBe(true);

    spy.mockClear();
    expect(passwordsMatch('short', 'a-much-longer-admin-password')).toBe(false);
    const [shortDigest, longDigest] = spy.mock.calls[0] ?? [];
    expect((shortDigest as Buffer).length).toBe(32);
    expect((longDigest as Buffer).length).toBe(32);
    expect((shortDigest as Buffer).equals(longDigest as Buffer)).toBe(false);
  });

  it('does not treat a shared prefix as a match', () => {
    expect(
      passwordsMatch('correct-horse-battery', 'correct-horse-battery-extra'),
    ).toBe(false);
    expect(passwordsMatch('', 'correct-horse-battery')).toBe(false);
  });
});

describe('login guard config', () => {
  it('uses safe defaults when the optional knobs are unset', () => {
    expect(loadLoginGuardConfig({})).toEqual(DEFAULT_LOGIN_GUARD_CONFIG);
    expect(resolveTrustProxyHops({})).toBe(1);
  });

  it('rejects invalid limits and an unbounded trust-proxy setting', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadLoginGuardConfig({ APEX_LOGIN_PER_IP_MAX: '0' }).perIpMax).toBe(
      DEFAULT_LOGIN_GUARD_CONFIG.perIpMax,
    );
    expect(
      loadLoginGuardConfig({ APEX_LOGIN_FAILURE_THRESHOLD: 'nope' })
        .failureThreshold,
    ).toBe(5);
    expect(resolveTrustProxyHops({ APEX_TRUST_PROXY_HOPS: 'true' })).toBe(1);
    expect(resolveTrustProxyHops({ APEX_TRUST_PROXY_HOPS: '99' })).toBe(1);
    expect(resolveTrustProxyHops({ APEX_TRUST_PROXY_HOPS: '2' })).toBe(2);
    expect(resolveTrustProxyHops({ APEX_TRUST_PROXY_HOPS: '0' })).toBe(0);
    const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).not.toContain('nope');
    expect(logged).not.toContain('true');
    expect(logged).not.toContain('99');
    expect(logged).toContain('using default');
    warn.mockRestore();
  });
});

describe('POST /api/auth/login', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockClear();
    info.mockClear();
    error.mockClear();
    process.env.APEX_ADMIN_PASSWORD = 'correct-horse-battery';
    process.env.APEX_ADMIN_TOKEN = 'test-admin-token';
  });

  function loggedLines(): string {
    return [...warn.mock.calls, ...info.mock.calls, ...error.mock.calls]
      .map((call) => call.map(String).join(' '))
      .join('\n');
  }

  it('returns the same token payload on success', async () => {
    let now = 1_700_000_000_000;
    const guard = new LoginAttemptGuard(guardConfig(), () => now);
    const app = loginApp(guard);
    const server = await listen(app);
    try {
      const ok = await post(
        server.port,
        '/api/auth/login',
        { password: 'correct-horse-battery' },
        {
          'x-forwarded-for': '203.0.113.10',
        },
      );
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ token: 'test-admin-token' });
      expect(ok.headers['retry-after']).toBeUndefined();

      now += 1_000;
      const afterFailures = await post(
        server.port,
        '/api/auth/login',
        { password: WRONG_PASSWORD },
        {
          'x-forwarded-for': '203.0.113.10',
        },
      );
      expect(afterFailures.status).toBe(401);
      const still = await post(
        server.port,
        '/api/auth/login',
        { password: 'correct-horse-battery' },
        {
          'x-forwarded-for': '203.0.113.10',
        },
      );
      expect(still.status).toBe(200);
      expect(still.body).toEqual({ token: 'test-admin-token' });
    } finally {
      await server.close();
    }
  });

  it('locks the client IP after N failures and answers 429 with Retry-After', async () => {
    let now = 1_700_000_000_000;
    const guard = new LoginAttemptGuard(
      guardConfig({
        failureThreshold: 3,
        lockoutBaseMs: 120_000,
        lockoutMaxMs: 900_000,
      }),
      () => now,
    );
    const app = loginApp(guard);
    const server = await listen(app);
    const headers = { 'x-forwarded-for': '203.0.113.20' };
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const failed = await post(
          server.port,
          '/api/auth/login',
          { password: WRONG_PASSWORD },
          headers,
        );
        expect(failed.status).toBe(401);
        expect(failed.body).toEqual({ error: 'Incorrect password' });
      }

      const lines = loggedLines();
      expect(lines).toMatch(
        /login failed ip=203\.0\.113\.20 at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/,
      );
      expect(lines).toContain('login lockout triggered ip=203.0.113.20 at=');
      expect(lines).toContain('retryAfterSeconds=120');
      expect(lines).toContain('failures=3');
      expect(lines).not.toContain(WRONG_PASSWORD);
      expect(lines).not.toContain('correct-horse-battery');

      warn.mockClear();
      info.mockClear();
      const locked = await post(
        server.port,
        '/api/auth/login',
        { password: 'correct-horse-battery' },
        headers,
      );
      expect(locked.status).toBe(429);
      expect(locked.headers['retry-after']).toBe('120');
      expect(locked.body).toEqual({
        error: 'Too many login attempts',
        retryAfterSeconds: 120,
      });
      const duringLockout = loggedLines();
      expect(duringLockout).toContain('reason=lockout');
      expect(duringLockout).not.toContain('login lockout triggered');
      expect(duringLockout).not.toContain('correct-horse-battery');

      now += 120_000;
      const after = await post(
        server.port,
        '/api/auth/login',
        { password: 'correct-horse-battery' },
        headers,
      );
      expect(after.status).toBe(200);
      expect(after.body).toEqual({ token: 'test-admin-token' });
    } finally {
      await server.close();
    }
  });

  it('backs off longer on the next lockout and a success clears the strike count', async () => {
    let now = 1_700_000_000_000;
    const guard = new LoginAttemptGuard(
      guardConfig({
        failureThreshold: 2,
        lockoutBaseMs: 60_000,
        lockoutMaxMs: 900_000,
        perIpMax: 50,
      }),
      () => now,
    );
    const app = loginApp(guard);
    const server = await listen(app);
    const headers = { 'x-forwarded-for': '203.0.113.30' };
    try {
      await post(
        server.port,
        '/api/auth/login',
        { password: WRONG_PASSWORD },
        headers,
      );
      await post(
        server.port,
        '/api/auth/login',
        { password: WRONG_PASSWORD },
        headers,
      );
      now += 60_000;
      await post(
        server.port,
        '/api/auth/login',
        { password: WRONG_PASSWORD },
        headers,
      );
      const second = await post(
        server.port,
        '/api/auth/login',
        { password: WRONG_PASSWORD },
        headers,
      );
      expect(second.status).toBe(401);
      const locked = await post(
        server.port,
        '/api/auth/login',
        { password: WRONG_PASSWORD },
        headers,
      );
      expect(locked.status).toBe(429);
      expect(locked.body.retryAfterSeconds).toBe(120);

      now += 120_000;
      const recovered = await post(
        server.port,
        '/api/auth/login',
        { password: 'correct-horse-battery' },
        headers,
      );
      expect(recovered.status).toBe(200);

      await post(
        server.port,
        '/api/auth/login',
        { password: WRONG_PASSWORD },
        headers,
      );
      const notYet = await post(
        server.port,
        '/api/auth/login',
        { password: WRONG_PASSWORD },
        headers,
      );
      expect(notYet.status).toBe(401);
      const relocked = await post(
        server.port,
        '/api/auth/login',
        { password: WRONG_PASSWORD },
        headers,
      );
      expect(relocked.status).toBe(429);
      expect(relocked.body.retryAfterSeconds).toBe(60);
    } finally {
      await server.close();
    }
  });

  it('enforces a per-IP ceiling and a separate global ceiling', async () => {
    let now = 1_700_000_000_000;
    const guard = new LoginAttemptGuard(
      guardConfig({ perIpMax: 2, globalMax: 3, failureThreshold: 100 }),
      () => now,
    );
    const app = loginApp(guard);
    const server = await listen(app);
    try {
      const a = { 'x-forwarded-for': '203.0.113.40' };
      const b = { 'x-forwarded-for': '203.0.113.41' };
      expect(
        (
          await post(
            server.port,
            '/api/auth/login',
            { password: WRONG_PASSWORD },
            a,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await post(
            server.port,
            '/api/auth/login',
            { password: WRONG_PASSWORD },
            a,
          )
        ).status,
      ).toBe(401);
      const perIp = await post(
        server.port,
        '/api/auth/login',
        { password: WRONG_PASSWORD },
        a,
      );
      expect(perIp.status).toBe(429);
      expect(perIp.headers['retry-after']).toBe('60');
      expect(perIp.body.retryAfterSeconds).toBe(60);
      expect(loggedLines()).toContain('scope=per_ip');

      const other = await post(
        server.port,
        '/api/auth/login',
        { password: 'correct-horse-battery' },
        b,
      );
      expect(other.status).toBe(200);
      expect(other.body).toEqual({ token: 'test-admin-token' });

      const globalHit = await post(
        server.port,
        '/api/auth/login',
        { password: 'correct-horse-battery' },
        {
          'x-forwarded-for': '203.0.113.42',
        },
      );
      expect(globalHit.status).toBe(429);
      expect(loggedLines()).toContain('scope=global');
    } finally {
      await server.close();
    }
  });

  it('ignores a spoofed X-Forwarded-For prefix when only one proxy hop is trusted', async () => {
    let now = 1_700_000_000_000;
    const guard = new LoginAttemptGuard(
      guardConfig({ perIpMax: 1, failureThreshold: 100 }),
      () => now,
    );
    const app = loginApp(guard, 1);
    const server = await listen(app);
    try {
      const first = await post(
        server.port,
        '/api/auth/login',
        { password: WRONG_PASSWORD },
        {
          'x-forwarded-for': '198.51.100.9, 203.0.113.50',
        },
      );
      expect(first.status).toBe(401);
      expect(loggedLines()).toContain('login failed ip=203.0.113.50 at=');

      const spoofed = await post(
        server.port,
        '/api/auth/login',
        { password: WRONG_PASSWORD },
        {
          'x-forwarded-for': '198.51.100.77, 203.0.113.50',
        },
      );
      expect(spoofed.status).toBe(429);
      expect(loggedLines()).toContain('scope=per_ip');
      expect(loggedLines()).not.toContain('198.51.100.77');

      const realOther = await post(
        server.port,
        '/api/auth/login',
        { password: 'correct-horse-battery' },
        {
          'x-forwarded-for': '198.51.100.77, 203.0.113.51',
        },
      );
      expect(realOther.status).toBe(200);
      expect(realOther.body).toEqual({ token: 'test-admin-token' });
    } finally {
      await server.close();
    }
  });

  it('does not let a direct client choose the key when trust proxy is off', async () => {
    const app = express();
    app.set(
      'trust proxy',
      resolveTrustProxyHops({ APEX_TRUST_PROXY_HOPS: '0' }),
    );
    app.get('/who', (req, res) => {
      res.json({ ip: clientAddress(req) });
    });
    const server = await listen(app);
    try {
      const result = await new Promise<HttpResult>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: server.port,
            path: '/who',
            method: 'GET',
            headers: { 'x-forwarded-for': '198.51.100.9' },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: JSON.parse(
                  Buffer.concat(chunks).toString('utf8'),
                ) as HttpResult['body'],
              });
            });
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body)).not.toContain('198.51.100.9');
    } finally {
      await server.close();
    }
  });

  it('fails closed for an IP that cannot be tracked', () => {
    let now = 1_700_000_000_000;
    const guard = new LoginAttemptGuard(guardConfig(), () => now, 1);
    expect(guard.admit('203.0.113.1').allowed).toBe(true);
    const overflow = guard.admit('203.0.113.2');
    expect(overflow.allowed).toBe(false);
    if (!overflow.allowed)
      expect(overflow.retryAfterSeconds).toBeGreaterThan(0);
    now += 1;
    expect(guard.admit('203.0.113.1').allowed).toBe(true);
  });

  it('keeps the login route on the constant-time helper and trusts a fixed hop count', () => {
    const route = readFileSync(join(here, '../routes/auth.ts'), 'utf8');
    const server = readFileSync(join(here, '../index.ts'), 'utf8');
    expect(route).toContain('passwordsMatch(');
    expect(route).not.toContain('parsed.data.password !==');
    expect(route).not.toContain('password ===');
    expect(server).toContain("app.set('trust proxy', resolveTrustProxyHops())");
    expect(server).not.toMatch(/trust proxy['"],\s*true/);
  });
});
