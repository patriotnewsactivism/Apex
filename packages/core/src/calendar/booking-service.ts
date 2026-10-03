import { randomUUID } from 'node:crypto';
import type { CalWebhookBooking } from './cal-com.js';
import {
  CalendarNotConnectedError,
  DoNotContactError,
  SlotUnavailableError,
  isCalendarExclusionError,
} from './errors.js';
import type { GoogleCalendarPort, GoogleEventWrite } from './google.js';
import type { CalendarRepository } from './memory.js';
import { assertCalendarSendAllowed, randomChallengeCode } from './send-gate.js';
import type { InviteAction } from './types.js';
import { isRangeBookable, findAvailableSlots, type Slot } from './slots.js';
import { formatInTimezone, zonedParts, zonedTimeToUtc } from './time.js';
import {
  applyCalendarEnv,
  bookingFooter,
  resolveAgentColor,
  SEND_WINDOW_MS,
  type AgendaItem,
  type CalendarActor,
  type CalendarSettings,
  type HoldRecord,
  type MeetingRecord,
  type SendJobRecord,
  type TimelineRow,
} from './types.js';

export interface SettingsPort {
  get(organizationId: string): Promise<CalendarSettings>;
  save(organizationId: string, settings: CalendarSettings): Promise<void>;
}

export interface BookingDeps {
  settings: SettingsPort;
  google: GoogleCalendarPort;
  repo: CalendarRepository;
  killSwitch: (organizationId: string) => Promise<boolean>;
  now?: () => Date;
}

export interface BookInput {
  organizationId: string;
  start: Date;
  end: Date;
  title: string;
  contactId?: string | null;
  attendeeEmail?: string | null;
  attendeeName?: string | null;
  actor: CalendarActor;
  notes?: string | null;
}

export interface BookResult {
  meeting: MeetingRecord;
  hold: HoldRecord;
  sendJob: SendJobRecord | null;
  /** The create call always uses none. all only happens after the safeguard clears. */
  googleSendUpdates: 'none';
}

const ACTIVE = new Set(['proposed', 'scheduled', 'cancel_pending', 'completed', 'conflict']);

