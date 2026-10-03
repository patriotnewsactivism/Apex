/**
 * Calendar booking guard.
 *
 * Proves one booking service: free/busy plus every availability rule, a
 * single winner when two bookings race, hold expiry, the invite ladder,
 * kill switch, the 5-message code, do-not-contact, a rejected Cal.com
 * signature, a contact timeline row, and the agent color on the Google event.
 * Google and Cal.com are mocked. No production data is touched.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { CalendarBookingService } from '../packages/core/src/calendar/booking-service.js';
import { authorizeCalWebhook } from '../packages/core/src/calendar/cal-com.js';
import { DoNotContactError, SlotUnavailableError } from '../packages/core/src/calendar/errors.js';
import type { GoogleCalendarPort, GoogleEventWrite } from '../packages/core/src/calendar/google.js';
import { MemoryCalendarDb } from '../packages/core/src/calendar/memory.js';
import type { SettingsPort } from '../packages/core/src/calendar/booking-service.js';
import {
  bookingFooter,
  defaultCalendarSettings,
  formatInTimezone,
  zonedTimeToUtc,
  type CalendarSettings,
  type HoldRecord,
  type MeetingRecord,
} from '../packages/core/src/calendar/index.js';
import { createCalendarPublicRouter } from '../packages/api-server/src/routes/calendar.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ❌ ${label}`);
  if (detail !== undefined) console.error(`     ${JSON.stringify(detail)}`);
}

class MemorySettings implements SettingsPort {
  current: CalendarSettings = defaultCalendarSettings();
  async get(): Promise<CalendarSettings> {
    return this.current;
  }
  async save(_organizationId: string, settings: CalendarSettings): Promise<void> {
    this.current = settings;
  }
}

class FakeGoogle implements GoogleCalendarPort {
  busy: Array<{ start: Date; end: Date }> = [];
  creates: GoogleEventWrite[] = [];
  patches: GoogleEventWrite[] = [];
  deletes: Array<{ sendUpdates: string }> = [];
  connectedFlag = true;
  async connected(): Promise<boolean> { return this.connectedFlag; }
  async accountEmail(): Promise<string | null> { return 'calendar@example.com'; }
  async listCalendars() { return [{ id: 'primary', summary: 'Primary', primary: true }]; }
  async freeBusy() { return this.busy.map((item) => ({ ...item, source: 'primary' })); }
  async listEvents() { return []; }
  async createEvent(input: GoogleEventWrite) {
    this.creates.push(input);
    return {
      id: `evt-${this.creates.length}`,
      htmlLink: 'https://calendar.example/event',
      summary: input.summary,
      start: input.start,
      end: input.end,
      colorId: input.colorId,
    };
  }
  async patchEvent(input: GoogleEventWrite & { eventId: string }): Promise<void> {
    this.patches.push(input);
  }
  async deleteEvent(_calendarId: string, _eventId: string, sendUpdates: 'none' | 'all'): Promise<void> {
    this.deletes.push({ sendUpdates });
  }
}

const ORG = 'apex';
const FIXED_NOW = new Date('2026-10-05T13:00:00.000Z');
const TZ = 'America/Chicago';

function at(hour: number, minute = 0, day = 5): Date {
  return zonedTimeToUtc(2026, 10, day, hour, minute, TZ);
}

function harness(options?: { kill?: boolean; now?: Date }) {
  const google = new FakeGoogle();
  const repo = new MemoryCalendarDb();
  const settings = new MemorySettings();
  const now = options?.now ?? FIXED_NOW;
  const service = new CalendarBookingService({
    settings,
    google,
    repo,
    killSwitch: async () => Boolean(options?.kill),
    now: () => now,
  });
  return { service, google, repo, settings, now };
}

function openRules(settings: MemorySettings, patch: Partial<CalendarSettings> = {}): void {
  settings.current = {
    ...defaultCalendarSettings(),
    timezone: TZ,
    workingHours: [{ day: 1, start: '09:00', end: '17:00' }],
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    maxMeetingsPerDay: 8,
    holdMinutes: 10,
    slotMinutes: 30,
    agentColors: { atlas: { hex: '#4285f4', googleColorId: '9' } },
    ...patch,
  };
}

async function bookSlot(
  service: CalendarBookingService,
  start: Date,
  end: Date,
  extra?: { email?: string; contactId?: string; name?: string },
) {
  return service.book({
    organizationId: ORG,
    start,
    end,
    title: 'Intro',
    attendeeEmail: extra?.email ?? 'guest@example.com',
    attendeeName: 'Guest',
    contactId: extra?.contactId ?? '11111111-1111-4111-8111-111111111111',
    actor: { kind: 'agent', id: 'atlas', name: extra?.name ?? 'Atlas' },
  });
}

async function main(): Promise<void> {
  console.log('Verifying calendar booking...\n');
  const savedEnv = {
    APEX_CALENDAR_TIMEZONE: process.env.APEX_CALENDAR_TIMEZONE,
    APEX_CALENDAR_BUSY_IDS: process.env.APEX_CALENDAR_BUSY_IDS,
    APEX_CALENDAR_HOLD_MINUTES: process.env.APEX_CALENDAR_HOLD_MINUTES,
    APEX_CALENDAR_BOOKING_CALENDAR_ID: process.env.APEX_CALENDAR_BOOKING_CALENDAR_ID,
    APEX_CALENDAR_OPERATOR_NAME: process.env.APEX_CALENDAR_OPERATOR_NAME,
    APEX_CALENDAR_INVITE_KILL_SWITCH: process.env.APEX_CALENDAR_INVITE_KILL_SWITCH,
    APEX_CAL_WEBHOOK_SECRET: process.env.APEX_CAL_WEBHOOK_SECRET,
  };
  delete process.env.APEX_CALENDAR_TIMEZONE;
  delete process.env.APEX_CALENDAR_BUSY_IDS;
  delete process.env.APEX_CALENDAR_HOLD_MINUTES;
  delete process.env.APEX_CALENDAR_BOOKING_CALENDAR_ID;
  delete process.env.APEX_CALENDAR_OPERATOR_NAME;
  delete process.env.APEX_CALENDAR_INVITE_KILL_SWITCH;

  try {
    const sql = readFileSync(new URL('../lib/db/drizzle/20261003_calendar_booking.sql', import.meta.url), 'utf8');
    check('migration enables btree_gist', sql.includes('CREATE EXTENSION IF NOT EXISTS btree_gist'));
    check('migration excludes overlapping holds', sql.includes('EXCLUDE USING gist') && sql.includes('calendar_slot_holds_no_overlap'));

    const ruled = harness();
    openRules(ruled.settings, {
      workingHours: [{ day: 1, start: '09:00', end: '12:00' }],
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 15,
      minimumNoticeMinutes: 60,
      slotMinutes: 30,
      noBookBlocks: [{
        id: 'morning-block',
        start: at(9, 0).toISOString(),
        end: at(9, 15).toISOString(),
        label: 'no-book',
      }],
    });
    ruled.google.busy = [{ start: at(10, 0), end: at(10, 30) }];
    const slots = await ruled.service.findSlots(ORG, at(0, 0), at(0, 0, 6));
    const labels = slots.map((slot) => formatInTimezone(slot.start, TZ));
    check('slots respect free/busy, buffers, no-book, notice, and working hours',
      slots.length === 2 && slots[0]?.start.getTime() === at(11, 0).getTime() && slots[1]?.start.getTime() === at(11, 30).getTime(),
      labels);

    const sunday = await ruled.service.findSlots(ORG, at(0, 0, 4), at(0, 0, 5));
    check('Sunday working window yields no slots', sunday.length === 0, sunday.map((slot) => slot.start.toISOString()));

    const capped = harness();
    openRules(capped.settings, { maxMeetingsPerDay: 1, minimumNoticeMinutes: 0, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 });
    const existing: MeetingRecord = {
      id: '22222222-2222-4222-8222-222222222222',
      organizationId: ORG,
      contactId: null,
      provider: 'google',
      externalEventId: 'existing',
      title: 'Already booked',
      start: at(11, 0),
      end: at(11, 30),
      status: 'scheduled',
      meetingUrl: null,
      metadata: {},
      attendees: [],
    };
    capped.repo.meetings.push(existing);
    const none = await capped.service.findSlots(ORG, at(0, 0), at(0, 0, 6));
    check('max meetings per day blocks the rest of the day', none.length === 0, none.length);

    const race = harness();
    openRules(race.settings);
    const raced = await Promise.allSettled([
      bookSlot(race.service, at(11, 0), at(11, 30), { email: 'a@example.com' }),
      bookSlot(race.service, at(11, 0), at(11, 30), { email: 'b@example.com' }),
    ]);
    const wins = raced.filter((item) => item.status === 'fulfilled');
    const losses = raced.filter((item) => item.status === 'rejected');
    check('two concurrent bookings yield one success', wins.length === 1 && losses.length === 1);
    check('the loser is a slot conflict', losses[0]?.status === 'rejected' && losses[0].reason instanceof SlotUnavailableError);
    check('only one Google event is created, with sendUpdates none',
      race.google.creates.length === 1 && race.google.creates[0]?.sendUpdates === 'none',
      race.google.creates.map((item) => item.sendUpdates));

    const excluding = harness();
    openRules(excluding.settings);
    const original = excluding.repo.placeHold.bind(excluding.repo);
    excluding.repo.placeHold = async (row: HoldRecord) => {
      if (row.start.getTime() === at(12, 0).getTime()) {
        const err = new Error('calendar_slot_holds_no_overlap') as Error & { code: string };
        err.code = '23P01';
        throw err;
      }
      return original(row);
    };
    let exclusion: unknown;
    try {
      await bookSlot(excluding.service, at(12, 0), at(12, 30));
    } catch (err) {
      exclusion = err;
    }
    check('postgres exclusion 23P01 becomes a slot conflict', exclusion instanceof SlotUnavailableError);
    check('exclusion does not create a Google event', excluding.google.creates.length === 0);

    const expiry = harness();
    openRules(expiry.settings);
    const stale: HoldRecord = {
      id: '33333333-3333-4333-8333-333333333333',
      organizationId: ORG,
      start: at(13, 0),
      end: at(13, 30),
      status: 'held',
      holderAgentId: 'atlas',
      holderName: 'Atlas',
      contactId: null,
      meetingId: null,
      expiresAt: new Date(expiry.now.getTime() - 1000),
    };
    expiry.repo.holds.push(stale);
    const afterExpiry = await bookSlot(expiry.service, at(13, 0), at(13, 30), { email: 'later@example.com' });
    check('an expired hold does not block the slot', afterExpiry.meeting.status === 'scheduled');
    check('expired hold is released', expiry.repo.holds.find((hold) => hold.id === stale.id)?.status === 'expired');
    const live: HoldRecord = { ...stale, id: '44444444-4444-4444-8444-444444444444', start: at(14, 0), end: at(14, 30), status: 'held', expiresAt: new Date(expiry.now.getTime() + 60 * 60_000) };
    expiry.repo.holds.push(live);
    let blockedByHold: unknown;
    try {
      await bookSlot(expiry.service, at(14, 0), at(14, 30), { email: 'held@example.com' });
    } catch (err) {
      blockedByHold = err;
    }
    check('an active hold blocks the same slot', blockedByHold instanceof SlotUnavailableError);

    const invite = harness();
    openRules(invite.settings);
    const booked = await bookSlot(invite.service, at(11, 0), at(11, 30));
    check('invite is not sent when the event is created',
      invite.google.creates[0]?.sendUpdates === 'none' && invite.google.patches.length === 0);
    const jobId = booked.sendJob?.id;
    check('booking opens an invite job', Boolean(jobId));
    if (jobId) {
      const first = await invite.service.advanceInvite(ORG, jobId, 'initial_check');
      const second = await invite.service.advanceInvite(ORG, jobId, 'confirm');
      check('first two confirms do not send', !first.allowed && !second.allowed && invite.google.patches.length === 0, { first, second });
      const cleared = await invite.service.advanceInvite(ORG, jobId, 'second_confirm');
      check('safeguard clear sends the invite',
        cleared.allowed && cleared.sendUpdates === 'all' && invite.google.patches.length === 1 && invite.google.patches[0]?.sendUpdates === 'all');
    }

    const killed = harness({ kill: true });
    openRules(killed.settings);
    const killedBook = await bookSlot(killed.service, at(15, 0), at(15, 30), { email: 'kill@example.com' });
    check('kill switch still reserves the event without sending', killed.google.creates[0]?.sendUpdates === 'none' && killedBook.sendJob?.stage === 'blocked');
    if (killedBook.sendJob) {
      const advanced = await killed.service.advanceInvite(ORG, killedBook.sendJob.id, 'second_confirm');
      check('kill switch blocks the invite', !advanced.allowed && advanced.reason === 'kill_switch' && killed.google.patches.length === 0);
    }

    const coded = harness();
    openRules(coded.settings);
    const emails = ['one@example.com', 'two@example.com', 'three@example.com', 'four@example.com', 'five@example.com'];
    const jobs = [];
    for (let index = 0; index < emails.length; index += 1) {
      const startHour = 11 + index;
      const result = await bookSlot(coded.service, at(startHour, 0), at(startHour, 30), { email: emails[index] });
      jobs.push(result.sendJob);
    }
    const fifth = jobs[4];
    check('the fifth invite in the window requires a code', Boolean(fifth?.codeRequired) && /^\d{4}$/.test(fifth?.challengeCode ?? ''));
    check('earlier invites do not require a code', jobs.slice(0, 4).every((job) => job?.codeRequired === false));
    if (fifth?.id) {
      await coded.service.advanceInvite(ORG, fifth.id, 'initial_check');
      await coded.service.advanceInvite(ORG, fifth.id, 'confirm');
      const needsCode = await coded.service.advanceInvite(ORG, fifth.id, 'second_confirm');
      const sentBeforeCode = coded.google.patches.some((patch) => patch.eventId === fifth.externalEventId && patch.sendUpdates === 'all');
      check('code is required before the fifth invite sends', needsCode.stage === 'code_required' && !sentBeforeCode);
      const withCode = await coded.service.advanceInvite(ORG, fifth.id, 'submit_code', fifth.challengeCode);
      const sentAfterCode = coded.google.patches.some((patch) => patch.eventId === fifth.externalEventId && patch.sendUpdates === 'all');
      check('the matching code sends the fifth invite', withCode.allowed && sentAfterCode);
    }

    const dnc = harness();
    openRules(dnc.settings);
    const contactId = '55555555-5555-4555-8555-555555555555';
    dnc.repo.contacts.set(`${ORG}:${contactId}`, {
      id: contactId,
      email: 'quiet@example.com',
      name: 'Quiet',
      doNotContact: true,
    });
    let dncError: unknown;
    try {
      await bookSlot(dnc.service, at(16, 0), at(16, 30), { email: 'quiet@example.com', contactId });
    } catch (err) {
      dncError = err;
    }
    check('a do-not-contact contact cannot be invited', dncError instanceof DoNotContactError && dnc.google.creates.length === 0);

    const timeline = harness();
    openRules(timeline.settings);
    const timelineContact = '66666666-6666-4666-8666-666666666666';
    timeline.repo.contacts.set(`${ORG}:${timelineContact}`, {
      id: timelineContact,
      email: 'timeline@example.com',
      name: 'Timeline',
      doNotContact: false,
    });
    await bookSlot(timeline.service, at(11, 0), at(11, 30), { email: 'timeline@example.com', contactId: timelineContact });
    const rows = await timeline.service.contactTimeline(ORG, timelineContact);
    const bookingRow = rows.find((row) => row.kind === 'booking');
    check('booking writes a timeline row', Boolean(bookingRow));
    check('timeline actor is the bot and the clock is UTC',
      bookingRow?.actorName === 'Atlas'
      && bookingRow.timezone === TZ
      && bookingRow.occurredAt.toISOString().endsWith('Z'));
    check('agent color and booking footer are applied',
      timeline.google.creates[0]?.colorId === '9'
      && (timeline.google.creates[0]?.description ?? '').includes(bookingFooter('Atlas')));

    const secret = 'cal-webhook-test-secret';
    const raw = Buffer.from('{"triggerEvent":"BOOKING_CREATED"}');
    const good = createHmac('sha256', secret).update(raw).digest('hex');
    const bad = authorizeCalWebhook(secret, raw, 'deadbeef');
    const missing = authorizeCalWebhook(undefined, raw, good);
    const ok = authorizeCalWebhook(secret, raw, `sha256=${good}`);
    check('bad Cal.com signature is rejected', !bad.ok && bad.status === 401);
    check('missing Cal.com secret is rejected', !missing.ok && missing.status === 503);
    check('good Cal.com signature is accepted', ok.ok);

    process.env.APEX_CAL_WEBHOOK_SECRET = secret;
    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }));
    app.use('/api/calendar', createCalendarPublicRouter());
    const server: Server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No webhook listener');
    const base = `http://127.0.0.1:${address.port}/api/calendar/cal/webhook`;
    const rejected = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cal-signature-256': 'deadbeef' },
      body: raw,
    });
    check('webhook route rejects a bad signature', rejected.status === 401, rejected.status);
    const emptyBody = Buffer.from('{}');
    const emptySig = createHmac('sha256', secret).update(emptyBody).digest('hex');
    const unrecognized = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cal-signature-256': emptySig },
      body: emptyBody,
    });
    check('a valid signature with an unrecognized body does not book', unrecognized.status === 400, unrecognized.status);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} calendar check(s) failed.`);
    process.exit(1);
  }
  console.log('\nCalendar booking checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
