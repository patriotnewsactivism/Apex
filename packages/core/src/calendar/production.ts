import { and, eq, gt, gte, lt, or, sql } from 'drizzle-orm';
import {
  calendarBookingSettings,
  calendarConnections,
  calendarSendJobs,
  calendarSlotHolds,
  contacts,
  db,
  decrypt,
  encrypt,
  interactions,
  meetingAttendees,
  meetings,
  outboundPolicies,
  providerEvents,
  suppressions,
} from '@workspace/db';
import { CalendarBookingService, type SettingsPort } from './booking-service.js';
import { isCalendarExclusionError } from './errors.js';
import { exchangeGoogleCode, HttpGoogleCalendar, readGoogleAccountEmail, type GoogleTokens } from './google.js';
import type { CalendarRepository } from './memory.js';
import { CalendarExclusionError } from './errors.js';
import {
  defaultCalendarSettings,
  type CalendarSettings,
  type ContactSnapshot,
  type HoldRecord,
  type MeetingRecord,
  type SendJobRecord,
  type TimelineRow,
} from './types.js';

const ORG_FALLBACK = 'apex';

export function calendarOrganizationId(env: NodeJS.ProcessEnv = process.env): string {
  return env.APEX_CALENDAR_ORGANIZATION_ID?.trim() || ORG_FALLBACK;
}

let singleton: CalendarBookingService | null = null;

export function getCalendarBookingService(): CalendarBookingService {
  if (!singleton) {
    const repo = new PostgresCalendarRepository();
    singleton = new CalendarBookingService({
      settings: new PostgresSettings(),
      google: new HttpGoogleCalendar({
        fetch,
        loadTokens: () => repo.loadTokens(calendarOrganizationId()),
        saveTokens: (tokens) => repo.saveTokens(calendarOrganizationId(), tokens),
      }),
      repo,
      killSwitch: (organizationId) => killSwitchEnabled(organizationId),
    });
  }
  return singleton;
}

/** Test hook. Production callers use the singleton. */
export function resetCalendarBookingService(): void {
  singleton = null;
}

/** Persist a Google OAuth code as encrypted calendar tokens for the configured organization. */
export async function saveGoogleCalendarConnection(code: string): Promise<{ email: string | null }> {
  const tokens = await exchangeGoogleCode(code, fetch);
  const repo = new PostgresCalendarRepository();
  await repo.saveTokens(calendarOrganizationId(), tokens);
  resetCalendarBookingService();
  return { email: tokens.email };
}

class PostgresSettings implements SettingsPort {
  async get(organizationId: string): Promise<CalendarSettings> {
    const [row] = await db.select().from(calendarBookingSettings)
      .where(eq(calendarBookingSettings.organizationId, organizationId)).limit(1);
    if (!row) return defaultCalendarSettings();
    const defaults = defaultCalendarSettings();
    return {
      timezone: row.timezone || defaults.timezone,
      workingHours: row.workingHours?.length ? row.workingHours : defaults.workingHours,
      bufferBeforeMinutes: row.bufferBeforeMinutes,
      bufferAfterMinutes: row.bufferAfterMinutes,
      noBookBlocks: row.noBookBlocks ?? [],
      maxMeetingsPerDay: row.maxMeetingsPerDay,
      minimumNoticeMinutes: row.minimumNoticeMinutes,
      holdMinutes: row.holdMinutes,
      slotMinutes: row.slotMinutes,
      busyCalendarIds: row.busyCalendarIds ?? [],
      bookingCalendarId: row.bookingCalendarId,
      agentColors: row.agentColors ?? {},
      operatorDisplayName: row.operatorDisplayName || defaults.operatorDisplayName,
    };
  }

