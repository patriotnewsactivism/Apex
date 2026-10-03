// Calendar invites go through the send safeguard like every other outbound
// send. Booking stages the invite in Pending sends; the attendee hears nothing
// until the operator clears and releases it, and the release re-checks the gate.

import {
  assertSendAllowed,
  openOutboundSendJob,
  recordOutboundSendResult,
  SendSafeguardError,
  type SendRecipientRecord,
} from '../send-safeguard.js';
import type { SendJobKind } from './types.js';

export const GOOGLE_INVITE_KIND = 'google_calendar_invite';

export interface StageInviteInput {
  organizationId: string;
  meetingId: string;
  inviteKind: SendJobKind;
  email: string;
  createdBy: string;
  messageText: string;
}

/** sendJobId is null when the safeguard refused to queue it; blockedReason says why. */
export interface StagedInvite {
  sendJobId: string | null;
  blockedReason: string | null;
}

export interface InviteGatePort {
  stage(input: StageInviteInput): Promise<StagedInvite>;
}

export const sendSafeguardInviteGate: InviteGatePort = {
  async stage(input) {
    try {
      const opened = await openOutboundSendJob({
        caller: 'tool',
        createdBy: input.createdBy,
        // One story per organization, so the operator code at five invites in
        // 24 hours counts every calendar invite, not each one alone.
        storyKey: `calendar:${input.organizationId}`,
        recipients: [{
          channel: 'calendar',
          destination: input.email,
          messageText: input.messageText,
          payload: {
            kind: GOOGLE_INVITE_KIND,
            inviteKind: input.inviteKind,
            organizationId: input.organizationId,
            meetingId: input.meetingId,
          },
        }],
      });
      return { sendJobId: opened.jobId, blockedReason: null };
    } catch (error) {
      if (error instanceof SendSafeguardError) return { sendJobId: null, blockedReason: error.reason };
      throw error;
    }
  },
};

export interface InviteDeliverer {
  deliverStagedInvite(input: { inviteKind: SendJobKind; organizationId: string; meetingId: string }): Promise<string>;
}

/** Send-safeguard transport for GOOGLE_INVITE_KIND, run when the operator releases the invite. */
export async function deliverReleasedCalendarInvite(
  service: InviteDeliverer,
  jobId: string,
  recipient: SendRecipientRecord,
): Promise<boolean> {
  let recipientId: string;
  try {
    recipientId = (await assertSendAllowed(jobId, recipient.destination, 'calendar')).id;
  } catch (error) {
    if (error instanceof SendSafeguardError) return false;
    throw error;
  }
  const { inviteKind, organizationId, meetingId } = recipient.payload;
  if ((inviteKind !== 'invite' && inviteKind !== 'reschedule' && inviteKind !== 'cancellation')
    || typeof organizationId !== 'string' || typeof meetingId !== 'string') {
    await recordOutboundSendResult(jobId, recipientId, 'failed', null);
    return false;
  }
  try {
    const eventId = await service.deliverStagedInvite({ inviteKind, organizationId, meetingId });
    await recordOutboundSendResult(jobId, recipientId, 'sent', eventId);
    return true;
  } catch (error) {
    console.error(`[calendar] invite delivery failed job=${jobId} reason=${error instanceof Error ? error.message : 'error'}`);
    await recordOutboundSendResult(jobId, recipientId, 'failed', null);
    return false;
  }
}