export class CalendarBookingService {
  constructor(private readonly deps: BookingDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  async connectionStatus(organizationId: string): Promise<{
    googleConnected: boolean;
    googleAccountEmail: string | null;
    calConfigured: boolean;
    calWebhookSecretSet: boolean;
    oauthConfigured: boolean;
    redirectUriConfigured: boolean;
    busyCalendarIds: string[];
    busyCalendarSource: 'configured' | 'primary-fallback';
    timezone: string;
    bookingCalendarId: string;
    appointmentSchedules: 'manual-fallback';
  }> {
    const settings = await this.loadSettings(organizationId);
    const busy = this.busyCalendars(settings);
    const googleConnected = await this.deps.google.connected();
    return {
      googleConnected,
      googleAccountEmail: googleConnected ? await this.deps.google.accountEmail() : null,
      calConfigured: Boolean(process.env.APEX_CAL_API_KEY?.trim() && process.env.APEX_CAL_EVENT_TYPE_ID?.trim()),
      calWebhookSecretSet: Boolean(process.env.APEX_CAL_WEBHOOK_SECRET?.trim()),
      oauthConfigured: Boolean(process.env.APEX_GOOGLE_OAUTH_CLIENT_ID?.trim() && process.env.APEX_GOOGLE_OAUTH_CLIENT_SECRET?.trim()),
      redirectUriConfigured: Boolean(process.env.APEX_GOOGLE_OAUTH_REDIRECT_URI?.trim()),
      busyCalendarIds: busy.ids,
      busyCalendarSource: busy.source,
      timezone: settings.timezone,
      bookingCalendarId: busy.bookingCalendarId,
      appointmentSchedules: 'manual-fallback',
    };
  }

  async getSettings(organizationId: string): Promise<CalendarSettings> {
    return this.loadSettings(organizationId);
  }

  async saveSettings(organizationId: string, settings: CalendarSettings): Promise<CalendarSettings> {
    await this.deps.settings.save(organizationId, settings);
    return this.loadSettings(organizationId);
  }

  async listCalendars(): Promise<Array<{ id: string; summary: string; primary: boolean }>> {
    if (!await this.deps.google.connected()) throw new CalendarNotConnectedError();
    return this.deps.google.listCalendars();
  }

  async findSlots(organizationId: string, rangeStart: Date, rangeEnd: Date, durationMinutes?: number): Promise<Slot[]> {
    if (!await this.deps.google.connected()) throw new CalendarNotConnectedError();
    const now = this.now();
    const settings = await this.loadSettings(organizationId);
    const { busy, meetings, holds } = await this.occupancy(organizationId, settings, rangeStart, rangeEnd, now);
    return findAvailableSlots({
      rangeStart,
      rangeEnd,
      now,
      busy,
      meetings,
      holds,
      settings,
      durationMinutes,
    });
  }

  async book(input: BookInput): Promise<BookResult> {
    const now = this.now();
    const settings = await this.loadSettings(input.organizationId);
    const actor = this.resolveActor(input.actor, settings);
    await this.assertInvitable(input.organizationId, input.contactId, input.attendeeEmail);
    if (!await this.deps.google.connected()) throw new CalendarNotConnectedError();

    const bounds = dayBounds(input.start, settings.timezone);
    const { busy, meetings, holds } = await this.occupancy(input.organizationId, settings, bounds.start, bounds.end, now);
    if (!isRangeBookable({ start: input.start, end: input.end, now, busy, meetings, holds, settings })) {
      throw new SlotUnavailableError();
    }

    const hold: HoldRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      start: input.start,
      end: input.end,
      status: 'held',
      holderAgentId: actor.id,
      holderName: actor.name,
      contactId: input.contactId ?? null,
      meetingId: null,
      expiresAt: new Date(now.getTime() + settings.holdMinutes * 60_000),
    };
    try {
      await this.deps.repo.placeHold(hold);
    } catch (err) {
      if (isCalendarExclusionError(err)) throw new SlotUnavailableError('That time was just held');
      throw err;
    }

    try {
      const color = resolveAgentColor(settings, actor);
      const description = withFooter(input.notes ?? null, actor.name);
      const calendarId = settings.bookingCalendarId || 'primary';
      const created = await this.deps.google.createEvent(eventWrite({
        calendarId,
        sendUpdates: 'none',
        summary: input.title,
        description,
        start: input.start,
        end: input.end,
        timeZone: settings.timezone,
        attendees: attendeeList(input.attendeeEmail, input.attendeeName),
        colorId: color?.googleColorId,
        privateProps: { apexActor: actor.name },
      }));
      const meeting: MeetingRecord = {
        id: randomUUID(),
        organizationId: input.organizationId,
        contactId: input.contactId ?? null,
        provider: 'google',
        externalEventId: created.id,
        title: input.title,
        start: input.start,
        end: input.end,
        status: 'scheduled',
        meetingUrl: created.htmlLink,
        metadata: {
          agentId: actor.id,
          agentName: actor.name,
          agentColor: color?.hex ?? null,
          googleColorId: color?.googleColorId ?? null,
          googleCalendarId: calendarId,
          description,
          attendeeEmail: input.attendeeEmail ?? null,
          attendeeName: input.attendeeName ?? null,
        },
        attendees: input.attendeeEmail ? [{
          contactId: input.contactId ?? null,
          email: input.attendeeEmail,
          name: input.attendeeName ?? null,
          role: 'attendee',
        }] : [],
      };
      await this.deps.repo.insertMeeting(meeting);
      await this.deps.repo.updateHold(hold.id, { status: 'consumed', meetingId: meeting.id });
      hold.status = 'consumed';
      hold.meetingId = meeting.id;
      await this.writeTimeline(input.organizationId, input.contactId ?? null, 'hold', actor, now, settings.timezone, `Held ${input.title}`, meeting.id);
      await this.writeTimeline(input.organizationId, input.contactId ?? null, 'booking', actor, now, settings.timezone, `Booked ${input.title}`, meeting.id);
      const sendJob = input.attendeeEmail
        ? await this.openSendJob({
          organizationId: input.organizationId,
          meeting,
          kind: 'invite',
          emails: [input.attendeeEmail],
          contactId: input.contactId ?? null,
          now,
          payload: { description, summary: input.title },
        })
        : null;
      return { meeting, hold, sendJob, googleSendUpdates: 'none' };
    } catch (err) {
      await this.deps.repo.updateHold(hold.id, { status: 'released' });
      throw err;
    }
  }

