import { Router } from 'express';
import crypto from 'crypto';

// ─── Vapi Webhook Route ──────────────────────────────────────────────────────
//
// Receives server events from legacy Vapi.ai calls. New outbound calls route
// through Telnyx Call Bridge; this remains for historical call-status/outcome
// compatibility and any still-configured inbound Vapi surface. Mounted BEFORE
// requireAdminAuth because Vapi's server can't send a Bearer token — it's a
// server-to-server webhook. Optionally protected by a shared-secret header
// (VAPI_WEBHOOK_SECRET) if configured.
//
// Handles:
// 1. function-call — AI called send_checkout_link during the call → create
//    Stripe checkout session, return URL to Vapi so the AI can tell the prospect
// 2. end-of-call-report — call ended → log transcript + analysis
// 3. status-update — call status changed → log
// 4. transcript — transcript segment

// Stripe price IDs for BuildMyBot plans (created in live mode 2026-07-29)
const STRIPE_PRICE_IDS: Record<string, string> = {
  starter: 'price_1TyfHGPsMOv0Yp98fVSogjlR',       // $29/mo
  professional: 'price_1TyfHGPsMOv0Yp98Ao8RY727',    // $99/mo
  executive: 'price_1TyfHHPsMOv0Yp98TrxcB7tx',      // $199/mo
  enterprise: 'price_1TyfHHPsMOv0Yp98AO4KJBf4',     // $499/mo
};

const PLAN_NAMES: Record<string, string> = {
  starter: 'Starter ($29/mo)',
  professional: 'Professional ($99/mo)',
  executive: 'Executive ($199/mo)',
  enterprise: 'Enterprise ($499/mo)',
};

// ─── record_meeting_outcome date resolution ─────────────────────────────────
//
// The AI gives us a date, a time, and one of four US region names -- never a
// raw UTC offset, because "what's the UTC offset for Pacific time on
// September 23rd" is not a question a prospect-facing sales call should be
// asking anyone. Region names need real IANA timezone data to resolve
// correctly across a DST transition, and no timezone library is a dependency
// of this repo, so this leans on the ICU data already built into Node itself.
const US_REGION_TO_IANA_ZONE: Record<string, string> = {
  Eastern: 'America/New_York',
  Central: 'America/Chicago',
  Mountain: 'America/Denver',
  Pacific: 'America/Los_Angeles',
};

/**
 * Resolve a wall-clock date + time in a named US region to the real UTC
 * instant, correctly across DST, with no timezone library.
 *
 * The trick: format a naive UTC guess back out AS IF it were already in the
 * target zone, using Intl.DateTimeFormat (backed by the runtime's real IANA
 * tzdata). The difference between that and the guess is the zone's actual
 * offset in effect at that moment -- DST included -- so one correction is
 * exact for every real-world zone, all of which sit on whole/half-hour
 * offsets with no sub-minute drift near a transition.
 *
 * Returns null on anything unparseable rather than guessing -- a wrong
 * appointment time is worse than a missing one, since nobody would think to
 * double check a value that is merely displayed with confidence.
 */
export function zonedTimeToUtc(
  dateStr: string | undefined,
  timeStr: string | undefined,
  region: string | undefined,
): Date | null {
  if (!dateStr || !timeStr || !region) return null;
  const zone = US_REGION_TO_IANA_ZONE[region];
  if (!zone) return null;

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!dateMatch || !timeMatch) return null;

  const [, y, mo, d] = dateMatch;
  const [, h, mi] = timeMatch;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute);

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(new Date(guessUtcMs));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const asIfUtcMs = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  if (!Number.isFinite(asIfUtcMs)) return null;

  const offsetMs = asIfUtcMs - guessUtcMs;
  return new Date(guessUtcMs - offsetMs);
}

/** Fallback disposition when the call ended before record_meeting_outcome was
 *  ever called (voicemail, hang-up, no-answer never give the AI the chance).
 *  Conservative on purpose: 'no_decision' rather than guessing interest from
 *  endedReason strings that vary by provider and change without notice. */
export function fallbackDispositionFromEndedReason(
  endedReason: string,
  opts: { unanswered?: boolean } = {},
): 'voicemail' | 'no_answer' | 'no_decision' {
  // Rang out with zero customer audio (isUnansweredNoAudio): a no-answer.
  if (opts.unanswered) return 'no_answer';
  const reason = endedReason.toLowerCase();
  if (reason.includes('voicemail')) return 'voicemail';
  if (reason.includes('no-answer') || reason.includes('customer-did-not-answer')) return 'no_answer';
  return 'no_decision';
}

