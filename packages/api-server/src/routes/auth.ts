import { Router } from 'express';
import { z } from 'zod';

/**
 * POST /api/auth/login — exchange APEX_ADMIN_PASSWORD for APEX_ADMIN_TOKEN.
 * This route is intentionally not behind requireAdminAuth because it is the
 * dashboard's authentication entry point.
 *
 * Both credentials are deployment secrets. There is deliberately no password
 * or token fallback in source. Missing secrets fail authentication closed while
 * allowing the server and /health to start, so a configuration mistake is
 * observable without reviving a credential committed to source.
 */
export function createAuthRouter() {
  const router = Router();

  router.post('/login', (req, res): void => {
    try {
      const parsed = z.object({ password: z.string() }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Password required' });
        return;
      }

      const configuredPassword = process.env.APEX_ADMIN_PASSWORD;
      const configuredToken = process.env.APEX_ADMIN_TOKEN;
      if (!configuredPassword || !configuredToken) {
        console.error('[auth] APEX_ADMIN_PASSWORD/APEX_ADMIN_TOKEN are not fully configured');
        res.status(503).json({ error: 'Admin authentication is not configured' });
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
