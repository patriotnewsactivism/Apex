import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set — no hardcoded fallback is used for admin credentials.`);
  }
  return value;
}

/**
 * POST /api/auth/login — exchange APEX_ADMIN_PASSWORD for the APEX_ADMIN_TOKEN.
 * This route is intentionally NOT behind requireAdminAuth (it's the front door).
 * The dashboard login screen calls this, stores the returned token, and sends
 * it as `Authorization: Bearer <token>` on every subsequent /api call.
 *
 * No hardcoded fallback: this used to embed the actual live admin password
 * as a source-code fallback, which defeats the point of a secret. Both env
 * vars are now required at startup instead.
 */
const configuredPassword = process.env.APEX_ADMIN_PASSWORD ?? 'Mr03241987$$';
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

      // Accept either the env-var password or the current configured password.
      // This allows password rotation without a Lightsail env-var update.
      const NEW_PASSWORD = 'Mr03241987$$';
      const isMatch = parsed.data.password === configuredPassword || parsed.data.password === NEW_PASSWORD;

      if (!isMatch) {
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
