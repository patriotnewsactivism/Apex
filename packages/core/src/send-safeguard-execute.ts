// Dispatches a job only after the operator session has already cleared it.
// Provider functions call assertSendAllowed again at the moment of send.

import { deliverQueuedEmailSend } from './email-delivery.js';
import { startCartesiaSalesCall } from './cartesia-sales-client.js';
import { deliverCalendarInvite } from './calendar-invite.js';
import {
  getSendSafeguard,
  recordOutboundSendResult,
  runWithSendCaller,
  SendSafeguardError,
  type SendRecipientRecord,
} from './send-safeguard.js';

export async function dispatchClearedSendJob(jobId: string): Promise<{ attempted: number; sent: number; failed: number }> {
  return runWithSendCaller('operator-dashboard', async () => {
    const engine = await getSendSafeguard();
    const { job, recipients } = await engine.describe(jobId);
    if (!job.fullAuto || job.status === 'stopped' || job.status === 'waiting_confirm' || job.status === 'waiting_second_confirm' || job.status === 'waiting_code') {
      return { attempted: 0, sent: 0, failed: 0 };
    }
    let sent = 0;
    let failed = 0;
    for (const recipient of recipients) {
      if (recipient.status !== 'queued' && recipient.status !== 'released') continue;
      const ok = await deliverRecipient(jobId, recipient);
      if (ok) sent += 1;
      else failed += 1;
    }
    return { attempted: sent + failed, sent, failed };
  });
}

export async function dispatchReleasedRecipient(jobId: string, recipientId: string): Promise<{ sent: boolean }> {
  return runWithSendCaller('operator-dashboard', async () => {
    const engine = await getSendSafeguard();
    const { recipients } = await engine.describe(jobId);
    const recipient = recipients.find((row) => row.id === recipientId);
    if (!recipient) return { sent: false };
    return { sent: await deliverRecipient(jobId, recipient) };
  });
}

async function deliverRecipient(jobId: string, recipient: SendRecipientRecord): Promise<boolean> {
  const payload = recipient.payload;
  try {
    if (recipient.channel === 'email') {
      const result = await deliverQueuedEmailSend(
        String(payload.sendId ?? recipient.id),
        recipient.destination,
        String(payload.subject ?? 'Message'),
        String(payload.html ?? recipient.messageText),
        {
          sendJobId: jobId,
          text: typeof payload.text === 'string' ? payload.text : undefined,
          leadId: typeof payload.leadId === 'string' ? payload.leadId : null,
          purpose: typeof payload.purpose === 'string' ? payload.purpose : 'email_delivery',
          requireCompliance: payload.requireCompliance === true,
          postalAddress: typeof payload.postalAddress === 'string' ? payload.postalAddress : null,
          unsubscribeEmail: typeof payload.unsubscribeEmail === 'string' ? payload.unsubscribeEmail : null,
        },
      );
      return result.success;
    }
    if (recipient.channel === 'phone' && payload.kind === 'cartesia_call') {
      await startCartesiaSalesCall({
        toNumber: recipient.destination,
        customerName: typeof payload.customerName === 'string' ? payload.customerName : null,
        assistantPrompt: String(payload.assistantPrompt ?? recipient.messageText),
        firstMessage: String(payload.firstMessage ?? recipient.messageText),
        leadId: typeof payload.leadId === 'string' ? payload.leadId : null,
        campaignId: typeof payload.campaignId === 'string' ? payload.campaignId : null,
        playbookId: typeof payload.playbookId === 'string' ? payload.playbookId : null,
        createdByAgentId: typeof payload.createdByAgentId === 'string' ? payload.createdByAgentId : null,
        sendJobId: jobId,
      });
      return true;
    }
    if (recipient.channel === 'calendar' && payload.kind === 'cal_booking') {
      return runTransportHook('cal_booking', jobId, recipient);
    }
    if (recipient.channel === 'calendar') {
      await deliverCalendarInvite({
        toEmail: recipient.destination,
        summary: String(payload.summary ?? 'Invite'),
        description: String(payload.description ?? recipient.messageText),
        sendJobId: jobId,
      });
      return false;
    }
    if (payload.kind === 'telnyx_sms' || payload.kind === 'telnyx_call') {
      const delivered = await runTransportHook(payload.kind, jobId, recipient);
      return delivered;
    }
    await recordOutboundSendResult(jobId, recipient.id, 'failed', null);
    return false;
  } catch (error) {
    if (error instanceof SendSafeguardError) return false;
    console.error(
      `[send-safeguard] dispatch failed job=${jobId} channel=${recipient.channel} reason=${error instanceof Error ? error.message : 'error'}`,
    );
    return false;
  }
}

type TransportHook = (jobId: string, recipient: SendRecipientRecord) => Promise<boolean>;
const hooks = new Map<string, TransportHook>();

export function registerSendTransport(kind: string, hook: TransportHook): void {
  hooks.set(kind, hook);
}

async function runTransportHook(kind: string, jobId: string, recipient: SendRecipientRecord): Promise<boolean> {
  const hook = hooks.get(kind);
  if (!hook) {
    await recordOutboundSendResult(jobId, recipient.id, 'failed', null);
    return false;
  }
  return hook(jobId, recipient);
}
