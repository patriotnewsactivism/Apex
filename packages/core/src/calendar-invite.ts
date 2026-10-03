// Calendar invites have no live provider in APEX. The scheduler panels are a
// read-only agenda. This function is the only invite delivery path, and it
// still has to clear the send safeguard before it can fail closed.

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
