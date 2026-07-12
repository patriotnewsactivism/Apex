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
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredToken = process.env.APEX_ADMIN_TOKEN;

  if (!configuredToken) {
    console.error('[auth] APEX_ADMIN_TOKEN not set — refusing all /api requests');
    res.status(503).json({ error: 'Admin auth not configured' });
    return;
  }

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