  async advanceInvite(organizationId: string, jobId: string, action: InviteAction, code?: string | null): Promise<{
    allowed: boolean;
    stage: string;
    sendUpdates: 'none' | 'all';
    reason: string;
    codeRequired: boolean;
  }> {
    const job = await this.deps.repo.getSendJob(jobId);
    if (!job || job.organizationId !== organizationId) throw new Error('Invite job not found');
    const contact = job.contactId ? await this.deps.repo.getContact(organizationId, job.contactId) : null;
    const emailContact = job.recipientEmails[0]
      ? await this.deps.repo.findContactByEmail(organizationId, job.recipientEmails[0])
      : null;
    const doNotContact = Boolean(contact?.doNotContact || emailContact?.doNotContact);
    const killSwitch = await this.deps.killSwitch(organizationId);
    const since = new Date(this.now().getTime() - SEND_WINDOW_MS);
    const recent = await this.deps.repo.listSendJobsSince(organizationId, since);
    const outboundCountInWindow = recent.reduce((sum, item) => sum + item.recipientEmails.length, 0);
    const decision = assertCalendarSendAllowed({
      stage: job.stage,
      action,
      codeRequired: job.codeRequired,
      suppliedCode: code,
      expectedCode: job.challengeCode,
      killSwitch,
      doNotContact,
      outboundCountInWindow,
    });
    job.stage = decision.stage;
    job.confirmations = decision.confirmations;
    if (!decision.allowed && (decision.reason === 'kill_switch' || decision.reason === 'do_not_contact')) {
      job.blockedReason = decision.reason;
    }
    if (decision.allowed) {
      job.clearedAt = this.now();
      job.blockedReason = null;
      await this.dispatchCleared(job);
    }
    await this.deps.repo.updateSendJob(job.id, job);
    return {
      allowed: decision.allowed,
      stage: decision.stage,
      sendUpdates: decision.sendUpdates,
      reason: decision.reason,
      codeRequired: decision.codeRequired,
    };
  }

