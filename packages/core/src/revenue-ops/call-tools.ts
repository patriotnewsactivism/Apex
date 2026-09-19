// ─── Revenue Operations Call Tools ────────────────────────────────────────────
//
// Outbound AI call lifecycle tools for revenue-ops campaigns.
// These tools orchestrate the call state machine; the actual provider dispatch
// is handled by voice-router.ts + provider adapters.
//
// Call state machine:
//   requested → queued → initiated → ringing → answered → bridged → completed | failed
//
// call_disposition enums:
//   human | voicemail | no_answer | busy | wrong_number | interested | not_interested |
//   callback | qualified | booked | dnc | failed

import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { initiateOutboundCall, recordCallCompletion, recordCallFailure, type CallDisposition } from './voice-router.js';
import { db, calls } from '@workspace/db';
import { eq } from 'drizzle-orm';

// ─── Tools ─────────────────────────────────────────────────────────────────────

export const revenueCallTools: ToolDefinition[] = [
  {
    name: 'call_initiate',
    description:
      'Start an outbound AI voice call to a contact. Selects an eligible telephony provider using the voice router, creates the call record, and dispatches to the provider adapter. Returns the call ID immediately; the call lifecycle (ringing/answered/completed) is tracked asynchronously via webhooks.',
    schema: z.object({
      organizationId: z.string().describe('Organization/project UUID'),
      contactId: z.string().describe('Contact UUID to call'),
      missionId: z.string().optional().describe('Mission UUID (goals.id) this call belongs to'),
      campaignId: z.string().optional().describe('Campaign UUID (campaigns.id) this call belongs to'),
      toNumber: z.string().describe('E.164 phone number to call'),
      fromNumber: z.string().optional().describe('E.164 number to call from (uses provider default if omitted)'),
      providerConnectionId: z.string().optional().describe('Specific provider connection to use (let router select if omitted)'),
      strategyId: z.string().optional().describe('Outreach strategy UUID for context'),
    }),
    requiresApproval: false,
    async execute(input: z.infer<typeof this.schema>, _ctx: any) {
      const result = await initiateOutboundCall({
        organizationId: input.organizationId,
        contactId: input.contactId,
        missionId: input.missionId ?? undefined,
        campaignId: input.campaignId ?? undefined,
        toNumber: input.toNumber,
        fromNumber: input.fromNumber ?? undefined,
        providerConnectionId: input.providerConnectionId ?? undefined,
        strategyId: input.strategyId ?? undefined,
      });

      if (!result.success) {
        return { ok: false, error: result.error, callId: result.callId };
      }

      return {
        ok: true,
        callId: result.callId,
        provider: result.provider,
        providerId: result.providerId,
        status: 'requested',
        message: `Outbound call initiated to ${input.toNumber} via ${result.provider}. Call ID: ${result.callId}.`,
      };
    },
  },
  {
    name: 'call_transfer',
    description:
      'Transfer an active call to a different phone number. This is a provider-level operation — the call stays active, the new participant is added. Only works while the call is in answered/bridged state.',
    schema: z.object({
      callId: z.string().describe('Existing call UUID to transfer'),
      toNumber: z.string().describe('E.164 number to transfer to'),
      providerConnectionId: z.string().optional().describe('Provider connection for the transfer (uses call\'s provider if omitted)'),
    }),
    requiresApproval: false,
    async execute(_input: z.infer<typeof this.schema>, _ctx: any) {
      // TODO: implement provider-specific transfer dispatch.
      // For now, markers the call as transfer-pending. Real transfer requires
      // provider adapter integration (Telnyx call-control transfer API).
      return {
        ok: false,
        error: 'call_transfer is not yet wired to a provider adapter.',
        callId: _input.callId,
      };
    },
  },
  {
    name: 'call_hangup',
    description:
      'Hang up an active call. Ends the call and records the disposition. Use this when the conversation is complete or the operator intervenes.',
    schema: z.object({
      callId: z.string().describe('Call UUID to hang up'),
      disposition: z.enum(['human', 'voicemail', 'no_answer', 'busy', 'wrong_number', 'interested', 'not_interested', 'callback', 'qualified', 'booked', 'dnc', 'failed'])
        .describe('How the call ended — drives enrollment advancement and pipeline'),
      durationSeconds: z.number().optional().describe('Actual call duration in seconds'),
      recordingUri: z.string().optional().describe('Recording URL if available'),
      transcriptId: z.string().optional().describe('Transcript UUID if available'),
      errorCode: z.string().optional().describe('Telnyx/Vapi error code if the call failed'),
    }),
    requiresApproval: false,
    async execute(input: z.infer<typeof this.schema>, _ctx: any) {
      const disposition = input.disposition as CallDisposition;

      // If disposition is 'failed' and there's an error code, record as failure
      if (disposition === 'failed' && input.errorCode) {
        const success = await recordCallFailure(
          input.callId,
          disposition,
          input.errorCode,
          { errorCode: input.errorCode, message: 'Call failed' },
          'permanent',
        );
        return { ok: success, callId: input.callId, disposition, status: 'failed' };
      }

      const success = await recordCallCompletion(
        input.callId,
        disposition,
        input.durationSeconds ?? null,
        input.errorCode ?? null,
        null, // costCents — filled by webhook when billing info is available
        input.recordingUri ?? null,
        input.transcriptId ?? null,
      );

      return { ok: success, callId: input.callId, disposition, status: 'completed' };
    },
  },
  {
    name: 'call_transcript',
    description:
      'Retrieve or record the transcript for a completed call. Marks the call with a transcript ID and optionally stores the transcript URI.',
    schema: z.object({
      callId: z.string().describe('Call UUID'),
      transcriptId: z.string().describe('Transcript UUID from the provider'),
      transcriptUri: z.string().optional().describe('URL to the transcript/audio recording'),
      status: z.enum(['available', 'processing', 'failed']).optional().describe('Transcript availability status'),
    }),
    requiresApproval: false,
    async execute(input: z.infer<typeof this.schema>, _ctx: any) {
      try {
        await db.update(calls).set({
          transcriptId: input.transcriptId,
          recordingUri: input.transcriptUri ?? null,
          updatedAt: new Date(),
        }).where(eq(calls.id, input.callId));
        return { ok: true, callId: input.callId, transcriptId: input.transcriptId };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'call_status',
    description:
      'Get the current status and details of a call.',
    schema: z.object({
      callId: z.string().describe('Call UUID'),
    }),
    requiresApproval: false,
    async execute(input: z.infer<typeof this.schema>, _ctx: any) {
      try {
        const [call] = await db.select().from(calls).where(eq(calls.id, input.callId)).limit(1);
        if (!call) return { found: false, message: `Call ${input.callId} not found.` };
        return {
          found: true,
          call: {
            id: call.id,
            status: call.status,
            disposition: call.disposition,
            direction: call.direction,
            fromNumber: call.fromNumber,
            toNumber: call.toNumber,
            providerConnectionId: call.providerConnectionId,
            externalCallId: call.externalCallId,
            callControlId: call.callControlId,
            startedAt: call.startedAt?.toISOString() ?? null,
            answeredAt: call.answeredAt?.toISOString() ?? null,
            endedAt: call.endedAt?.toISOString() ?? null,
            durationSeconds: call.durationSeconds,
            recordingUri: call.recordingUri,
            transcriptId: call.transcriptId,
            costCents: call.costCents,
            errorCode: call.errorCode,
            createdAt: call.createdAt?.toISOString() ?? null,
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
];
