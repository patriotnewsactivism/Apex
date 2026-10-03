/**
 * Operator CRM. Mounted behind requireAdminAuth. Do-not-contact can be
 * cleared only as Matthew, and merges require an explicit confirmation.
 */
import { Router } from 'express';
import {
  OPERATOR_ACTOR,
  attachUnmatched,
  contactsToCsv,
  duplicateSuggestions,
  getContact,
  getTimeline,
  gmailAuthUrl,
  gmailSyncEnabled,
  listUnmatched,
  mergeContacts,
  searchContacts,
  setDoNotContact,
  syncGmailReadonly,
} from '@workspace/core';
import { CRM_DISPLAY_TIMEZONE, formatChicago } from '@workspace/core';

function queryFlag(value: unknown): boolean | null {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

export function createCrmRouter(): Router {
  const router = Router();

  router.get('/contacts', async (req, res) => {
    try {
      const rows = await searchContacts({
        query: typeof req.query.q === 'string' ? req.query.q : null,
        tag: typeof req.query.tag === 'string' ? req.query.tag : null,
        city: typeof req.query.city === 'string' ? req.query.city : null,
        state: typeof req.query.state === 'string' ? req.query.state : null,
        verifiedOnly: req.query.verified === 'true',
        doNotContact: queryFlag(req.query.doNotContact),
        ownerBot: typeof req.query.ownerBot === 'string' ? req.query.ownerBot : null,
        lastContactedFrom: typeof req.query.lastContactedFrom === 'string' ? req.query.lastContactedFrom : null,
        lastContactedTo: typeof req.query.lastContactedTo === 'string' ? req.query.lastContactedTo : null,
        replied: queryFlag(req.query.replied),
        campaignId: typeof req.query.campaignId === 'string' ? req.query.campaignId : null,
      });
      res.json({
        timezone: CRM_DISPLAY_TIMEZONE,
        contacts: rows.map((row) => ({
          ...row,
          lastContactedChicago: row.lastContactedAt ? formatChicago(row.lastContactedAt) : null,
          lastReplyChicago: row.lastReplyAt ? formatChicago(row.lastReplyAt) : null,
        })),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/contacts/export', async (req, res) => {
    try {
      const rows = await searchContacts({
        query: typeof req.query.q === 'string' ? req.query.q : null,
        tag: typeof req.query.tag === 'string' ? req.query.tag : null,
        city: typeof req.query.city === 'string' ? req.query.city : null,
        state: typeof req.query.state === 'string' ? req.query.state : null,
        verifiedOnly: req.query.verified === 'true',
        doNotContact: queryFlag(req.query.doNotContact),
        ownerBot: typeof req.query.ownerBot === 'string' ? req.query.ownerBot : null,
        lastContactedFrom: typeof req.query.lastContactedFrom === 'string' ? req.query.lastContactedFrom : null,
        lastContactedTo: typeof req.query.lastContactedTo === 'string' ? req.query.lastContactedTo : null,
        replied: queryFlag(req.query.replied),
        campaignId: typeof req.query.campaignId === 'string' ? req.query.campaignId : null,
        limit: 500,
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.send(contactsToCsv(rows));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/contacts/:id', async (req, res) => {
    const found = await getContact(req.params.id);
    if (!found) {
      res.status(404).json({ error: 'Contact not found' });
      return;
    }
    const timeline = await getTimeline(req.params.id);
    res.json({
      ...found,
      timezone: CRM_DISPLAY_TIMEZONE,
      timeline: timeline.map((row) => ({
        ...row,
        occurredChicago: formatChicago(row.occurredAt),
      })),
    });
  });

  router.post('/contacts/:id/do-not-contact', async (req, res) => {
    const value = Boolean((req.body as { value?: boolean })?.value);
    const reason = typeof (req.body as { reason?: string })?.reason === 'string'
      ? (req.body as { reason: string }).reason
      : null;
    try {
      await setDoNotContact({ contactId: req.params.id, value, actor: OPERATOR_ACTOR, reason });
      res.json({ ok: true, actor: OPERATOR_ACTOR, value });
    } catch (error) {
      res.status(403).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/unmatched', async (_req, res) => {
    res.json(await listUnmatched());
  });

  router.post('/unmatched/:id/attach', async (req, res) => {
    const contactId = (req.body as { contactId?: string })?.contactId;
    if (!contactId) {
      res.status(400).json({ error: 'contactId is required' });
      return;
    }
    try {
      const timelineId = await attachUnmatched({ unmatchedId: req.params.id, contactId, actor: OPERATOR_ACTOR });
      res.json({ ok: true, timelineId });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/duplicates', async (_req, res) => {
    res.json(await duplicateSuggestions());
  });

  router.post('/merge', async (req, res) => {
    const body = (req.body ?? {}) as { winnerId?: string; loserId?: string; explicit?: boolean };
    if (!body.winnerId || !body.loserId) {
      res.status(400).json({ error: 'winnerId and loserId are required' });
      return;
    }
    try {
      await mergeContacts({
        winnerId: body.winnerId,
        loserId: body.loserId,
        explicit: body.explicit === true,
        actor: OPERATOR_ACTOR,
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/gmail/status', (_req, res) => {
    res.json({
      enabled: gmailSyncEnabled(),
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      sends: false,
    });
  });

  router.post('/gmail/sync', async (_req, res) => {
    const result = await syncGmailReadonly();
    res.json(result);
  });

  router.get('/gmail/oauth-url', (req, res) => {
    const url = gmailAuthUrl(typeof req.query.state === 'string' ? req.query.state : 'crm');
    if (!url) {
      res.status(409).json({ error: 'Gmail sync is disabled. Set APEX_CRM_GMAIL_SYNC=true plus Google OAuth variables.' });
      return;
    }
    res.json({ url });
  });

  return router;
}