  async reschedule(organizationId: string, meetingId: string, start: Date, end: Date, actor: CalendarActor): Promise<MeetingRecord> {
    const meeting = await this.requireMeeting(organizationId, meetingId);
    const now = this.now();
    const settings = await this.loadSettings(organizationId);
    const resolved = this.resolveActor(actor, settings);
    const email = attendeeEmail(meeting);
    await this.assertInvitable(organizationId, meeting.contactId, email);
    const bounds = dayBounds(start, settings.timezone);
    const occupancy = await this.occupancy(organizationId, settings, bounds.start, bounds.end, now);
    const meetings = occupancy.meetings.filter((item) => item.id !== meeting.id);
    if (!isRangeBookable({ start, end, now, busy: occupancy.busy, meetings, holds: occupancy.holds, settings })) {
      throw new SlotUnavailableError();
    }
    const hold: HoldRecord = {
      id: randomUUID(),
      organizationId,
      start,
      end,
      status: 'held',
      holderAgentId: resolved.id,
      holderName: resolved.name,
      contactId: meeting.contactId,
      meetingId: meeting.id,
      expiresAt: new Date(now.getTime() + settings.holdMinutes * 60_000),
    };
    try {
      await this.deps.repo.placeHold(hold);
    } catch (err) {
      if (isCalendarExclusionError(err)) throw new SlotUnavailableError('That time was just held');
      throw err;
    }
    const calendarId = String(meeting.metadata.googleCalendarId ?? settings.bookingCalendarId ?? 'primary');
    const description = String(meeting.metadata.description ?? bookingFooter(resolved.name));
    if (meeting.externalEventId) {
      await this.deps.google.patchEvent({
        ...eventWrite({
          calendarId,
          sendUpdates: 'none',
          summary: meeting.title,
          description,
          start,
          end,
          timeZone: settings.timezone,
          attendees: attendeeList(email, typeof meeting.metadata.attendeeName === 'string' ? meeting.metadata.attendeeName : null),
          colorId: typeof meeting.metadata.googleColorId === 'string' ? meeting.metadata.googleColorId : undefined,
        }),
        eventId: meeting.externalEventId,
      });
    }
    meeting.start = start;
    meeting.end = end;
    meeting.status = 'scheduled';
    await this.deps.repo.updateMeeting(meeting.id, { start, end, status: 'scheduled' });
    await this.deps.repo.updateHold(hold.id, { status: 'consumed', meetingId: meeting.id });
    await this.writeTimeline(organizationId, meeting.contactId, 'reschedule', resolved, now, settings.timezone, `Rescheduled ${meeting.title}`, meeting.id);
    if (email && meeting.externalEventId) {
      await this.openSendJob({
        organizationId,
        meeting,
        kind: 'reschedule',
        emails: [email],
        contactId: meeting.contactId,
        now,
        payload: { description, summary: meeting.title, start: start.toISOString(), end: end.toISOString() },
      });
    }
    return meeting;
  }

  async cancel(organizationId: string, meetingId: string, actor: CalendarActor): Promise<MeetingRecord> {
    const meeting = await this.requireMeeting(organizationId, meetingId);
    const now = this.now();
    const settings = await this.loadSettings(organizationId);
    const resolved = this.resolveActor(actor, settings);
    const email = attendeeEmail(meeting);
    const killSwitch = await this.deps.killSwitch(organizationId);
    let doNotContact = false;
    try {
      await this.assertInvitable(organizationId, meeting.contactId, email);
    } catch (err) {
      if (!(err instanceof DoNotContactError)) throw err;
      doNotContact = true;
    }
    meeting.status = 'cancelled';
    await this.deps.repo.updateMeeting(meeting.id, { status: 'cancelled' });
    await this.writeTimeline(organizationId, meeting.contactId, 'cancellation', resolved, now, settings.timezone, `Cancelled ${meeting.title}`, meeting.id);
    if (!meeting.externalEventId) return meeting;
    const calendarId = String(meeting.metadata.googleCalendarId ?? settings.bookingCalendarId ?? 'primary');
    if (!email || killSwitch || doNotContact) {
      await this.deps.google.deleteEvent(calendarId, meeting.externalEventId, 'none');
      if (email) {
        await this.openSendJob({
          organizationId,
          meeting,
          kind: 'cancellation',
          emails: [email],
          contactId: meeting.contactId,
          now,
          payload: {},
          forceBlocked: killSwitch ? 'kill_switch' : 'do_not_contact',
        });
      }
      return meeting;
    }
    await this.openSendJob({
      organizationId,
      meeting,
      kind: 'cancellation',
      emails: [email],
      contactId: meeting.contactId,
      now,
      payload: { calendarId },
    });
    return meeting;
  }

  async markNoShow(organizationId: string, meetingId: string, actor: CalendarActor): Promise<MeetingRecord> {
    const meeting = await this.requireMeeting(organizationId, meetingId);
    const now = this.now();
    const settings = await this.loadSettings(organizationId);
    const resolved = this.resolveActor(actor, settings);
    meeting.status = 'no_show';
    await this.deps.repo.updateMeeting(meeting.id, { status: 'no_show' });
    await this.writeTimeline(organizationId, meeting.contactId, 'no_show', resolved, now, settings.timezone, `No-show ${meeting.title}`, meeting.id);
    return meeting;
  }