/** Queue (never place) a retry for an unanswered call. The retry is a
 *  pending task for the sales agent with nextRetryAt set; when it runs, the
 *  agent's make_outbound_call goes through the normal outbound gate (kill
 *  switch, outbound mode, rehearsal allowlist, daily caps, DNC/suppression,
 *  calling window). Limits: planNoAnswerRetry in @workspace/core. */
export async function scheduleNoAnswerRetry(input: {
  callId: string;
  customerNumber: string;
  customerName?: string | null;
  leadId?: string | null;
  now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();
  const { db, tasks, callOutcomes } = await import('@workspace/db');
  const { and, eq, gte, sql } = await import('drizzle-orm');
  const { loadOutboundPolicy, planNoAnswerRetry, NO_ANSWER_RETRY_TASK_KIND } = await import('@workspace/core');
  const policy = await loadOutboundPolicy(now);
  const since = new Date(now.getTime() - 36 * 60 * 60 * 1000);
  const leadKey = input.leadId || input.customerNumber;

  const prior = await db
    .select({ createdAt: tasks.createdAt, nextRetryAt: tasks.nextRetryAt, context: tasks.context })
    .from(tasks)
    .where(and(
      gte(tasks.createdAt, since),
      sql`${tasks.context}->>'kind' = ${NO_ANSWER_RETRY_TASK_KIND}`,
      sql`${tasks.context}->>'leadKey' = ${leadKey}`,
    ));
  if (prior.some((t) => (t.context as Record<string, unknown> | null)?.sourceCallId === input.callId)) {
    return 'retry already scheduled for this call';
  }
  const attempts = await db
    .select({ createdAt: callOutcomes.createdAt })
    .from(callOutcomes)
    .where(and(eq(callOutcomes.customerNumber, input.customerNumber), gte(callOutcomes.createdAt, since)));

  const plan = planNoAnswerRetry({
    now,
    policy,
    retriesScheduled: prior.map((t) => t.nextRetryAt ?? t.createdAt),
    attempts: attempts.map((a) => a.createdAt),
  });
  if (!plan.schedule) return `no retry: ${plan.reason}`;

  const masked = `***${input.customerNumber.replace(/\D/g, '').slice(-4)}`;
  await db.insert(tasks).values({
    id: crypto.randomUUID(),
    title: `No-answer retry ${plan.retryNumber} for ${input.customerName || masked}`,
    description:
      `The previous call (${input.callId}) rang but was never answered (no customer audio). ` +
      `Retry the call with make_outbound_call to ${input.customerNumber}` +
      (input.leadId ? ` (leadId ${input.leadId})` : '') +
      '. This is a normal outbound call: it must pass the outbound gate. If the gate denies it ' +
      '(kill switch, outbound mode, caps, DNC, calling window), do not retry again; record it and stop.',
    status: 'pending',
    priority: 5,
    assignedAgentId: 'apex-sales-001',
    createdByAgentId: 'apex-sales-001',
    nextRetryAt: plan.notBefore,
    maxRetries: 0,
    context: {
      kind: NO_ANSWER_RETRY_TASK_KIND,
      leadKey,
      leadId: input.leadId ?? null,
      customerNumber: input.customerNumber,
      sourceCallId: input.callId,
      retryNumber: plan.retryNumber,
      notBefore: plan.notBefore.toISOString(),
    },
    createdAt: now,
    updatedAt: now,
  });
  return `retry ${plan.retryNumber} queued for ${plan.notBefore.toISOString()}`;
}

async function createStripeCheckoutSession(plan: string, email: string): Promise<{ checkoutUrl?: string; error?: string }> {
  const stripeKey = process.env.STRIPE_SECRET_KEY || process.env.BUILDMYBOT_STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return { error: 'Stripe not configured on the server' };
  }

  const priceId = STRIPE_PRICE_IDS[plan] || STRIPE_PRICE_IDS.starter;
  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');
  params.append('success_url', 'https://www.buildmybot.app/dashboard?upgraded=true');
  params.append('cancel_url', 'https://www.buildmybot.app/pricing');
  if (email) {
    params.append('customer_email', email);
  }
  params.append('subscription_data[metadata][source]', 'apex_sales_call');
  params.append('subscription_data[metadata][plan]', plan);

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const data: any = await res.json();
  if (data.url) {
    return { checkoutUrl: data.url };
  }
  return { error: data.error?.message || 'Failed to create checkout session' };
}

