import { Router } from 'express';
import { z } from 'zod';
import {
  confirmSendJob,
  createSendJob,
  ensureProductionSendSafeguard,
  getOperatorSafeguardSettings,
  getSendJobView,
  isSendSafeguardError,
  listSendJobs,
  OPERATOR_DASHBOARD_CLIENT,
  releaseRecipient,
  SEND_CHANNELS,
  setJobFullAuto,
  setOperatorCode,
  stopSendJob,
  submitSafeguardCode,
  unlockSafeguard,
  type SendChannel,
  type SendSafeguardSession,
} from '@workspace/core';
import { requestAuthKind } from '../middleware/auth.js';
import { passwordsMatch } from '../login-guard.js';
import { validateOperatorSession } from '../operator-session.js';

const recipientSchema = z.object({
  channel: z.enum(['email', 'call', 'sms', 'calendar']),
  destination: z.string().min(1).max(320),
  messageText: z.string().min(1).max(50_000),
  payload: z.record(z.string(), z.unknown()).optional(),
});

function operatorSessionFromRequest(req: { headers: Record<string, unknown>; }): SendSafeguardSession {
  const client = String(req.headers['x-apex-client'] ?? '');
  const kindHeader = String(req.headers['x-apex-session-kind'] ?? '');
  const ticket = String(req.headers['x-apex-operator-session'] ?? '');
  const authKind = requestAuthKind(req as never);
  const operatorSessionValid = validateOperatorSession(ticket);
  const isDashboard = client === OPERATOR_DASHBOARD_CLIENT && kindHeader === 'operator';
  if (authKind === 'admin' && isDashboard && operatorSessionValid) {
    return {
      actor: 'operator_dashboard',
      client: OPERATOR_DASHBOARD_CLIENT,
      authKind: 'admin',
      operatorSessionValid: true,
    };
  }
  if (authKind && authKind !== 'admin') {
    return { actor: 'bot_token', client, authKind: 'bot_token', operatorSessionValid: false };
  }
  return {
    actor: isDashboard ? 'unknown' : 'unknown',
    client,
    authKind: authKind === 'admin' ? 'admin' : 'none',
    operatorSessionValid: false,
  };
}

function fail(res: { status: (n: number) => { json: (b: unknown) => void } }, error: unknown): void {
  if (isSendSafeguardError(error)) {
    const status = error.code === 'operator_only' || error.code === 'code_source_rejected'
      ? 403
      : error.code === 'job_not_found'
        ? 404
        : 409;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : String(error), code: 'fail_closed' });
}

function requireOperatorPassword(password: unknown): string | null {
  const configured = process.env.APEX_ADMIN_PASSWORD;
  if (!configured) return 'Admin authentication is not configured';
  if (typeof password !== 'string' || !password) return 'Operator password is required';
  if (!passwordsMatch(password, configured)) return 'Incorrect password';
  return null;
}

export function createSendSafeguardRouter(): Router {
  const router = Router();

  router.use(async (_req, res, next) => {
    try {
      await ensureProductionSendSafeguard();
      next();
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/jobs', async (_req, res) => {
    try {
      res.json({ jobs: await listSendJobs() });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/jobs/:id', async (req, res) => {
    try {
      res.json(await getSendJobView(req.params.id));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/jobs', async (req, res) => {
    try {
      const parsed = z.object({
        recipients: z.array(recipientSchema).min(1).max(500),
        campaignKey: z.string().max(200).optional().nullable(),
        storyKey: z.string().max(200).optional().nullable(),
        messageText: z.string().max(50_000).optional(),
        fullAuto: z.boolean().optional(),
      }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid send job' });
        return;
      }
      const job = await createSendJob({
        ...parsed.data,
        createdBy: 'operator',
      });
      res.status(201).json(await getSendJobView(job.id));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/jobs/:id/full-auto', async (req, res) => {
    try {
      const fullAuto = Boolean(req.body?.fullAuto);
      const job = await setJobFullAuto(req.params.id, fullAuto, operatorSessionFromRequest(req));
      res.json(await getSendJobView(job.id));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/jobs/:id/confirm', async (req, res) => {
    try {
      const step = req.body?.step === 2 ? 2 : req.body?.step === 1 ? 1 : null;
      if (!step) {
        res.status(400).json({ error: 'step must be 1 or 2' });
        return;
      }
      const job = await confirmSendJob(req.params.id, step, operatorSessionFromRequest(req));
      res.json(await getSendJobView(job.id));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/jobs/:id/code', async (req, res) => {
    try {
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const job = await submitSafeguardCode(req.params.id, code, operatorSessionFromRequest(req));
      res.json(await getSendJobView(job.id));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/jobs/:id/stop', async (req, res) => {
    try {
      const job = await stopSendJob(req.params.id, operatorSessionFromRequest(req));
      res.json(await getSendJobView(job.id));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/jobs/:id/release/:recipientId', async (req, res) => {
    try {
      await releaseRecipient(req.params.id, req.params.recipientId, operatorSessionFromRequest(req));
      res.json(await getSendJobView(req.params.id));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/settings', async (_req, res) => {
    try {
      res.json(await getOperatorSafeguardSettings());
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/settings/code', async (req, res) => {
    try {
      const session = operatorSessionFromRequest(req);
      if (session.actor !== 'operator_dashboard') {
        res.status(403).json({ error: 'Only the operator dashboard can set the send code', code: 'operator_only' });
        return;
      }
      const passwordError = requireOperatorPassword(req.body?.password);
      if (passwordError) {
        res.status(401).json({ error: passwordError });
        return;
      }
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      await setOperatorCode(code);
      res.json(await getOperatorSafeguardSettings());
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/unlock', async (req, res) => {
    try {
      const session = operatorSessionFromRequest(req);
      if (session.actor !== 'operator_dashboard') {
        res.status(403).json({ error: 'Only the operator dashboard can unlock sending', code: 'operator_only' });
        return;
      }
      const passwordError = requireOperatorPassword(req.body?.password);
      if (passwordError) {
        res.status(401).json({ error: passwordError });
        return;
      }
      await unlockSafeguard();
      res.json(await getOperatorSafeguardSettings());
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}

export function channelFromUnknown(value: string): SendChannel | null {
  return (SEND_CHANNELS as readonly string[]).includes(value) ? value as SendChannel : null;
}