  async agenda(organizationId: string, rangeStart: Date, rangeEnd: Date): Promise<AgendaItem[]> {
    const now = this.now();
    const settings = await this.loadSettings(organizationId);
    await this.deps.repo.releaseExpired(now);
    const meetings = await this.deps.repo.listMeetings(organizationId, rangeStart, rangeEnd);
    const holds = await this.deps.repo.listActiveHolds(organizationId, rangeStart, rangeEnd, now);
    const items: AgendaItem[] = [];
    const seen = new Set<string>();
    for (const meeting of meetings) {
      if (meeting.externalEventId) seen.add(meeting.externalEventId);
      const color = typeof meeting.metadata.agentColor === 'string' ? meeting.metadata.agentColor : null;
      items.push({
        id: meeting.id,
        kind: 'event',
        title: meeting.title,
        start: meeting.start.toISOString(),
        end: meeting.end.toISOString(),
        startLabel: formatInTimezone(meeting.start, settings.timezone),
        endLabel: formatInTimezone(meeting.end, settings.timezone),
        status: meeting.status,
        agentId: typeof meeting.metadata.agentId === 'string' ? meeting.metadata.agentId : null,
        agentName: typeof meeting.metadata.agentName === 'string' ? meeting.metadata.agentName : null,
        color,
        googleColorId: typeof meeting.metadata.googleColorId === 'string' ? meeting.metadata.googleColorId : null,
        contactId: meeting.contactId,
        contactName: typeof meeting.metadata.attendeeName === 'string' ? meeting.metadata.attendeeName : null,
        meetingUrl: meeting.meetingUrl,
        inviteStage: null,
      });
    }
    for (const hold of holds) {
      items.push({
        id: hold.id,
        kind: 'hold',
        title: `Hold · ${hold.holderName ?? 'APEX'}`,
        start: hold.start.toISOString(),
        end: hold.end.toISOString(),
        startLabel: formatInTimezone(hold.start, settings.timezone),
        endLabel: formatInTimezone(hold.end, settings.timezone),
        status: 'held',
        agentId: hold.holderAgentId,
        agentName: hold.holderName,
        color: null,
        googleColorId: null,
        contactId: hold.contactId,
        contactName: null,
        meetingUrl: null,
        inviteStage: null,
      });
    }
    if (await this.deps.google.connected()) {
      const calendarId = settings.bookingCalendarId || 'primary';
      const remote = await this.deps.google.listEvents(calendarId, rangeStart, rangeEnd);
      for (const event of remote) {
        if (seen.has(event.id)) continue;
        items.push({
          id: `google:${event.id}`,
          kind: 'google',
          title: event.summary,
          start: event.start.toISOString(),
          end: event.end.toISOString(),
          startLabel: formatInTimezone(event.start, settings.timezone),
          endLabel: formatInTimezone(event.end, settings.timezone),
          status: 'google',
          agentId: null,
          agentName: null,
          color: null,
          googleColorId: event.colorId ?? null,
          contactId: null,
          contactName: null,
          meetingUrl: event.htmlLink,
          inviteStage: null,
        });
      }
    }
    items.sort((a, b) => a.start.localeCompare(b.start));
    return items;
  }

  async contactTimeline(organizationId: string, contactId: string): Promise<TimelineRow[]> {
    return this.deps.repo.timelineForContact(organizationId, contactId);
  }

