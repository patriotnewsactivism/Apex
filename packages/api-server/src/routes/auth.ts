import { Router } from 'express';
import { z } from 'zod';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set — no hardcoded fallback is used for admin credentials.`);
  }
  return value;
}

/**
 * POST /api/auth/login — exchange APEX_ADMIN_PASSWORD for APEX_ADMIN_TOKEN.
 * This route is intentionally not behind requireAdminAuth because it is the
 * dashboard's authentication entry point.
 *
 * Both credentials are deployment secrets. There is deliberately no password
 * or token fallback in source; a missing production secret must fail loudly
 * rather than silently activating a credential committed to a public repo.
 */
const configuredPassword = requireEnv('APEX_ADMIN_PASSWORD');
const configuredToken = requireEnv('APEX_ADMIN_TOKEN');

export function createAuthRouter() {
  const router = Router();

  router.post('/login', (req, res): void => {
    try {
      const parsed = z.object({ password: z.string() }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Password required' });
        return;
      }

      if (parsed.data.password !== configuredPassword) {
        res.status(401).json({ error: 'Incorrect password' });
        return;
      }

      res.json({ token: configuredToken });
    } catch (err) {
      console.error('[auth] Login error:', err);
      res.status(500).json({ error: 'Authentication processing error' });
    }
  });

  return router;
}