  async save(organizationId: string, settings: CalendarSettings): Promise<void> {
    await db.insert(calendarBookingSettings).values({
      organizationId,
      timezone: settings.timezone,
      workingHours: settings.workingHours,
      bufferBeforeMinutes: settings.bufferBeforeMinutes,
      bufferAfterMinutes: settings.bufferAfterMinutes,
      noBookBlocks: settings.noBookBlocks,
      maxMeetingsPerDay: settings.maxMeetingsPerDay,
      minimumNoticeMinutes: settings.minimumNoticeMinutes,
      holdMinutes: settings.holdMinutes,
      slotMinutes: settings.slotMinutes,
      busyCalendarIds: settings.busyCalendarIds,
      bookingCalendarId: settings.bookingCalendarId,
      agentColors: settings.agentColors,
      operatorDisplayName: settings.operatorDisplayName,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: calendarBookingSettings.organizationId,
      set: {
        timezone: settings.timezone,
        workingHours: settings.workingHours,
        bufferBeforeMinutes: settings.bufferBeforeMinutes,
        bufferAfterMinutes: settings.bufferAfterMinutes,
        noBookBlocks: settings.noBookBlocks,
        maxMeetingsPerDay: settings.maxMeetingsPerDay,
        minimumNoticeMinutes: settings.minimumNoticeMinutes,
        holdMinutes: settings.holdMinutes,
        slotMinutes: settings.slotMinutes,
        busyCalendarIds: settings.busyCalendarIds,
        bookingCalendarId: settings.bookingCalendarId,
        agentColors: settings.agentColors,
        operatorDisplayName: settings.operatorDisplayName,
        updatedAt: new Date(),
      },
    });
  }
}

export class PostgresCalendarRepository implements CalendarRepository {
  async releaseExpired(now: Date): Promise<void> {
    await db.update(calendarSlotHolds).set({ status: 'expired', updatedAt: now }).where(and(
      eq(calendarSlotHolds.status, 'held'),
      sql`${calendarSlotHolds.expiresAt} <= ${now}`,
    ));
  }

  async listActiveHolds(organizationId: string, rangeStart: Date, rangeEnd: Date, now: Date): Promise<HoldRecord[]> {
    const rows = await db.select().from(calendarSlotHolds).where(and(
      eq(calendarSlotHolds.organizationId, organizationId),
      eq(calendarSlotHolds.status, 'held'),
      gt(calendarSlotHolds.expiresAt, now),
      lt(calendarSlotHolds.startsAt, rangeEnd),
      gt(calendarSlotHolds.endsAt, rangeStart),
    ));
    return rows.map(mapHold);
  }

  async placeHold(row: HoldRecord): Promise<HoldRecord> {
    try {
      await db.insert(calendarSlotHolds).values({
        id: row.id,
        organizationId: row.organizationId,
        startsAt: row.start,
        endsAt: row.end,
        status: row.status,
        holderAgentId: row.holderAgentId,
        holderName: row.holderName,
        contactId: row.contactId,
        meetingId: row.meetingId,
        expiresAt: row.expiresAt,
      });
      return row;
    } catch (err) {
      if (isCalendarExclusionError(err)) throw new CalendarExclusionError();
      throw err;
    }
  }

  async updateHold(id: string, patch: Partial<Pick<HoldRecord, 'status' | 'meetingId'>>): Promise<void> {
    await db.update(calendarSlotHolds).set({
      status: patch.status,
      meetingId: patch.meetingId,
      updatedAt: new Date(),
    }).where(eq(calendarSlotHolds.id, id));
  }

  async insertMeeting(row: MeetingRecord): Promise<void> {
    await db.insert(meetings).values({
      id: row.id,
      organizationId: row.organizationId,
      contactId: row.contactId,
      provider: row.provider,
      externalEventId: row.externalEventId,
      title: row.title,
      startsAt: row.start,
      endsAt: row.end,
      status: row.status,
      meetingUrl: row.meetingUrl,
      metadata: row.metadata,
    });
    for (const attendee of row.attendees) {
      if (!attendee.contactId) continue;
      await db.insert(meetingAttendees).values({
        meetingId: row.id,
        contactId: attendee.contactId,
        role: attendee.role,
      }).onConflictDoNothing();
    }
  }

  async updateMeeting(id: string, patch: Partial<MeetingRecord>): Promise<void> {
    await db.update(meetings).set({
      title: patch.title,
      startsAt: patch.start,
      endsAt: patch.end,
      status: patch.status,
      meetingUrl: patch.meetingUrl,
      externalEventId: patch.externalEventId,
      metadata: patch.metadata,
      contactId: patch.contactId,
      updatedAt: new Date(),
    }).where(eq(meetings.id, id));
  }