  /**
   * Cal.com already emails public-link guests. APEX mirrors the booking onto
   * Google with sendUpdates="none" so it does not send a second invite.
   * TODO(feat/crm): also call the CRM timeline writer when that branch exists.
   * Rows are appended to `interactions` by the production repository.
   */
  async ingestCalWebhook(organizationId: string, booking: CalWebhookBooking): Promise<{ duplicate: boolean; meetingId: string | null; conflict: boolean }> {
    const claim = await this.deps.repo.claimEvent('cal.com', `${booking.trigger}:${booking.uid}`);
    if (claim === 'duplicate') return { duplicate: true, meetingId: null, conflict: false };
    const now = this.now();
    const settings = await this.loadSettings(organizationId);
    const actor: CalendarActor = { kind: 'operator', id: null, name: 'Cal.com' };
    if (booking.trigger === 'BOOKING_CANCELLED') {
      const existing = await this.deps.repo.findMeetingByExternal('cal.com', booking.uid);
      if (!existing) return { duplicate: false, meetingId: null, conflict: false };
      existing.status = 'cancelled';
      await this.deps.repo.updateMeeting(existing.id, { status: 'cancelled' });
      await this.writeTimeline(organizationId, existing.contactId, 'cancellation', actor, now, settings.timezone, `Cal.com cancelled ${existing.title}`, existing.id);
      return { duplicate: false, meetingId: existing.id, conflict: false };
    }
    const prior = booking.rescheduleUid
      ? await this.deps.repo.findMeetingByExternal('cal.com', booking.rescheduleUid)
      : await this.deps.repo.findMeetingByExternal('cal.com', booking.uid);
    if (prior && booking.trigger === 'BOOKING_RESCHEDULED') {
      prior.start = booking.start;
      prior.end = booking.end;
      prior.externalEventId = booking.uid;
      await this.deps.repo.updateMeeting(prior.id, { start: booking.start, end: booking.end, externalEventId: booking.uid });
      await this.writeTimeline(organizationId, prior.contactId, 'reschedule', actor, now, settings.timezone, `Cal.com rescheduled ${prior.title}`, prior.id);
      return { duplicate: false, meetingId: prior.id, conflict: false };
    }
    let conflict = false;
    const hold: HoldRecord = {
      id: randomUUID(),
      organizationId,
      start: booking.start,
      end: booking.end,
      status: 'held',
      holderAgentId: null,
      holderName: 'Cal.com',
      contactId: null,
      meetingId: null,
      expiresAt: new Date(now.getTime() + settings.holdMinutes * 60_000),
    };
    try {
      await this.deps.repo.placeHold(hold);
    } catch (err) {
      if (!isCalendarExclusionError(err)) throw err;
      conflict = true;
    }
    let externalEventId: string | null = null;
    let meetingUrl: string | null = null;
    if (!conflict && await this.deps.google.connected()) {
      const created = await this.deps.google.createEvent(eventWrite({
        calendarId: settings.bookingCalendarId || 'primary',
        sendUpdates: 'none',
        summary: booking.title,
        description: `${bookingFooter('Cal.com')}\n\nMirrored from Cal.com ${booking.uid}. Cal.com already notified the guest.`,
        start: booking.start,
        end: booking.end,
        timeZone: settings.timezone,
        attendees: attendeeList(booking.attendeeEmail, booking.attendeeName),
      }));
      externalEventId = created.id;
      meetingUrl = created.htmlLink;
    }
    const contact = booking.attendeeEmail
      ? await this.deps.repo.findContactByEmail(organizationId, booking.attendeeEmail)
      : null;
    const meeting: MeetingRecord = {
      id: randomUUID(),
      organizationId,
      contactId: contact?.id ?? null,
      provider: 'cal.com',
      externalEventId: booking.uid,
      title: booking.title,
      start: booking.start,
      end: booking.end,
      status: conflict ? 'conflict' : 'scheduled',
      meetingUrl,
      metadata: {
        agentName: 'Cal.com',
        googleEventId: externalEventId,
        attendeeEmail: booking.attendeeEmail,
        attendeeName: booking.attendeeName,
        googleCalendarId: settings.bookingCalendarId || 'primary',
      },
      attendees: booking.attendeeEmail ? [{
        contactId: contact?.id ?? null,
        email: booking.attendeeEmail,
        name: booking.attendeeName,
        role: 'attendee',
      }] : [],
    };
    await this.deps.repo.insertMeeting(meeting);
    if (!conflict) await this.deps.repo.updateHold(hold.id, { status: 'consumed', meetingId: meeting.id });
    await this.writeTimeline(
      organizationId,
      contact?.id ?? null,
      'booking',
      actor,
      now,
      settings.timezone,
      conflict ? `Cal.com booking conflicted with an APEX hold: ${booking.title}` : `Cal.com booked ${booking.title}`,
      meeting.id,
    );
    return { duplicate: false, meetingId: meeting.id, conflict };
  }

