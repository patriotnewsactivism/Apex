// Google Calendar invites from the booking service are delivered by the
// google_calendar_invite transport (calendar/invite-gate.ts). Any other
// calendar recipient has no live provider: it still has to clear the send
// safeguard here before it fails closed.

import { assertSendAllowed, openOutboundSendJob, recordOutboundSendResult, SendSafeguardError } from './send-safeguard.js';

export async function deliverCalendarInvite(input: {
  toEmail: string;
  summary: string;
  description: string;
  sendJobId?: string | null;
  campaignKey?: string | null;
  storyKey?: string | null;
  createdBy?: string;
}): Promise<{ success: false; sendJobId: string; error: string }> {
  const messageText = `${input.summary}\n${input.description}`;
  let jobId = input.sendJobId ?? null;
  if (!jobId) {
    const opened = await openOutboundSendJob({
      caller: 'tool',
      createdBy: input.createdBy ?? 'calendar-invite',
      campaignKey: input.campaignKey ?? null,
      storyKey: input.storyKey ?? null,
      recipients: [{
        channel: 'calendar',
        destination: input.toEmail,
        messageText,
      }],
    });
    jobId = opened.jobId;
  }
  const cleared = await assertSendAllowed(jobId, input.toEmail, 'calendar');
  await recordOutboundSendResult(jobId, cleared.id, 'failed', null);
  throw new SendSafeguardError(
    'No calendar invite provider is configured. Nothing was sent.',
    'provider_unconfigured',
    jobId,
    'calendar',
  );
}
