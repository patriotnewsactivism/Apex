/**
 * Operator CRM. Mounted behind requireAdminAuth. Do-not-contact can be
 * cleared only as Matthew, and merges require an explicit confirmation.
 */
import { Router, type Request, type Response } from 'express';
import { operatorDashboardSessionValid } from '../operator-session.js';
import {
  OPERATOR_ACTOR,
  attachUnmatched,
  contactsToCsv,
  duplicateSuggestions,
  getContact,
  getContactActivity,
  getTimeline,
  gmailAuthUrl,
  gmailSyncEnabled,
  listUnmatched,
  mergeContacts,
  searchContacts,
  searchResearchedLeads,
  setDoNotContact,
  syncGmailReadonly,
} from '@workspace/core';
import { CRM_DISPLAY_TIMEZONE, formatChicago } from '@workspace/core';

// Scripts and agents hold the admin bearer token too, so it alone cannot clear
// do-not-contact or merge contacts as Matthew. Those need the session minted at
// the dashboard password login, the same check the send safeguard uses.
async function requireOperatorSession(req: Request, res: Response): Promise<boolean> {
  const header = req.header('x-apex-operator-session');
  if (await operatorDashboardSessionValid(typeof header === 'string' ? header : null)) return true;
  res.status(403).json({ error: 'This needs an operator dashboard session. Sign in to the dashboard again.' });
  return false;
}

function queryFlag(value: unknown): boolean | null {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

/** Pull a bare hostname from a website/org string for site-scoped enrichment. */
function extractDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const host = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
    return host.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return trimmed.replace(/^https?:\/\//i, '').replace(/^www\./, '').split(/[/\s]/)[0]?.toLowerCase() || null;
  }
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
        industry: typeof req.query.industry === 'string' ? req.query.industry : null,
        called: queryFlag(req.query.called),
        emailed: queryFlag(req.query.emailed),
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

  // ─── GET /api/crm/leads — the researched-lead record type ──────────────────
  // Same facet shape as /contacts so ONE filter bar drives both lists: clients
  // only, researched leads only, or both. Everything found lands in the CRM.
  router.get('/leads', async (req, res) => {
    try {
      const rows = await searchResearchedLeads({
        query: typeof req.query.q === 'string' ? req.query.q : null,
        industry: typeof req.query.industry === 'string' ? req.query.industry : null,
        city: typeof req.query.city === 'string' ? req.query.city : null,
        pipelineState: typeof req.query.pipelineState === 'string' ? req.query.pipelineState : null,
        status: typeof req.query.status === 'string' ? req.query.status : null,
        called: queryFlag(req.query.called),
        emailed: queryFlag(req.query.emailed),
        campaignId: typeof req.query.campaignId === 'string' ? req.query.campaignId : null,
        limit: Math.min(Math.max(Number(req.query.limit) || 50, 1), 500),
      });
      res.json({ recordType: 'lead', leads: rows });
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
        industry: typeof req.query.industry === 'string' ? req.query.industry : null,
        called: queryFlag(req.query.called),
        emailed: queryFlag(req.query.emailed),
        limit: Math.min(Math.max(Number(req.query.limit) || 500, 1), 5000),
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.send(contactsToCsv(rows));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // ─── GET /api/crm/contacts/:id/export — full contact + activity CSV ───────
  // One row per timeline/activity event (agent sends, replies, calls, opt-outs,
  // merges, do-not-contact, code checks). Replays every interaction recorded
  // for this contact and its merged family, newest first, so you can pull the
  // complete agent history into a spreadsheet.
  router.get('/contacts/:id/export', async (req, res) => {
    try {
      const found = await getContact(req.params.id);
      if (!found) {
        res.status(404).json({ error: 'Contact not found' });
        return;
      }
      const { contact } = found;
      const timeline = await getTimeline(req.params.id);
      const escape = (v: string | null | undefined) => {
        if (v == null) return '';
        const s = String(v).replace(/\r?\n/g, ' \\n ');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const headers = [
        'contact_id', 'organization', 'name', 'email', 'phone', 'city', 'state', 'tags',
        'activity_at(chicago)', 'direction', 'channel', 'actor_type', 'actor_name', 'event_kind',
        'subject', 'body', 'provider_message_id', 'send_record',
      ];
      const rows = timeline.map((t) => [
        escape(contact.id),
        escape(contact.organizationName),
        escape([contact.firstName, contact.lastName].filter(Boolean).join(' ')),
        escape(contact.email),
        escape(contact.phoneE164),
        escape(contact.city),
        escape(contact.state),
        escape((contact.tags ?? []).join('|')),
        escape(formatChicago(t.occurredAt)),
        escape(t.direction),
        escape(t.channel),
        escape(t.actorType),
        escape(t.actorName),
        escape(t.eventKind),
        escape(t.subject),
        escape(t.bodyText),
        escape(t.providerMessageId),
        escape(t.sendRecordId ?? ''),
      ].join(','));
      const csv = [
        headers.map(escape).join(','),
        `#contact,${escape(contact.id)},${escape(contact.organizationName ?? '')},${escape(contact.email ?? '')},${escape(contact.phoneE164 ?? '')}`,
        ...rows,
      ].join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="contact-${contact.id}.csv"`);
      res.send(csv);
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
    // The client card needs EVERY logged interaction, not just contact_timeline
    // rows: emails, SMS and calls are merged in from their own tables so the
    // card shows one chronological history across all channels.
    const activity = await getContactActivity(req.params.id);
    res.json({
      ...found,
      timezone: CRM_DISPLAY_TIMEZONE,
      enrich: typeof req.query.enrich === 'string' ? req.query.enrich : null,
      timeline: timeline.map((row) => ({
        ...row,
        occurredChicago: formatChicago(row.occurredAt),
      })),
      activity: activity.map((row) => ({
        ...row,
        occurredChicago: formatChicago(row.occurredAt),
      })),
    });
  });

  // ─── GET /api/crm/contacts/:id/enrich — Brave LLM Context enrichment ─────
  // Returns the extracted content for the contact's organization/website plus
  // best-effort email/phone lines. Purely read-only: it queries Brave and
  // returns a payload; it does not modify the contact. The operator (or an
  // agent) decides what to persist. Falls back to the contact's organization
  // name when no website is stored.
  router.get('/contacts/:id/enrich', async (req, res) => {
    try {
      const found = await getContact(req.params.id);
      if (!found) {
        res.status(404).json({ error: 'Contact not found' });
        return;
      }
      const c = found.contact;
      const domain = extractDomain(c.website || c.organizationName || '');
      const query = domain
        ? `site:${domain} "${c.organizationName || ''}" contact phone email`
        : (c.organizationName ? `"${c.organizationName}" contact phone email` : null);
      if (!query) {
        res.status(400).json({ error: 'This contact has no website or organization name to enrich from.' });
        return;
      }
      const { braveLlmContext, parseContactFields } = await import('@workspace/core');
      const result = await braveLlmContext({ query, count: 20 });
      res.json({
        ok: result.ok,
        query,
        sources: result.sources,
        contacts: result.ok ? parseContactFields(result.sources) : null,
        diagnostics: result.diagnostics ?? [],
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/contacts/:id/do-not-contact', async (req, res) => {
    const value = Boolean((req.body as { value?: boolean })?.value);
    const reason = typeof (req.body as { reason?: string })?.reason === 'string'
      ? (req.body as { reason: string }).reason
      : null;
    // Setting do-not-contact only ever blocks sends, so it stays open; clearing it does not.
    if (!value && !(await requireOperatorSession(req, res))) return;
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
    if (!(await requireOperatorSession(req, res))) return;
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