  private async dispatchCleared(job: SendJobRecord): Promise<void> {
    if (!job.externalEventId || !job.googleCalendarId) return;
    const meeting = await this.deps.repo.getMeeting(job.meetingId);
    if (!meeting) return;
    const settings = await this.loadSettings(job.organizationId);
    const description = typeof job.payload.description === 'string'
      ? job.payload.description
      : String(meeting.metadata.description ?? '');
    const email = job.recipientEmails[0] ?? null;
    if (job.kind === 'cancellation') {
      await this.deps.google.deleteEvent(job.googleCalendarId, job.externalEventId, 'all');
      return;
    }
    const start = typeof job.payload.start === 'string' ? new Date(job.payload.start) : meeting.start;
    const end = typeof job.payload.end === 'string' ? new Date(job.payload.end) : meeting.end;
    await this.deps.google.patchEvent({
      ...eventWrite({
        calendarId: job.googleCalendarId,
        sendUpdates: 'all',
        summary: typeof job.payload.summary === 'string' ? job.payload.summary : meeting.title,
        description,
        start,
        end,
        timeZone: settings.timezone,
        attendees: attendeeList(email, typeof meeting.metadata.attendeeName === 'string' ? meeting.metadata.attendeeName : null),
        colorId: typeof meeting.metadata.googleColorId === 'string' ? meeting.metadata.googleColorId : undefined,
        privateProps: { apexInvite: 'sent' },
      }),
      eventId: job.externalEventId,
    });
  }

