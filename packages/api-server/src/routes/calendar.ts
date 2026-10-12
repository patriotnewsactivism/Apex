import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  authorizeCalWebhook,
  buildGoogleAuthUrl,
  calendarOrganizationId,
  CalendarNotConnectedError,
  calWebhookSecret,
  DoNotContactError,
  getCalendarBookingService,
  parseCalWebhook,
  saveGoogleCalendarConnection,
  signOauthState,
  SlotUnavailableError,
  verifyOauthState,
} from '@workspace/core';

// A Google invite staged by the booking service goes out only when the
// operator releases it in Pending sends; this transport delivers it then.
void import('@workspace/core').then(({ registerSendTransport, deliverReleasedCalendarInvite, GOOGLE_INVITE_KIND }) => {
  registerSendTransport(GOOGLE_INVITE_KIND, (jobId, recipient) =>
    deliverReleasedCalendarInvite(getCalendarBookingService(), jobId, recipient));
});

/**
 * Public calendar surface. Cal.com cannot send the admin bearer token, and
 * Google's OAuth redirect is a browser navigation. Both are mounted before
 * requireAdminAuth. The webhook is rejected before any booking work when the
 * signature or secret is missing.
 */
export function createCalendarPublicRouter(): Router {
  const router = Router();

  router.post('/cal/webhook', async (req, res) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const header = req.header('x-cal-signature-256') ?? undefined;
    const decision = authorizeCalWebhook(calWebhookSecret() ?? undefined, rawBody, header);
    if (!decision.ok) return res.status(decision.status).json({ error: decision.error });
    const booking = parseCalWebhook(req.body);
    if (!booking) return res.status(400).json({ error: 'Unrecognized calendar webhook' });
    try {
      const result = await getCalendarBookingService().ingestCalWebhook(calendarOrganizationId(), booking);
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[calendar] Cal.com webhook failed:', err instanceof Error ? err.message : err);
      return res.status(500).json({ error: 'Calendar webhook failed' });
    }
  });

  router.get('/google/callback', handleGoogleCalendarOauthCallback);

  return router;
}

/**
 * Google OAuth browser redirect handler.
 *
 * Google matches the redirect URI against the client registration EXACTLY, and
 * the Google client for this deployment is registered with
 * `https://apexwork.org/auth/callback` (no `/api/calendar` prefix). The root
 * path is therefore served by index.ts, mounted ahead of the dashboard static
 * fallback that would otherwise answer a browser navigation with index.html.
 * Both routes call this one implementation so they cannot drift apart.
 */
export async function handleGoogleCalendarOauthCallback(req: Request, res: Response): Promise<void> {
  const secret = process.env.APEX_ADMIN_TOKEN?.trim();
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!secret || !verifyOauthState(state, secret)) {
    res.status(401).type('text').send('Invalid OAuth state');
    return;
  }
  if (!code) {
    res.status(400).type('text').send('Missing authorization code');
    return;
  }
  try {
    const saved = await saveGoogleCalendarConnection(code);
    const who = saved.email ? ` as ${saved.email}` : '';
    res.type('html').send(
      `<!doctype html><title>Google Calendar connected</title><p>Google Calendar is connected to APEX${who}. Return to Settings.</p>`,
    );
  } catch (err) {
    console.error('[calendar] Google OAuth callback failed:', err instanceof Error ? err.message : err);
    res.status(502).type('text').send('Google authorization failed');
  }
}

const settingsSchema = z.object({
  timezone: z.string().min(1).max(80),
  workingHours: z.array(z.object({
    day: z.number().int().min(0).max(6),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  })).max(21),
  bufferBeforeMinutes: z.number().int().min(0).max(240),
  bufferAfterMinutes: z.number().int().min(0).max(240),
  noBookBlocks: z.array(z.object({
    id: z.string().min(1).max(80),
    start: z.string().min(1),
    end: z.string().min(1),
    label: z.string().max(120).optional(),
  })).max(100),
  maxMeetingsPerDay: z.number().int().min(1).max(48),
  minimumNoticeMinutes: z.number().int().min(0).max(10_080),
  holdMinutes: z.number().int().min(1).max(120),
  slotMinutes: z.number().int().min(5).max(240),
  busyCalendarIds: z.array(z.string().min(1).max(200)).max(50),
  bookingCalendarId: z.string().min(1).max(200).nullable(),
  agentColors: z.record(z.string().max(80), z.object({
    hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    googleColorId: z.string().regex(/^([1-9]|1[01])$/),
  })),
  operatorDisplayName: z.string().min(1).max(80),
});

const bookSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1),
  title: z.string().min(1).max(200),
  attendeeEmail: z.string().email().optional(),
  attendeeName: z.string().max(160).optional(),
  contactId: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
});

function fail(res: { status: (code: number) => { json: (body: unknown) => unknown } }, err: unknown) {
  if (err instanceof CalendarNotConnectedError) return res.status(503).json({ error: err.message });
  if (err instanceof DoNotContactError) return res.status(409).json({ error: err.message });
  if (err instanceof SlotUnavailableError) return res.status(409).json({ error: err.message });
  const message = err instanceof Error ? err.message : 'Calendar request failed';
  return res.status(500).json({ error: message });
}

