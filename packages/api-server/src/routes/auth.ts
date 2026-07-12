import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';

/**
 * POST /api/auth/login — exchange APEX_ADMIN_PASSWORD for the APEX_ADMIN_TOKEN.
 * This route is intentionally NOT behind requireAdminAuth (it's the front door).
 * The dashboard login screen calls this, stores the returned token, and sends
 * it as `Authorization: Bearer <token>` on every subsequent /api call.
 */
export function createAuthRouter() {
  const router = Router();

  router.post('/login', (req, res): void => {
    const configuredPassword = process.env.APEX_ADMIN_PASSWORD;
    const configuredToken = process.env.APEX_ADMIN_TOKEN;

    if (!configuredPassword || !configuredToken) {
      res.status(503).json({ error: 'Login not configured yet' });
      return;
    }

    const parsed = z.object({ password: z.string() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Password required' });
      return;
    }

    const given = Buffer.from(parsed.data.password);
    const expected = Buffer.from(configuredPassword);
    const ok =
      given.length === expected.length && crypto.timingSafeEqual(given, expected);

    if (!ok) {
      res.status(401).json({ error: 'Incorrect password' });
      return;
    }

    res.json({ token: configuredToken });
  });

  return router;
}
