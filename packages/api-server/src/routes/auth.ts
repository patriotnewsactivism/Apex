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
    try {
      const configuredPassword = process.env.APEX_ADMIN_PASSWORD || 'Mr03241987$';
      const configuredToken = process.env.APEX_ADMIN_TOKEN || 'apex-admin-secret-token';

      const parsed = z.object({ password: z.string() }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Password required' });
        return;
      }

      const isMatch = parsed.data.password === configuredPassword;

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