export function createVapiWebhookRouter(): Router {
  const router = Router();

  router.post('/webhook', async (req, res) => {
    try {
      // Shared-secret verification is required. Webhooks are server-to-server,
      // so we cannot use a bearer token, but we still need to verify sender.
      const secret = process.env.VAPI_WEBHOOK_SECRET;
      if (!secret) {
        console.error('[Vapi] VAPI_WEBHOOK_SECRET is not configured; rejecting webhook');
        return res.status(500).json({ error: 'Webhook secret not configured' });
      }
      const received = req.headers['x-webhook-secret'] as string | undefined;
      if (!received || received.length !== secret.length) {
        return res.status(403).json({ error: 'Invalid webhook secret' });
      }
      try {
        if (!crypto.timingSafeEqual(Buffer.from(received), Buffer.from(secret))) {
          return res.status(403).json({ error: 'Invalid webhook secret' });
        }
      } catch {
        return res.status(403).json({ error: 'Invalid webhook secret' });
      }

      const message = req.body?.message;
      if (!message || !message.type) {
        res.status(200).json({ received: true });
        return;
      }

      const { db, logs, callOutcomes } = await import('@workspace/db');

      switch (message.type) {
        // ── Function call: AI called a tool during the conversation ──────────
        case 'function-call': {
          const fnName = message.functionCall?.name;
          const args = message.functionCall?.arguments || {};
          const callId = message.call?.id ?? 'unknown';
          const customerNumber = message.call?.customer?.number ?? '';
          const customerName = message.call?.customer?.name ?? '';

          console.log(`[Vapi] Function call: ${fnName}(${JSON.stringify(args)}) on call ${callId}`);

          if (fnName === 'record_meeting_outcome') {
            const disposition =
              typeof args.disposition === 'string' &&
              ['appointment_booked', 'callback_requested', 'not_interested', 'no_decision'].includes(args.disposition)
                ? args.disposition
                : 'no_decision';
            const appointmentDateRaw = typeof args.appointmentDate === 'string' ? args.appointmentDate : null;
            const appointmentTimeRaw = typeof args.appointmentTime === 'string' ? args.appointmentTime : null;
            const appointmentTimezoneRaw = typeof args.appointmentTimezone === 'string' ? args.appointmentTimezone : null;
            const contactEmail = typeof args.contactEmail === 'string' ? args.contactEmail.trim() || null : null;
            const objection = typeof args.objection === 'string' ? args.objection : null;
            const nextAction = typeof args.nextAction === 'string' ? args.nextAction : null;

            const appointmentAt =
              disposition === 'appointment_booked'
                ? zonedTimeToUtc(appointmentDateRaw ?? undefined, appointmentTimeRaw ?? undefined, appointmentTimezoneRaw ?? undefined)
                : null;

            if (callId === 'unknown') {
              console.warn('[Vapi] record_meeting_outcome fired with no call id -- cannot persist');
            } else {
              // ON CONFLICT rather than a select-then-branch: two rapid function
              // calls on the same call_id (the AI correcting itself mid-call)
              // must not race into two rows or lose the second call's update.
              await db
                .insert(callOutcomes)
                .values({
                  id: crypto.randomUUID(),
                  callId,
                  customerNumber,
                  customerName: customerName || null,
                  disposition,
                  appointmentAt,
                  appointmentDateRaw,
                  appointmentTimeRaw,
                  appointmentTimezoneRaw,
                  contactEmail,
                  objection,
                  nextAction,
                  createdByAgentId: 'apex-sales-001',
                  createdAt: new Date(),
                  updatedAt: new Date(),
                })
                .onConflictDoUpdate({
                  target: callOutcomes.callId,
                  set: {
                    disposition,
                    appointmentAt,
                    appointmentDateRaw,
                    appointmentTimeRaw,
                    appointmentTimezoneRaw,
                    contactEmail,
                    objection,
                    nextAction,
                    updatedAt: new Date(),
                  },
                });
            }

            const dispositionLabel = disposition.replace(/_/g, ' ');
            const appointmentLine =
              disposition === 'appointment_booked'
                ? appointmentAt
                  ? ` -- ${appointmentAt.toISOString()} (${appointmentTimezoneRaw ?? 'timezone unclear'}, parsed from "${appointmentDateRaw} ${appointmentTimeRaw}")`
                  : ` -- date/time given ("${appointmentDateRaw} ${appointmentTimeRaw} ${appointmentTimezoneRaw}") could not be parsed; recorded as text only`
                : '';
            await db.insert(logs).values({
              agentId: 'apex-sales-001',
              taskId: null,
              level: 'info',
              message: `📅 Call outcome recorded — ${dispositionLabel}${appointmentLine} — ${customerName || customerNumber}`,
              timestamp: new Date(),
            });

            console.log(`[Vapi] record_meeting_outcome: ${disposition} on call ${callId}${appointmentAt ? ` @ ${appointmentAt.toISOString()}` : ''}`);

            return res.json({
              result: {
                success: true,
                disposition,
                appointmentAt: appointmentAt ? appointmentAt.toISOString() : null,
                message:
                  disposition === 'appointment_booked'
                    ? appointmentAt
                      ? `Recorded. Confirm it back to them naturally, then wrap up.`
                      : `Recorded, but I could not parse that date/time precisely -- read it back to the prospect to confirm, and it will still be saved as text for a human to follow up on.`
                    : 'Recorded.',
              },
            });
          }

          if (fnName === 'send_checkout_link') {
            const rawPlan = args.plan || 'starter';
            const plan = Object.prototype.hasOwnProperty.call(STRIPE_PRICE_IDS, rawPlan)
              ? rawPlan
              : 'starter';
            const email = typeof args.email === 'string' ? args.email : '';

            const result = await createStripeCheckoutSession(plan, email);

            if (result.checkoutUrl) {
              await db.insert(logs).values({
                agentId: 'apex-sales-001',
                taskId: null,
                level: 'info',
                message: `💰 Checkout link created — ${PLAN_NAMES[plan] || plan} → ${email || customerNumber}. URL: ${result.checkoutUrl.slice(0, 80)}...`,
                timestamp: new Date(),
              });

              console.log(`[Vapi] Checkout session created for ${email || customerNumber}: ${PLAN_NAMES[plan]}`);
              return res.json({
                result: {
                  success: true,
                  checkoutUrl: result.checkoutUrl,
                  plan: PLAN_NAMES[plan] || plan,
                  message: `Checkout link created successfully. The prospect can sign up at ${result.checkoutUrl}`,
                },
              });
            } else {
              console.error(`[Vapi] Checkout failed: ${result.error}`);
              return res.json({
                result: {
                  success: false,
                  error: result.error,
                  message: `I wasn't able to create a checkout link right now. I'll have someone follow up via email.`,
                },
              });
            }
          }

          // Unknown function — acknowledge but don't error
          return res.json({ result: { message: 'Function not implemented' } });
        }

        // ── End of call report ───────────────────────────────────────────────
        case 'end-of-call-report': {
          const call = message.call ?? {};
          const analysis = call.analysis ?? {};
          const artifact = call.artifact ?? message.artifact ?? {};
          const transcript = artifact.transcript ?? '';
          const endedReason = message.endedReason ?? call.endedReason ?? 'unknown';
          const cost = call.cost ?? 0;
          const callId = call.id;
          const perf = artifact.performanceMetrics ?? call.performanceMetrics ?? {};
          const latencyParts = [
            typeof perf.turnLatencyAverage === 'number'
              ? `turn=${Math.round(perf.turnLatencyAverage * 1000)}ms`
              : '',
            typeof perf.endpointingLatencyAverage === 'number'
              ? `endpoint=${Math.round(perf.endpointingLatencyAverage * 1000)}ms`
              : '',
            typeof perf.modelLatencyAverage === 'number'
              ? `model=${Math.round(perf.modelLatencyAverage * 1000)}ms`
              : '',
            typeof perf.voiceLatencyAverage === 'number'
              ? `voice=${Math.round(perf.voiceLatencyAverage * 1000)}ms`
              : '',
            typeof perf.transcriberLatencyAverage === 'number'
              ? `transcriber=${Math.round(perf.transcriberLatencyAverage * 1000)}ms`
              : '',
          ].filter(Boolean);
          const latencySummary = latencyParts.length > 0
            ? ` Latency: ${latencyParts.join(', ')}.`
            : '';

          await db.insert(logs).values({
            agentId: 'apex-sales-001',
            taskId: null,
            level: 'info',
            message: `📞 Outbound call ended — ${endedReason}. Cost: ${Number(cost).toFixed(2)}.${latencySummary} Summary: ${analysis.summary ?? 'N/A'}${transcript ? ` | Transcript: ${transcript.slice(0, 500)}...` : ''}`,
            timestamp: new Date(),
          });

          // Enrich the structured row rather than replace it: if
          // record_meeting_outcome already ran, this must add transcript/
          // cost/endedReason WITHOUT touching the disposition or appointment
          // it already captured. If it never ran (voicemail, no answer, a
          // hang-up before the AI could call it), this INSERTs the only
          // record that call will ever get, with a conservative disposition
          // derived from endedReason -- never left silently unrecorded.
          // A ringing, never-answered call ends with
          // "...assistant-did-not-receive-customer-audio" and zero customer
          // speech. That is a no-answer, not a failure (Telnyx showed 0s
          // connected). See packages/core/src/no-answer-retry.ts.
          const { isUnansweredNoAudio } = await import('@workspace/core');
          const unanswered = isUnansweredNoAudio({
            endedReason,
            transcript,
            messages: artifact.messages ?? message.messages ?? call.messages,
          });

          if (callId) {
            const customerNumber = call.customer?.number ?? '';
            const customerName = call.customer?.name ?? '';
            await db
              .insert(callOutcomes)
              .values({
                id: crypto.randomUUID(),
                callId,
                customerNumber,
                customerName: customerName || null,
                disposition: fallbackDispositionFromEndedReason(String(endedReason), { unanswered }),
                summary: typeof analysis.summary === 'string' ? analysis.summary : null,
                transcript: transcript || null,
                endedReason: String(endedReason),
                costUsd: typeof cost === 'number' ? cost : Number(cost) || null,
                createdByAgentId: 'apex-sales-001',
                createdAt: new Date(),
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: callOutcomes.callId,
                set: {
                  summary: typeof analysis.summary === 'string' ? analysis.summary : null,
                  transcript: transcript || null,
                  endedReason: String(endedReason),
                  costUsd: typeof cost === 'number' ? cost : Number(cost) || null,
                  updatedAt: new Date(),
                },
              });
            if (unanswered && customerNumber) {
              try {
                const outcome = await scheduleNoAnswerRetry({
                  callId,
                  customerNumber,
                  customerName,
                  leadId: typeof call.metadata?.leadId === 'string' ? call.metadata.leadId : null,
                });
                console.info(`[Vapi] no-answer ${callId}: ${outcome}`);
              } catch (error) {
                console.warn('[Vapi] no-answer retry scheduling failed', error instanceof Error ? error.message : String(error));
              }
            }
          } else {
            console.warn('[Vapi] end-of-call-report with no call id -- cannot persist call_outcomes row');
          }

          console.log(`[Vapi] Call ended: ${call.id}, reason: ${endedReason}, cost: $${cost}, summary: ${(analysis.summary ?? '').slice(0, 100)}`);
          break;
        }

        // ── Status update ────────────────────────────────────────────────────
        case 'status-update': {
          const status = message.status ?? 'unknown';
          const callId = message.call?.id ?? 'unknown';
          console.log(`[Vapi] Call ${callId} status: ${status}`);

          if (status === 'ringing' || status === 'in-progress') {
            await db.insert(logs).values({
              agentId: 'apex-sales-001',
              taskId: null,
              level: 'acting',
              message: `📞 Outbound call ${status}${callId !== 'unknown' ? ` (ID: ${callId})` : ''}`,
              timestamp: new Date(),
            });
          }
          break;
        }

        // ── Transcript ──────────────────────────────────────────────────────
        case 'transcript': {
          if (message.transcriptType === 'final') {
            console.log(`[Vapi] Final transcript segment received`);
          }
          break;
        }

        default:
          break;
      }

      return res.status(200).json({ received: true });
    } catch (err) {
      console.error('[Vapi] Webhook error:', err instanceof Error ? err.message : String(err));
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return router;
}