  async getMeeting(id: string): Promise<MeetingRecord | null> {
    const [row] = await db.select().from(meetings).where(eq(meetings.id, id)).limit(1);
    return row ? mapMeeting(row) : null;
  }

  async listMeetings(organizationId: string, rangeStart: Date, rangeEnd: Date): Promise<MeetingRecord[]> {
    const rows = await db.select().from(meetings).where(and(
      eq(meetings.organizationId, organizationId),
      lt(meetings.startsAt, rangeEnd),
      gt(meetings.endsAt, rangeStart),
    ));
    return rows.map(mapMeeting);
  }

  async findMeetingByExternal(provider: string, externalEventId: string): Promise<MeetingRecord | null> {
    const [row] = await db.select().from(meetings).where(and(
      eq(meetings.provider, provider),
      eq(meetings.externalEventId, externalEventId),
    )).limit(1);
    return row ? mapMeeting(row) : null;
  }

  async appendTimeline(row: TimelineRow): Promise<void> {
    await db.insert(interactions).values({
      id: row.id,
      organizationId: row.organizationId,
      contactId: row.contactId,
      channel: 'calendar',
      direction: 'internal',
      type: row.kind,
      provider: 'google',
      externalId: row.meetingId,
      status: row.kind,
      subject: row.summary,
      bodySummary: row.summary,
      occurredAt: row.occurredAt,
      structuredOutcome: {
        kind: row.kind,
        actorName: row.actorName,
        actorKind: row.actorKind,
        actorId: row.actorId,
        timezone: row.timezone,
        meetingId: row.meetingId,
      },
    });
  }

  async timelineForContact(organizationId: string, contactId: string): Promise<TimelineRow[]> {
    const rows = await db.select().from(interactions).where(and(
      eq(interactions.organizationId, organizationId),
      eq(interactions.contactId, contactId),
      eq(interactions.channel, 'calendar'),
    ));
    return rows.map((row) => {
      const outcome = (row.structuredOutcome ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        organizationId: row.organizationId,
        contactId: row.contactId,
        kind: (row.type as TimelineRow['kind']) ?? 'booking',
        actorName: typeof outcome.actorName === 'string' ? outcome.actorName : 'Matthew',
        actorKind: outcome.actorKind === 'agent' ? 'agent' : 'operator',
        actorId: typeof outcome.actorId === 'string' ? outcome.actorId : null,
        occurredAt: row.occurredAt ?? row.createdAt,
        timezone: typeof outcome.timezone === 'string' ? outcome.timezone : 'America/Chicago',
        summary: row.subject ?? '',
        meetingId: typeof outcome.meetingId === 'string' ? outcome.meetingId : null,
      };
    });
  }

  async insertSendJob(row: SendJobRecord): Promise<void> {
    await db.insert(calendarSendJobs).values({
      id: row.id,
      organizationId: row.organizationId,
      meetingId: row.meetingId,
      kind: row.kind,
      recipientEmails: row.recipientEmails,
      contactId: row.contactId,
      stage: row.stage,
      confirmations: row.confirmations,
      challengeCode: row.challengeCode,
      codeRequired: row.codeRequired,
      externalEventId: row.externalEventId,
      googleCalendarId: row.googleCalendarId,
      blockedReason: row.blockedReason,
      payload: row.payload,
      createdAt: row.createdAt,
      clearedAt: row.clearedAt,
    });
  }

  async updateSendJob(id: string, patch: Partial<SendJobRecord>): Promise<void> {
    await db.update(calendarSendJobs).set({
      stage: patch.stage,
      confirmations: patch.confirmations,
      challengeCode: patch.challengeCode,
      codeRequired: patch.codeRequired,
      blockedReason: patch.blockedReason,
      clearedAt: patch.clearedAt,
      payload: patch.payload,
      updatedAt: new Date(),
    }).where(eq(calendarSendJobs.id, id));
  }

