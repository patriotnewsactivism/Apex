import { Router } from 'express';
import {
  getOpenRouterBalanceMonitorStatus,
  refreshProviderCredits,
  restoreOpenRouterKeyLimitForAccount,
} from '@workspace/core';

/**
 * Operator surface for the OpenRouter balance monitor. Mounted under
 * /api/settings (behind requireAdminAuth).
 *
 *   GET  /api/settings/openrouter-balance                    status (same as health detail)
 *   POST /api/settings/openrouter-balance/check              run a balance check now
 *   POST /api/settings/openrouter-balance/:account/restore-key-limit
 *        put the saved prior OpenRouter key limit back. The monitor itself
 *        never raises a key limit; this is the only path that does.
 */
export function createOpenRouterBalanceRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(getOpenRouterBalanceMonitorStatus());
  });

  router.post('/check', async (_req, res) => {
    try {
      await refreshProviderCredits();
      res.json(getOpenRouterBalanceMonitorStatus());
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : 'balance check failed' });
    }
  });

  router.post('/:account/restore-key-limit', async (req, res) => {
    const account = String(req.params.account ?? '');
    if (!/^oracct_[0-9a-f]{8}$/.test(account)) {
      res.status(400).json({ error: 'account must look like oracct_<8 hex>' });
      return;
    }
    const operator = typeof req.body?.operator === 'string' && req.body.operator.trim()
      ? req.body.operator.trim().slice(0, 80)
      : 'operator';
    const result = await restoreOpenRouterKeyLimitForAccount(account, operator);
    res.status(result.ok ? 200 : 409).json({ ...result, status: getOpenRouterBalanceMonitorStatus() });
  });

  return router;
}
