import { eq } from 'drizzle-orm';
import { agents, db } from '@workspace/db';
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import {
  CalendarNotConnectedError,
  DoNotContactError,
  SlotUnavailableError,
} from './errors.js';
import { calendarOrganizationId, getCalendarBookingService } from './production.js';

/**
 * Read tools plus a booking request. The request creates the Google event with
 * sendUpdates="none". It cannot clear the send safeguard or choose sendUpdates.
 */
const agendaSchema = z.object({
  start: z.string().optional().describe('Range start ISO timestamp. Defaults to now.'),
  end: z.string().optional().describe('Range end ISO timestamp. Defaults to 7 days after start.'),
});

const slotsSchema = z.object({
  start: z.string().describe('Search range start ISO timestamp'),
  end: z.string().describe('Search range end ISO timestamp'),
  duration_minutes: z.number().int().positive().max(240).optional(),
});

const requestSchema = z.object({
  start: z.string().describe('Slot start ISO timestamp'),
  end: z.string().describe('Slot end ISO timestamp'),
  title: z.string().min(1).max(200),
  attendee_email: z.string().email().optional(),
  attendee_name: z.string().max(160).optional(),
  contact_id: z.string().uuid().optional(),
  notes: z.string().max(1000).optional(),
});

export function createCalendarTools(): ToolDefinition[] {
  const agenda: ToolDefinition<z.infer<typeof agendaSchema>> = {
    name: 'calendar_get_agenda',
    description: 'Read Matthew\'s APEX calendar agenda (Google events plus APEX holds) for a time range. Read-only. Times are stored in UTC and labeled in the booking timezone, default America/Chicago.',
    schema: agendaSchema,
    requiresApproval: false,
    async execute(input) {
      const start = input.start ? new Date(input.start) : new Date();
      const end = input.end ? new Date(input.end) : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return { connected: false, error: 'start and end must be ISO timestamps' };
      }
      try {
        const items = await getCalendarBookingService().agenda(calendarOrganizationId(), start, end);
        return { connected: true, items };
      } catch (err) {
        return { connected: false, error: message(err) };
      }
    },
  };

  const slots: ToolDefinition<z.infer<typeof slotsSchema>> = {
    name: 'calendar_find_slots',
    description: 'Find bookable slots on Matthew\'s calendar. Checks Google free/busy across the busy calendars, then working hours, buffers, no-book blocks, daily cap, and minimum notice. Does not book.',
    schema: slotsSchema,
    requiresApproval: false,
    async execute(input) {
      const start = new Date(input.start);
      const end = new Date(input.end);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return { slots: [], error: 'start and end must be ISO timestamps' };
      }
      try {
        const found = await getCalendarBookingService().findSlots(
          calendarOrganizationId(),
          start,
          end,
          input.duration_minutes,
        );
        return {
          slots: found.map((slot) => ({ start: slot.start.toISOString(), end: slot.end.toISOString() })),
        };
      } catch (err) {
        if (err instanceof CalendarNotConnectedError) return { slots: [], error: 'Live calendar is not connected' };
        return { slots: [], error: message(err) };
      }
    },
  };

  const request: ToolDefinition<z.infer<typeof requestSchema>> = {
    name: 'calendar_request_booking',
    description: 'Request a booking on Matthew\'s Google calendar through the APEX booking service. Creates the event with sendUpdates=none. Does not send an invite: the invite waits in Pending sends until Matthew clears and releases it. Cannot bypass do-not-contact, the kill switch, or the send safeguard.',
    schema: requestSchema,
    requiresApproval: false,
    async execute(input, context) {
      try {
        const result = await getCalendarBookingService().book({
          organizationId: calendarOrganizationId(),
          start: new Date(input.start),
          end: new Date(input.end),
          title: input.title,
          attendeeEmail: input.attendee_email ?? null,
          attendeeName: input.attendee_name ?? null,
          contactId: input.contact_id ?? null,
          notes: input.notes ?? null,
          actor: { kind: 'agent', id: context.agentId, name: await actorDisplayName(context.agentId) },
        });
        return {
          booked: true,
          meeting_id: result.meeting.id,
          start: result.meeting.start.toISOString(),
          end: result.meeting.end.toISOString(),
          invite_sent: false,
          invite_status: result.invite === null
            ? 'no_external_attendee'
            : result.invite.sendJobId ? 'waiting_in_pending_sends' : `not_queued:${result.invite.blockedReason ?? 'unknown'}`,
          send_job_id: result.invite?.sendJobId ?? null,
          google_send_updates: result.googleSendUpdates,
          message: 'Event created. The invite is not sent until Matthew clears and releases it in Pending sends.',
        };
      } catch (err) {
        if (err instanceof DoNotContactError) return { booked: false, error: 'Contact opted out' };
        if (err instanceof SlotUnavailableError) return { booked: false, error: err.message };
        if (err instanceof CalendarNotConnectedError) return { booked: false, error: 'Live calendar is not connected' };
        return { booked: false, error: message(err) };
      }
    },
  };

  return [agenda, slots, request];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'Calendar request failed';
}

async function actorDisplayName(agentId: string): Promise<string> {
  try {
    const [row] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1);
    const name = row?.name?.trim();
    if (name) return name;
  } catch {
    // A directory miss still books. The footer falls back to the agent id.
  }
  return agentId;
}
