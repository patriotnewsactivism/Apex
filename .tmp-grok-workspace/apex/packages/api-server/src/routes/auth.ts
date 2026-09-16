import { Router } from 'express';
import { z } from 'zod';
import { validateAdminToken } from '../middleware/auth.js';
import { issueWebSocketTicket } from '../websocket-auth.js';

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

  /**
   * GET /api/auth/verify — is this bearer token still the configured one?
   *
   * APEX_ADMIN_TOKEN is a long-lived deployment secret, so a token the browser
   * stored under a previous value stays in localStorage and looks like a
   * session. The dashboard trusted its mere presence, rendered the full UI, and
   * then had every data call rejected — the operator saw a dashboard with no
   * agents and no leads rather than a login prompt.
   *
   * Mounted on the auth router, which sits in front of requireAdminAuth, so it
   * can answer 401 instead of being swallowed by it.
   */
  router.get('/verify', (req, res): void => {
    if (validateAdminToken(req.headers.authorization)) {
      res.json({ valid: true });
      return;
    }
    res.status(401).json({ error: 'Invalid token' });
  });

  /** Exchange the normal Authorization header for a single-use WS ticket. */
  router.post('/websocket-ticket', (req, res): void => {
    if (!validateAdminToken(req.headers.authorization)) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ticket: issueWebSocketTicket() });
  });

  return router;
}
