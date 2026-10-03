// Operator-only controls for the send safeguard. Code entry, confirms, stop,
// unlock, and code changes require a dashboard session minted at password login.
// The admin bearer token alone is not enough.

import { Router } from 'express';
import type { Request } from 'express';
import { passwordsMatch } from '../login-guard.js';
import { operatorDashboardSessionValid } from '../operator-session.js';
import {
  classifySendCaller,
  getSendSafeguard,
  runWithSendCaller,
  SendSafeguardError,
  dispatchClearedSendJob,
  dispatchReleasedRecipient,
  type SendCaller,
} from '@workspace/core';

function headerValue(req: Request, name: string): string {
  const value = req.header(name);
  return typeof value === 'string' ? value : '';
}

async function callerFor(req: Request): Promise<SendCaller> {
  const declared = headerValue(req, 'x-apex-caller') || (typeof req.body?.source === 'string' ? req.body.source : '');
  const session = headerValue(req, 'x-apex-operator-session');
  const operatorSessionValid = await operatorDashboardSessionValid(session);
  return classifySendCaller({ declared, operatorSessionValid });
}

function fail(res: { status: (code: number) => { json: (body: unknown) => void } }, error: unknown): void {
  if (error instanceof SendSafeguardError) {
    const status = error.reason === 'operator_session_required' || error.reason === 'code_source_rejected' ? 403 : 409;
    res.status(status).json({ error: error.message, reason: error.reason, jobId: error.jobId });
    return;
  }
  console.error('[send-safeguard] request failed', error instanceof Error ? error.message : 'error');
  res.status(500).json({ error: 'Send safeguard request failed.' });
}

export function createSendSafeguardRouter(): Router {
  const router = Router();

  router.get('/jobs', async (_req, res) => {
    try {
      const engine = await getSendSafeguard();
      const jobs = await engine.list();
      const locked = await engine.isLocked();
      res.json({
        locked,
        jobs: jobs.map(({ job, recipients }) => ({
          ...job,
          count: recipients.filter((row) => row.status !== 'voided').length,
          recipients: recipients.map((row) => ({
            id: row.id,
            channel: row.channel,
            destination: row.destination,
            messageText: row.messageText,
            status: row.status,
            released: row.released,
          })),
        })),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/jobs/:id', async (req, res) => {
    try {
      const engine = await getSendSafeguard();
      const described = await engine.describe(req.params.id);
      res.json(described);
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/jobs/:id/full-auto', async (req, res) => {
    try {
      const caller = await callerFor(req);
      const engine = await getSendSafeguard();
      const job = await runWithSendCaller(caller, () => engine.setFullAuto(req.params.id, caller, req.body?.fullAuto === true));
      res.json({ job });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/jobs/:id/confirm', async (req, res) => {
    try {
      const caller = await callerFor(req);
      const step = req.body?.step === 2 ? 2 : req.body?.step === 1 ? 1 : 0;
      if (step !== 1 && step !== 2) {
        res.status(400).json({ error: 'Confirm step must be 1 or 2.' });
        return;
      }
      const engine = await getSendSafeguard();
      const job = await runWithSendCaller(caller, () => engine.confirm(req.params.id, caller, step));
      if (job.status === 'sending' && job.fullAuto) {
        await runWithSendCaller('operator-dashboard', () => dispatchClearedSendJob(job.id));
      }
      res.json({ job });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/jobs/:id/code', async (req, res) => {
    try {
      const caller = await callerFor(req);
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const engine = await getSendSafeguard();
      const job = await runWithSendCaller(caller, () => engine.submitCode(req.params.id, caller, code));
      if (job.status === 'sending' && job.fullAuto) {
        await runWithSendCaller('operator-dashboard', () => dispatchClearedSendJob(job.id));
      }
      res.json({ job });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/jobs/:id/release', async (req, res) => {
    try {
      const caller = await callerFor(req);
      const recipientId = typeof req.body?.recipientId === 'string' ? req.body.recipientId : '';
      const engine = await getSendSafeguard();
      const recipient = await runWithSendCaller(caller, () => engine.release(req.params.id, caller, recipientId));
      const dispatched = await runWithSendCaller('operator-dashboard', () => dispatchReleasedRecipient(req.params.id, recipient.id));
      res.json({ recipient, dispatched });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/jobs/:id/stop', async (req, res) => {
    try {
      const caller = await callerFor(req);
      const engine = await getSendSafeguard();
      const job = await runWithSendCaller(caller, () => engine.stop(req.params.id, caller));
      res.json({ job });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/code', async (req, res) => {
    try {
      const caller = await callerFor(req);
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const configured = process.env.APEX_ADMIN_PASSWORD;
      const passwordOk = Boolean(configured && passwordsMatch(password, configured));
      const engine = await getSendSafeguard();
      await runWithSendCaller(caller, () => engine.setCode(caller, code, passwordOk));
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/unlock', async (req, res) => {
    try {
      const caller = await callerFor(req);
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const configured = process.env.APEX_ADMIN_PASSWORD;
      const passwordOk = Boolean(configured && passwordsMatch(password, configured));
      const engine = await getSendSafeguard();
      await runWithSendCaller(caller, () => engine.unlock(caller, passwordOk));
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/status', async (_req, res) => {
    try {
      const engine = await getSendSafeguard();
      res.json({ locked: await engine.isLocked() });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
