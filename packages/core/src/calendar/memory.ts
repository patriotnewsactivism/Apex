import { randomUUID } from 'node:crypto';
import { CalendarExclusionError } from './errors.js';
import { rangesOverlap } from './time.js';
import type {
  ContactSnapshot,
  HoldRecord,
  MeetingRecord,
  TimelineRow,
} from './types.js';

export interface CalendarRepository {
  releaseExpired(now: Date): Promise<void>;
  listActiveHolds(organizationId: string, rangeStart: Date, rangeEnd: Date, now: Date): Promise<HoldRecord[]>;
  placeHold(row: HoldRecord): Promise<HoldRecord>;
  updateHold(id: string, patch: Partial<Pick<HoldRecord, 'status' | 'meetingId'>>): Promise<void>;
  insertMeeting(row: MeetingRecord): Promise<void>;
  updateMeeting(id: string, patch: Partial<MeetingRecord>): Promise<void>;
  getMeeting(id: string): Promise<MeetingRecord | null>;
  listMeetings(organizationId: string, rangeStart: Date, rangeEnd: Date): Promise<MeetingRecord[]>;
  findMeetingByExternal(provider: string, externalEventId: string): Promise<MeetingRecord | null>;
  appendTimeline(row: TimelineRow): Promise<void>;
  timelineForContact(organizationId: string, contactId: string): Promise<TimelineRow[]>;
  getContact(organizationId: string, contactId: string): Promise<ContactSnapshot | null>;
  findContactByEmail(organizationId: string, email: string): Promise<ContactSnapshot | null>;
  claimEvent(provider: string, externalId: string): Promise<'new' | 'duplicate'>;
}

/**
 * In-memory stores used by the verify script. Hold placement is serialized and
 * rejects overlaps the same way the btree_gist exclusion constraint does, so
 * two concurrent bookings cannot both keep a hold.
 */
export class MemoryCalendarDb implements CalendarRepository {
  holds: HoldRecord[] = [];
  meetings: MeetingRecord[] = [];
  timeline: TimelineRow[] = [];
  contacts = new Map<string, ContactSnapshot>();
  claimedEvents = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();

  private lock<T>(fn: () => T): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  releaseExpired(now: Date): Promise<void> {
    return this.lock(() => {
      for (const hold of this.holds) {
        if (hold.status === 'held' && hold.expiresAt.getTime() <= now.getTime()) hold.status = 'expired';
      }
    });
  }

  listActiveHolds(organizationId: string, rangeStart: Date, rangeEnd: Date, now: Date): Promise<HoldRecord[]> {
    return this.lock(() => this.holds.filter((hold) =>
      hold.organizationId === organizationId
      && hold.status === 'held'
      && hold.expiresAt.getTime() > now.getTime()
      && rangesOverlap(hold.start.getTime(), hold.end.getTime(), rangeStart.getTime(), rangeEnd.getTime())));
  }

  placeHold(row: HoldRecord): Promise<HoldRecord> {
    return this.lock(() => {
      const now = Date.now();
      const conflict = this.holds.some((hold) =>
        hold.organizationId === row.organizationId
        && hold.status === 'held'
        && hold.expiresAt.getTime() > now
        && rangesOverlap(hold.start.getTime(), hold.end.getTime(), row.start.getTime(), row.end.getTime()));
      if (conflict) throw new CalendarExclusionError();
      this.holds.push(row);
      return row;
    });
  }

  updateHold(id: string, patch: Partial<Pick<HoldRecord, 'status' | 'meetingId'>>): Promise<void> {
    return this.lock(() => {
      const hold = this.holds.find((item) => item.id === id);
      if (!hold) return;
      if (patch.status) hold.status = patch.status;
      if (patch.meetingId !== undefined) hold.meetingId = patch.meetingId;
    });
  }

  async insertMeeting(row: MeetingRecord): Promise<void> {
    this.meetings.push(row);
  }

  async updateMeeting(id: string, patch: Partial<MeetingRecord>): Promise<void> {
    const meeting = this.meetings.find((item) => item.id === id);
    if (!meeting) return;
    Object.assign(meeting, patch, { metadata: patch.metadata ?? meeting.metadata, attendees: patch.attendees ?? meeting.attendees });
  }

  async getMeeting(id: string): Promise<MeetingRecord | null> {
    return this.meetings.find((item) => item.id === id) ?? null;
  }

  async listMeetings(organizationId: string, rangeStart: Date, rangeEnd: Date): Promise<MeetingRecord[]> {
    return this.meetings.filter((meeting) =>
      meeting.organizationId === organizationId
      && rangesOverlap(meeting.start.getTime(), meeting.end.getTime(), rangeStart.getTime(), rangeEnd.getTime()));
  }

  async findMeetingByExternal(provider: string, externalEventId: string): Promise<MeetingRecord | null> {
    return this.meetings.find((meeting) => meeting.provider === provider && meeting.externalEventId === externalEventId) ?? null;
  }

  async appendTimeline(row: TimelineRow): Promise<void> {
    this.timeline.push(row);
  }

  async timelineForContact(organizationId: string, contactId: string): Promise<TimelineRow[]> {
    return this.timeline.filter((row) => row.organizationId === organizationId && row.contactId === contactId);
  }

  async getContact(organizationId: string, contactId: string): Promise<ContactSnapshot | null> {
    const contact = this.contacts.get(`${organizationId}:${contactId}`);
    return contact ?? null;
  }

  async findContactByEmail(organizationId: string, email: string): Promise<ContactSnapshot | null> {
    const needle = email.trim().toLowerCase();
    for (const [key, contact] of this.contacts) {
      if (!key.startsWith(`${organizationId}:`)) continue;
      if (contact.email?.toLowerCase() === needle) return contact;
    }
    return null;
  }

  async claimEvent(provider: string, externalId: string): Promise<'new' | 'duplicate'> {
    const key = `${provider}:${externalId}`;
    if (this.claimedEvents.has(key)) return 'duplicate';
    this.claimedEvents.add(key);
    return 'new';
  }
}

export function newId(): string {
  return randomUUID();
}