  async getSendJob(id: string): Promise<SendJobRecord | null> {
    const [row] = await db.select().from(calendarSendJobs).where(eq(calendarSendJobs.id, id)).limit(1);
    return row ? mapSendJob(row) : null;
  }

  async listSendJobsSince(organizationId: string, since: Date): Promise<SendJobRecord[]> {
    const rows = await db.select().from(calendarSendJobs).where(and(
      eq(calendarSendJobs.organizationId, organizationId),
      gte(calendarSendJobs.createdAt, since),
    ));
    return rows.map(mapSendJob);
  }

  async getContact(organizationId: string, contactId: string): Promise<ContactSnapshot | null> {
    const [row] = await db.select().from(contacts).where(and(
      eq(contacts.organizationId, organizationId),
      eq(contacts.id, contactId),
    )).limit(1);
    if (!row) return null;
    return this.toContact(organizationId, row.id, row.email, joinName(row.firstName, row.lastName), row.status === 'suppressed');
  }

  async findContactByEmail(organizationId: string, email: string): Promise<ContactSnapshot | null> {
    const normalized = email.trim().toLowerCase();
    const [row] = await db.select().from(contacts).where(and(
      eq(contacts.organizationId, organizationId),
      sql`lower(${contacts.email}) = ${normalized}`,
    )).limit(1);
    if (!row) {
      const suppressed = await this.emailSuppressed(organizationId, normalized);
      if (!suppressed) return null;
      return { id: '', email: normalized, name: null, doNotContact: true };
    }
    return this.toContact(organizationId, row.id, row.email, joinName(row.firstName, row.lastName), row.status === 'suppressed');
  }

  async claimEvent(provider: string, externalId: string): Promise<'new' | 'duplicate'> {
    const [existing] = await db.select({ id: providerEvents.id }).from(providerEvents).where(and(
      eq(providerEvents.provider, provider),
      eq(providerEvents.externalEventId, externalId),
    )).limit(1);
    if (existing) return 'duplicate';
    await db.insert(providerEvents).values({
      provider,
      externalEventId: externalId,
      eventType: 'calendar_webhook',
      payload: {},
      status: 'processed',
      processedAt: new Date(),
    }).onConflictDoNothing();
    return 'new';
  }

  async loadTokens(organizationId: string): Promise<GoogleTokens | null> {
    const key = process.env.APEX_ENCRYPTION_KEY?.trim();
    if (!key) return null;
    const [row] = await db.select().from(calendarConnections).where(and(
      eq(calendarConnections.organizationId, organizationId),
      eq(calendarConnections.provider, 'google'),
      eq(calendarConnections.status, 'connected'),
    )).limit(1);
    const ciphertext = row?.encryptedCredentials?.ciphertext;
    if (typeof ciphertext !== 'string') return null;
    const decoded = await decrypt(ciphertext, key);
    if (typeof decoded.accessToken !== 'string' || typeof decoded.refreshToken !== 'string') return null;
    return {
      accessToken: decoded.accessToken,
      refreshToken: decoded.refreshToken,
      expiryEpochMs: typeof decoded.expiryEpochMs === 'number' ? decoded.expiryEpochMs : 0,
      email: typeof decoded.email === 'string' ? decoded.email : row?.externalAccountId ?? null,
      scope: typeof decoded.scope === 'string' ? decoded.scope : '',
    };
  }

  async saveTokens(organizationId: string, tokens: GoogleTokens, fetchImpl: typeof fetch = fetch): Promise<void> {
    const key = process.env.APEX_ENCRYPTION_KEY?.trim();
    if (!key) throw new Error('APEX_ENCRYPTION_KEY is not set');
    const email = tokens.email ?? await readGoogleAccountEmail(tokens.accessToken, fetchImpl);
    const stored = { ...tokens, email };
    const ciphertext = await encrypt(stored as unknown as Record<string, unknown>, key);
    const [existing] = await db.select({ id: calendarConnections.id }).from(calendarConnections).where(and(
      eq(calendarConnections.organizationId, organizationId),
      eq(calendarConnections.provider, 'google'),
    )).limit(1);
    if (existing) {
      await db.update(calendarConnections).set({
        encryptedCredentials: { ciphertext },
        externalAccountId: email,
        status: 'connected',
        updatedAt: new Date(),
      }).where(eq(calendarConnections.id, existing.id));
      return;
    }
    await db.insert(calendarConnections).values({
      organizationId,
      provider: 'google',
      externalAccountId: email,
      encryptedCredentials: { ciphertext },
      status: 'connected',
      configuration: {},
    });
  }

