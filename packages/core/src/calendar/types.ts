// Calendar booking types. Google account, busy calendars, and rules come from
// settings or env. Nothing here names a specific Google account.

export const DEFAULT_CALENDAR_TIMEZONE = 'America/Chicago';
export const DEFAULT_HOLD_MINUTES = 10;
export const DEFAULT_SLOT_MINUTES = 30;
export const SEND_CODE_THRESHOLD = 5;
export const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WorkingWindow {
  /** 0 = Sunday … 6 = Saturday, in the booking timezone. */
  day: number;
  /** Inclusive HH:mm. */
  start: string;
  /** Exclusive HH:mm. */
  end: string;
}

export interface NoBookBlock {
  id: string;
  /** UTC ISO. */
  start: string;
  /** UTC ISO. */
  end: string;
  label?: string;
}

export interface AgentColor {
  hex: string;
  /** Google Calendar colorId, "1"–"11". */
  googleColorId: string;
}

export interface CalendarSettings {
  timezone: string;
  workingHours: WorkingWindow[];
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  noBookBlocks: NoBookBlock[];
  maxMeetingsPerDay: number;
  minimumNoticeMinutes: number;
  holdMinutes: number;
  slotMinutes: number;
  /** Calendar ids whose events count as busy. Empty until the operator chooses. */
  busyCalendarIds: string[];
  /** Calendar id that receives new events. Null until chosen; the service then uses "primary". */
  bookingCalendarId: string | null;
  agentColors: Record<string, AgentColor>;
  operatorDisplayName: string;
}

export interface BusyInterval {
  start: Date;
  end: Date;
  source?: string;
}

export interface CalendarActor {
  kind: 'operator' | 'agent';
  id: string | null;
  name: string;
}

export type SendStage =
  | 'initial_check'
  | 'confirm'
  | 'second_confirm'
  | 'code_required'
  | 'cleared'
  | 'blocked';

export type SendJobKind = 'invite' | 'reschedule' | 'cancellation';

export type InviteAction = 'initial_check' | 'confirm' | 'second_confirm' | 'submit_code';

export interface HoldRecord {
  id: string;
  organizationId: string;
  start: Date;
  end: Date;
  status: 'held' | 'consumed' | 'released' | 'expired';
  holderAgentId: string | null;
  holderName: string | null;
  contactId: string | null;
  meetingId: string | null;
  expiresAt: Date;
}

export interface MeetingAttendee {
  contactId: string | null;
  email: string;
  name: string | null;
  role: 'attendee' | 'organizer';
}

export interface MeetingRecord {
  id: string;
  organizationId: string;
  contactId: string | null;
  provider: string;
  externalEventId: string | null;
  title: string;
  start: Date;
  end: Date;
  status: 'proposed' | 'scheduled' | 'cancel_pending' | 'completed' | 'cancelled' | 'no_show' | 'conflict';
  meetingUrl: string | null;
  metadata: Record<string, unknown>;
  attendees: MeetingAttendee[];
}

export interface TimelineRow {
  id: string;
  organizationId: string;
  contactId: string | null;
  kind: 'booking' | 'hold' | 'reschedule' | 'cancellation' | 'no_show';
  actorName: string;
  actorKind: 'operator' | 'agent';
  actorId: string | null;
  /** Stored in UTC. */
  occurredAt: Date;
  timezone: string;
  summary: string;
  meetingId: string | null;
}

export interface SendJobRecord {
  id: string;
  organizationId: string;
  meetingId: string;
  kind: SendJobKind;
  recipientEmails: string[];
  contactId: string | null;
  stage: SendStage;
  confirmations: number;
  /** Set when this job is the one that crosses the 5-message threshold. Never returned to agents. */
  challengeCode: string | null;
  codeRequired: boolean;
  externalEventId: string | null;
  googleCalendarId: string | null;
  blockedReason: string | null;
  createdAt: Date;
  clearedAt: Date | null;
  payload: Record<string, unknown>;
}

export interface ContactSnapshot {
  id: string;
  email: string | null;
  name: string | null;
  doNotContact: boolean;
}

export interface AgendaItem {
  id: string;
  kind: 'event' | 'hold' | 'google';
  title: string;
  start: string;
  end: string;
  startLabel: string;
  endLabel: string;
  status: string;
  agentId: string | null;
  agentName: string | null;
  color: string | null;
  googleColorId: string | null;
  contactId: string | null;
  contactName: string | null;
  meetingUrl: string | null;
  inviteStage: string | null;
}

export function defaultWorkingHours(): WorkingWindow[] {
  return [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' }));
}

export function defaultCalendarSettings(): CalendarSettings {
  return {
    timezone: DEFAULT_CALENDAR_TIMEZONE,
    workingHours: defaultWorkingHours(),
    bufferBeforeMinutes: 10,
    bufferAfterMinutes: 10,
    noBookBlocks: [],
    maxMeetingsPerDay: 8,
    minimumNoticeMinutes: 60,
    holdMinutes: DEFAULT_HOLD_MINUTES,
    slotMinutes: DEFAULT_SLOT_MINUTES,
    busyCalendarIds: [],
    bookingCalendarId: null,
    agentColors: {},
    operatorDisplayName: 'Matthew',
  };
}

/** Env wins over the saved row for the fields Matthew may set before the UI. */
export function applyCalendarEnv(settings: CalendarSettings, env: NodeJS.ProcessEnv = process.env): CalendarSettings {
  const next: CalendarSettings = {
    ...settings,
    workingHours: settings.workingHours.map((window) => ({ ...window })),
    noBookBlocks: settings.noBookBlocks.map((block) => ({ ...block })),
    busyCalendarIds: [...settings.busyCalendarIds],
    agentColors: { ...settings.agentColors },
  };
  const timezone = env.APEX_CALENDAR_TIMEZONE?.trim();
  if (timezone) next.timezone = timezone;
  const busy = env.APEX_CALENDAR_BUSY_IDS?.trim();
  if (busy) {
    next.busyCalendarIds = busy.split(',').map((id) => id.trim()).filter(Boolean);
  }
  const hold = Number(env.APEX_CALENDAR_HOLD_MINUTES);
  if (Number.isFinite(hold) && hold > 0) next.holdMinutes = hold;
  const bookingCalendar = env.APEX_CALENDAR_BOOKING_CALENDAR_ID?.trim();
  if (bookingCalendar) next.bookingCalendarId = bookingCalendar;
  const operator = env.APEX_CALENDAR_OPERATOR_NAME?.trim();
  if (operator) next.operatorDisplayName = operator;
  return next;
}

export function bookingFooter(actorName: string): string {
  return `Booked by ${actorName} via APEX`;
}

export function resolveAgentColor(settings: CalendarSettings, actor: CalendarActor): AgentColor | null {
  const keys = [actor.id, actor.name, actor.name.toLowerCase()].filter((key): key is string => Boolean(key));
  for (const key of keys) {
    const color = settings.agentColors[key];
    if (color?.googleColorId) return color;
  }
  return null;
}
