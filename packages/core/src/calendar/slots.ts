import type { BusyInterval, CalendarSettings, MeetingRecord } from './types.js';
import { eachLocalDay, localDayKey, parseHm, rangesOverlap, zonedTimeToUtc } from './time.js';

export interface Slot {
  start: Date;
  end: Date;
}

export interface SlotSearchInput {
  rangeStart: Date;
  rangeEnd: Date;
  now: Date;
  busy: BusyInterval[];
  meetings: MeetingRecord[];
  holds: BusyInterval[];
  settings: CalendarSettings;
  durationMinutes?: number;
}

const ACTIVE_MEETING = new Set(['proposed', 'scheduled', 'cancel_pending', 'completed', 'conflict']);

export function meetingCountsTowardCap(meeting: MeetingRecord): boolean {
  return ACTIVE_MEETING.has(meeting.status);
}

export function isRangeBookable(input: {
  start: Date;
  end: Date;
  now: Date;
  busy: BusyInterval[];
  meetings: MeetingRecord[];
  holds: BusyInterval[];
  settings: CalendarSettings;
}): boolean {
  const { start, end, now, settings } = input;
  if (!(end > start)) return false;
  const noticeMs = settings.minimumNoticeMinutes * 60_000;
  if (start.getTime() < now.getTime() + noticeMs) return false;

  const windows = settings.workingHours.filter((window) => {
    const startHm = parseHm(window.start);
    const endHm = parseHm(window.end);
    return startHm && endHm;
  });
  const day = eachLocalDay(start, new Date(start.getTime() + 1), settings.timezone)[0];
  if (!day) return false;
  const window = windows.find((item) => item.day === day.weekday);
  if (!window) return false;
  const startHm = parseHm(window.start);
  const endHm = parseHm(window.end);
  if (!startHm || !endHm) return false;
  const windowStart = zonedTimeToUtc(day.year, day.month, day.day, startHm.hour, startHm.minute, settings.timezone);
  const windowEnd = endHm.hour === 24
    ? zonedTimeToUtc(day.year, day.month, day.day + 1, 0, 0, settings.timezone)
    : zonedTimeToUtc(day.year, day.month, day.day, endHm.hour, endHm.minute, settings.timezone);
  if (start < windowStart || end > windowEnd) return false;

  const expandedStart = start.getTime() - settings.bufferBeforeMinutes * 60_000;
  const expandedEnd = end.getTime() + settings.bufferAfterMinutes * 60_000;
  const blockers: BusyInterval[] = [
    ...input.busy,
    ...input.holds,
    ...input.meetings.filter(meetingCountsTowardCap).map((meeting) => ({
      start: meeting.start,
      end: meeting.end,
      source: 'meeting',
    })),
  ];
  for (const block of blockers) {
    if (rangesOverlap(expandedStart, expandedEnd, block.start.getTime(), block.end.getTime())) return false;
  }
  for (const block of settings.noBookBlocks) {
    const blockStart = new Date(block.start).getTime();
    const blockEnd = new Date(block.end).getTime();
    if (Number.isNaN(blockStart) || Number.isNaN(blockEnd)) continue;
    if (rangesOverlap(start.getTime(), end.getTime(), blockStart, blockEnd)) return false;
    if (rangesOverlap(expandedStart, expandedEnd, blockStart, blockEnd)) return false;
  }

  const dayKey = localDayKey(start, settings.timezone);
  const onDay = input.meetings.filter((meeting) =>
    meetingCountsTowardCap(meeting) && localDayKey(meeting.start, settings.timezone) === dayKey).length
    + input.holds.filter((hold) => localDayKey(hold.start, settings.timezone) === dayKey).length;
  if (onDay >= settings.maxMeetingsPerDay) return false;
  return true;
}

export function findAvailableSlots(input: SlotSearchInput): Slot[] {
  const duration = input.durationMinutes ?? input.settings.slotMinutes;
  if (duration <= 0) return [];
  const step = duration;
  const slots: Slot[] = [];
  const days = eachLocalDay(input.rangeStart, input.rangeEnd, input.settings.timezone);
  for (const day of days) {
    const windows = input.settings.workingHours.filter((window) => window.day === day.weekday);
    for (const window of windows) {
      const startHm = parseHm(window.start);
      const endHm = parseHm(window.end);
      if (!startHm || !endHm) continue;
      const windowStart = zonedTimeToUtc(day.year, day.month, day.day, startHm.hour, startHm.minute, input.settings.timezone);
      const windowEnd = endHm.hour === 24
        ? zonedTimeToUtc(day.year, day.month, day.day + 1, 0, 0, input.settings.timezone)
        : zonedTimeToUtc(day.year, day.month, day.day, endHm.hour, endHm.minute, input.settings.timezone);
      for (let cursor = windowStart.getTime(); cursor + duration * 60_000 <= windowEnd.getTime(); cursor += step * 60_000) {
        const start = new Date(cursor);
        const end = new Date(cursor + duration * 60_000);
        if (end <= input.rangeStart || start >= input.rangeEnd) continue;
        if (!isRangeBookable({
          start,
          end,
          now: input.now,
          busy: input.busy,
          meetings: input.meetings,
          holds: input.holds,
          settings: input.settings,
        })) continue;
        slots.push({ start, end });
      }
    }
  }
  return slots;
}