  private async openSendJob(input: {
    organizationId: string;
    meeting: MeetingRecord;
    kind: SendJobRecord['kind'];
    emails: string[];
    contactId: string | null;
    now: Date;
    payload: Record<string, unknown>;
    forceBlocked?: 'kill_switch' | 'do_not_contact';
  }): Promise<SendJobRecord> {
    const since = new Date(input.now.getTime() - SEND_WINDOW_MS);
    const recent = await this.deps.repo.listSendJobsSince(input.organizationId, since);
    const prior = recent.reduce((sum, job) => sum + job.recipientEmails.length, 0);
    const codeRequired = prior + input.emails.length >= 5;
    const killSwitch = input.forceBlocked === 'kill_switch' || await this.deps.killSwitch(input.organizationId);
    const blockedReason = input.forceBlocked ?? (killSwitch ? 'kill_switch' : null);
    const job: SendJobRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      meetingId: input.meeting.id,
      kind: input.kind,
      recipientEmails: input.emails,
      contactId: input.contactId,
      stage: blockedReason ? 'blocked' : 'initial_check',
      confirmations: 0,
      challengeCode: codeRequired ? randomChallengeCode() : null,
      codeRequired,
      externalEventId: input.meeting.externalEventId,
      googleCalendarId: typeof input.meeting.metadata.googleCalendarId === 'string'
        ? input.meeting.metadata.googleCalendarId
        : null,
      blockedReason,
      createdAt: input.now,
      clearedAt: null,
      payload: input.payload,
    };
    await this.deps.repo.insertSendJob(job);
    return job;
  }

  private async occupancy(organizationId: string, settings: CalendarSettings, rangeStart: Date, rangeEnd: Date, now: Date) {
    await this.deps.repo.releaseExpired(now);
    const busyIds = this.busyCalendars(settings).ids;
    const busy = await this.deps.google.freeBusy(busyIds, rangeStart, rangeEnd);
    const meetings = (await this.deps.repo.listMeetings(organizationId, rangeStart, rangeEnd))
      .filter((meeting) => ACTIVE.has(meeting.status));
    const holdRows = await this.deps.repo.listActiveHolds(organizationId, rangeStart, rangeEnd, now);
    return {
      busy,
      meetings,
      holds: holdRows.map((hold) => ({ start: hold.start, end: hold.end, source: 'hold' })),
    };
  }

  private busyCalendars(settings: CalendarSettings): { ids: string[]; source: 'configured' | 'primary-fallback'; bookingCalendarId: string } {
    const bookingCalendarId = settings.bookingCalendarId || 'primary';
    if (settings.busyCalendarIds.length > 0) {
      return { ids: settings.busyCalendarIds, source: 'configured', bookingCalendarId };
    }
    return { ids: [bookingCalendarId], source: 'primary-fallback', bookingCalendarId };
  }

  private async loadSettings(organizationId: string): Promise<CalendarSettings> {
    return applyCalendarEnv(await this.deps.settings.get(organizationId));
  }

  private resolveActor(actor: CalendarActor, settings: CalendarSettings): CalendarActor {
    if (actor.name.trim()) return actor;
    if (actor.kind === 'operator') return { ...actor, name: settings.operatorDisplayName || 'Matthew' };
    return { ...actor, name: 'APEX' };
  }

  private async assertInvitable(organizationId: string, contactId?: string | null, email?: string | null): Promise<void> {
    if (contactId) {
      const contact = await this.deps.repo.getContact(organizationId, contactId);
      if (contact?.doNotContact) throw new DoNotContactError();
    }
    if (email) {
      const byEmail = await this.deps.repo.findContactByEmail(organizationId, email);
      if (byEmail?.doNotContact) throw new DoNotContactError();
    }
  }

  private async writeTimeline(
    organizationId: string,
    contactId: string | null,
    kind: TimelineRow['kind'],
    actor: CalendarActor,
    occurredAt: Date,
    timezone: string,
    summary: string,
    meetingId: string | null,
  ): Promise<void> {
    // TODO(feat/crm): feat/crm is not on origin. This append-only row is the
    // contact timeline (UTC occurredAt, America/Chicago shown by the API).
    // When the CRM timeline writer lands, call it from here as well.
    await this.deps.repo.appendTimeline({
      id: randomUUID(),
      organizationId,
      contactId,
      kind,
      actorName: actor.name,
      actorKind: actor.kind,
      actorId: actor.id,
      occurredAt,
      timezone,
      summary,
      meetingId,
    });
  }

  private async requireMeeting(organizationId: string, meetingId: string): Promise<MeetingRecord> {
    const meeting = await this.deps.repo.getMeeting(meetingId);
    if (!meeting || meeting.organizationId !== organizationId) throw new Error('Meeting not found');
    return meeting;
  }
}

function withFooter(notes: string | null, actorName: string): string {
  const footer = bookingFooter(actorName);
  const base = (notes ?? '').trim();
  if (base.includes(footer)) return base;
  return base ? `${base}\n\n${footer}` : footer;
}

function attendeeList(email?: string | null, name?: string | null): Array<{ email: string; displayName?: string }> {
  if (!email) return [];
  return [{ email, displayName: name ?? undefined }];
}

function attendeeEmail(meeting: MeetingRecord): string | null {
  return meeting.attendees[0]?.email
    ?? (typeof meeting.metadata.attendeeEmail === 'string' ? meeting.metadata.attendeeEmail : null);
}

function eventWrite(input: GoogleEventWrite): GoogleEventWrite {
  return input;
}

function dayBounds(date: Date, timeZone: string): { start: Date; end: Date } {
  const parts = zonedParts(date, timeZone);
  return {
    start: zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0, timeZone),
    end: zonedTimeToUtc(parts.year, parts.month, parts.day + 1, 0, 0, timeZone),
  };
}