/** Operator calendar API. Mounted behind requireAdminAuth. */
export function createCalendarRouter(): Router {
  const router = Router();

  router.get('/status', async (_req, res) => {
    try {
      const status = await getCalendarBookingService().connectionStatus(calendarOrganizationId());
      return res.json(status);
    } catch (err) {
      return fail(res, err);
    }
  });

  router.get('/agenda', async (req, res) => {
    const start = new Date(typeof req.query.start === 'string' ? req.query.start : Date.now());
    const end = new Date(typeof req.query.end === 'string' ? req.query.end : start.getTime() + 7 * 86_400_000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: 'start and end must be ISO timestamps' });
    }
    try {
      const items = await getCalendarBookingService().agenda(calendarOrganizationId(), start, end);
      return res.json({ items, timezone: 'America/Chicago' });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.get('/settings', async (_req, res) => {
    try {
      const service = getCalendarBookingService();
      const organizationId = calendarOrganizationId();
      const [settings, status] = await Promise.all([
        service.getSettings(organizationId),
        service.connectionStatus(organizationId),
      ]);
      return res.json({ settings, status });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.put('/settings', async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid calendar settings' });
    try {
      const settings = await getCalendarBookingService().saveSettings(calendarOrganizationId(), parsed.data);
      return res.json({ settings });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.get('/google/start', (_req, res) => {
    const secret = process.env.APEX_ADMIN_TOKEN?.trim();
    if (!secret) return res.status(503).json({ error: 'APEX_ADMIN_TOKEN is not set' });
    const url = buildGoogleAuthUrl(signOauthState(secret));
    if (!url) return res.status(503).json({ error: 'Google OAuth client id, secret, and redirect URI are required' });
    return res.json({ url });
  });

  router.get('/google/calendars', async (_req, res) => {
    try {
      const calendars = await getCalendarBookingService().listCalendars();
      return res.json({ calendars });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post('/book', async (req, res) => {
    const parsed = bookSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'start, end, and title are required' });
    const start = new Date(parsed.data.start);
    const end = new Date(parsed.data.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: 'start and end must be ISO timestamps' });
    }
    try {
      const service = getCalendarBookingService();
      const settings = await service.getSettings(calendarOrganizationId());
      const result = await service.book({
        organizationId: calendarOrganizationId(),
        start,
        end,
        title: parsed.data.title,
        attendeeEmail: parsed.data.attendeeEmail ?? null,
        attendeeName: parsed.data.attendeeName ?? null,
        contactId: parsed.data.contactId ?? null,
        notes: parsed.data.notes ?? null,
        actor: { kind: 'operator', id: null, name: settings.operatorDisplayName || 'Matthew' },
      });
      return res.json({
        meetingId: result.meeting.id,
        inviteSent: false,
        inviteSendJobId: result.invite?.sendJobId ?? null,
        inviteBlockedReason: result.invite?.blockedReason ?? null,
        googleSendUpdates: result.googleSendUpdates,
      });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post('/reschedule', async (req, res) => {
    const parsed = z.object({
      meetingId: z.string().uuid(),
      start: z.string().min(1),
      end: z.string().min(1),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'meetingId, start, and end are required' });
    try {
      const service = getCalendarBookingService();
      const settings = await service.getSettings(calendarOrganizationId());
      const meeting = await service.reschedule(
        calendarOrganizationId(),
        parsed.data.meetingId,
        new Date(parsed.data.start),
        new Date(parsed.data.end),
        { kind: 'operator', id: null, name: settings.operatorDisplayName || 'Matthew' },
      );
      return res.json({ meetingId: meeting.id, inviteSent: false });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post('/cancel', async (req, res) => {
    const parsed = z.object({ meetingId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'meetingId is required' });
    try {
      const service = getCalendarBookingService();
      const settings = await service.getSettings(calendarOrganizationId());
      const meeting = await service.cancel(
        calendarOrganizationId(),
        parsed.data.meetingId,
        { kind: 'operator', id: null, name: settings.operatorDisplayName || 'Matthew' },
      );
      return res.json({ meetingId: meeting.id, status: meeting.status, inviteSent: false });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post('/no-show', async (req, res) => {
    const parsed = z.object({ meetingId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'meetingId is required' });
    try {
      const service = getCalendarBookingService();
      const settings = await service.getSettings(calendarOrganizationId());
      const meeting = await service.markNoShow(
        calendarOrganizationId(),
        parsed.data.meetingId,
        { kind: 'operator', id: null, name: settings.operatorDisplayName || 'Matthew' },
      );
      return res.json({ meetingId: meeting.id, status: meeting.status });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.get('/contacts/:id/timeline', async (req, res) => {
    try {
      const rows = await getCalendarBookingService().contactTimeline(calendarOrganizationId(), req.params.id);
      return res.json({
        contactId: req.params.id,
        timezone: 'America/Chicago',
        rows: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          actorName: row.actorName,
          actorKind: row.actorKind,
          occurredAt: row.occurredAt.toISOString(),
          timezone: row.timezone,
          summary: row.summary,
          meetingId: row.meetingId,
        })),
      });
    } catch (err) {
      return fail(res, err);
    }
  });

  return router;
}
