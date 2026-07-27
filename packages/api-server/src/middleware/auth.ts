import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

/**
 * Locks down every /api/* route behind a bearer token.
 *
 * Was previously WIDE OPEN: cors({ origin: '*' }) + zero auth checks meant
 * anyone who found the public Railway URL could approve/reject actions,
 * create goals/tasks, or hit tools — a live control-plane exposure.
 *
 * APEX_ADMIN_TOKEN is the long-lived secret sent as `Authorization: Bearer <token>`.
 * /api/auth/login (routes/auth.ts) lets a human exchange a memorable
 * APEX_ADMIN_PASSWORD for this token, for a future login UI — the token
 * itself is what's actually checked here, the password is just the
 * human-friendly front door to it.
 *
 * No hardcoded fallback: a fallback secret baked into source is a secret
 * that isn't one (this repo's fallback used to be the actual live admin
 * password). Fail startup instead if the env var is missing.
 */
const configuredToken = requireEnv('APEX_ADMIN_TOKEN');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set — no hardcoded fallback is used for admin credentials.`);
  }
  return value;
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }

  if (token.length !== configuredToken.length) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  // constant-time compare
  const a = Buffer.from(token);
  const b = Buffer.from(configuredToken);
  if (!crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  next();
}