  private async toContact(organizationId: string, id: string, email: string | null, name: string | null, alreadySuppressed: boolean): Promise<ContactSnapshot> {
    const suppressed = alreadySuppressed || await this.emailSuppressed(organizationId, email) || await this.contactSuppressed(organizationId, id);
    return { id, email, name, doNotContact: suppressed };
  }

  private async contactSuppressed(organizationId: string, contactId: string): Promise<boolean> {
    const [row] = await db.select({ id: suppressions.id }).from(suppressions).where(and(
      eq(suppressions.organizationId, organizationId),
      eq(suppressions.contactId, contactId),
      or(eq(suppressions.channel, 'all'), eq(suppressions.channel, 'email'), eq(suppressions.channel, 'calendar')),
    )).limit(1);
    return Boolean(row);
  }

  private async emailSuppressed(organizationId: string, email: string | null): Promise<boolean> {
    if (!email) return false;
    const normalized = email.trim().toLowerCase();
    const [row] = await db.select({ id: suppressions.id }).from(suppressions).where(and(
      eq(suppressions.organizationId, organizationId),
      sql`lower(${suppressions.email}) = ${normalized}`,
      or(eq(suppressions.channel, 'all'), eq(suppressions.channel, 'email'), eq(suppressions.channel, 'calendar')),
    )).limit(1);
    return Boolean(row);
  }
}

async function killSwitchEnabled(organizationId: string): Promise<boolean> {
  if (process.env.APEX_CALENDAR_INVITE_KILL_SWITCH === 'true') return true;
  const [row] = await db.select({ killSwitch: outboundPolicies.killSwitch }).from(outboundPolicies)
    .where(eq(outboundPolicies.projectId, organizationId)).limit(1);
  return Boolean(row?.killSwitch);
}

function mapHold(row: typeof calendarSlotHolds.$inferSelect): HoldRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    start: row.startsAt,
    end: row.endsAt,
    status: row.status as HoldRecord['status'],
    holderAgentId: row.holderAgentId,
    holderName: row.holderName,
    contactId: row.contactId,
    meetingId: row.meetingId,
    expiresAt: row.expiresAt,
  };
}

function mapMeeting(row: typeof meetings.$inferSelect): MeetingRecord {
  const metadata = row.metadata ?? {};
  const email = typeof metadata.attendeeEmail === 'string' ? metadata.attendeeEmail : null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    contactId: row.contactId,
    provider: row.provider ?? 'google',
    externalEventId: row.externalEventId,
    title: row.title,
    start: row.startsAt,
    end: row.endsAt,
    status: row.status as MeetingRecord['status'],
    meetingUrl: row.meetingUrl,
    metadata,
    attendees: email ? [{
      contactId: row.contactId,
      email,
      name: typeof metadata.attendeeName === 'string' ? metadata.attendeeName : null,
      role: 'attendee',
    }] : [],
  };
}

function mapSendJob(row: typeof calendarSendJobs.$inferSelect): SendJobRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    meetingId: row.meetingId,
    kind: row.kind as SendJobRecord['kind'],
    recipientEmails: row.recipientEmails ?? [],
    contactId: row.contactId,
    stage: row.stage as SendJobRecord['stage'],
    confirmations: row.confirmations,
    challengeCode: row.challengeCode,
    codeRequired: row.codeRequired,
    externalEventId: row.externalEventId,
    googleCalendarId: row.googleCalendarId,
    blockedReason: row.blockedReason,
    createdAt: row.createdAt,
    clearedAt: row.clearedAt,
    payload: row.payload ?? {},
  };
}

function joinName(first: string | null, last: string | null): string | null {
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name || null;
}
