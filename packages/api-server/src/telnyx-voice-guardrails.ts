// ─── Telnyx/Deepgram Voice Guardrails ────────────────────────────────────────
//
// Provides the Deepgram-flavored function declarations and a server-side
// executor for the three BuildMyBot inbound-call tools:
//
//   quote_discounted_plan  — returns plan/pricing copy (pure, no external call)
//   send_checkout_link     — creates Stripe Checkout session + SMS via Telnyx
//   transfer_to_owner      — either live SIP transfer or notify-only fallback
//
// This module is intentionally self-contained and has no dependency on the
// APEX tool registry or the agent swarm. It runs only inside a live phone
// session and is optimised for latency and side-effect clarity.

import { assertOutboundAllowed, assertContactSendable, commitSmsMessage } from '@workspace/core';
import crypto from 'crypto';
import { db, goals } from '@workspace/db';
import { desc } from 'drizzle-orm';
import { getOperatorCeo, isSessionUnlocked, unlockSession } from './apex-operator-registry.js';

// ─── Plan catalog ─────────────────────────────────────────────────────────────

interface PlanSpec {
  name: string;
  priceMonthly: number;
  priceId: string;
  summary: string;
}

const PLANS: Record<string, PlanSpec> = {
  starter: {
    name: 'Starter',
    priceMonthly: 29,
    priceId: 'price_1TyfHGPsMOv0Yp98fVSogjlR',
    summary: '1 AI bot, 500 conversations/mo, email support',
  },
  professional: {
    name: 'Professional',
    priceMonthly: 99,
    priceId: 'price_1TyfHGPsMOv0Yp98Ao8RY727',
    summary: '3 AI bots, 2,000 conversations/mo, priority support, custom branding',
  },
  executive: {
    name: 'Executive',
    priceMonthly: 199,
    priceId: 'price_1TyfHHPsMOv0Yp98TrxcB7tx',
    summary: '10 AI bots, 10,000 conversations/mo, dedicated onboarding, SLA',
  },
  enterprise: {
    name: 'Enterprise',
    priceMonthly: 499,
    priceId: 'price_1TyfHHPsMOv0Yp98AO4KJBf4',
    summary: 'Unlimited bots, unlimited conversations, white-glove support, custom contracts',
  },
};

// ─── Deepgram function declarations ──────────────────────────────────────────
//
// Deepgram's agent.think.functions format mirrors OpenAI function calling:
// { name, description, parameters: JSON Schema }. These are sent verbatim
// inside the Settings message.

export interface DeepgramFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

export function getToolDeclarationsForDeepgram(): DeepgramFunctionDeclaration[] {
  return [
    {
      name: 'quote_discounted_plan',
      description:
        'Return a concise description of BuildMyBot plans and their monthly prices. ' +
        'Call this whenever the caller asks about pricing, costs, discounts, or which plan is right for them. ' +
        'Never invent prices — always call this function to get the current figures.',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            enum: ['starter', 'professional', 'executive', 'enterprise', 'all'],
            description:
              "Specific plan to quote, or 'all' to return a comparison of every plan.",
          },
        },
        required: ['plan'],
      },
    },
    {
      name: 'send_checkout_link',
      description:
        'Create a Stripe Checkout session for the selected plan and text the link to the caller. ' +
        'Call this ONLY when the caller explicitly says they want to sign up. ' +
        'Ask for their email address first if you do not have it. ' +
        'This sends a real SMS — do not call it speculatively.',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            enum: ['starter', 'professional', 'executive', 'enterprise'],
            description: 'Plan the caller wants to subscribe to.',
          },
          email: {
            type: 'string',
            description: "Caller's email address for the Stripe pre-fill.",
          },
          phone: {
            type: 'string',
            description:
              "Caller's phone number in E.164 format for the SMS. " +
              'If omitted, the number is taken from the active call.',
          },
        },
        required: ['plan', 'email'],
      },
    },
    {
      name: 'unlock_operator',
      description:
        'Validate the operator access code spoken by the caller. ' +
        'Call this in the same turn the caller says the code. ' +
        'On success you become the Apex operator with full authority for the rest of the call. ' +
        'Never call this speculatively or with guessed codes.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'The operator access code exactly as spoken by the caller (digits only).',
          },
        },
        required: ['code'],
      },
    },
    {
      name: 'apex_goal',
      description:
        'Submit a goal to the APEX CEO, putting the AI workforce into motion on it. ' +
        'OPERATOR MODE ONLY — valid only after unlock_operator succeeds. ' +
        'Confirm the goal title and description with the caller before submitting.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short goal title (3-200 chars).',
          },
          description: {
            type: 'string',
            description: 'What the workforce should accomplish and any constraints (10+ chars).',
          },
          priority: {
            type: 'integer',
            description: '1 (highest) to 10 (lowest). Default 5.',
          },
        },
        required: ['title', 'description'],
      },
    },
    {
      name: 'apex_status',
      description:
        'Report the current status of the APEX workforce: the most recent goals and their states. ' +
        'OPERATOR MODE ONLY — valid only after unlock_operator succeeds.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'transfer_to_owner',
      description:
        'Transfer the caller to the owner / escalate urgently. ' +
        'Use when the caller explicitly asks to speak with the owner, a human, or a manager, ' +
        'or when the situation is beyond the scope of the AI agent. ' +
        'This is irreversible — confirm with the caller before calling it.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Brief reason for the transfer (shown in the alert log).',
          },
        },
        required: ['reason'],
      },
    },
  ];
}

// ─── Tool executor ────────────────────────────────────────────────────────────

export async function executeServerTool(
  name: string,
  args: Record<string, unknown>,
  callControlId: string,
  callerNumber?: string,
): Promise<Record<string, unknown>> {
  switch (name) {
    case 'quote_discounted_plan':
      return executeQuoteDiscountedPlan(args);

    case 'send_checkout_link':
      return executeSendCheckoutLink(args, callerNumber);

    case 'transfer_to_owner':
      return executeTransferToOwner(args, callControlId);

    case 'unlock_operator':
      return executeUnlockOperator(args, callControlId);

    case 'apex_goal':
      return executeApexGoal(args, callControlId);

    case 'apex_status':
      return executeApexStatus(callControlId);

    default:
      return {
        ok: false,
        error: `Unknown tool: ${name}`,
      };
  }
}

// ─── quote_discounted_plan ────────────────────────────────────────────────────

function executeQuoteDiscountedPlan(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const planKey =
    typeof args.plan === 'string' ? args.plan.toLowerCase() : 'all';

  if (planKey === 'all') {
    return {
      ok: true,
      plans: Object.entries(PLANS).map(([key, p]) => ({
        key,
        name: p.name,
        priceMonthly: p.priceMonthly,
        summary: p.summary,
      })),
      note: 'All prices in USD per month, billed monthly. Annual billing available at 20% discount.',
    };
  }

  const plan = PLANS[planKey];

  if (!plan) {
    return {
      ok: false,
      error: `Unknown plan: ${planKey}. Available: ${Object.keys(PLANS).join(', ')}`,
    };
  }

  return {
    ok: true,
    key: planKey,
    name: plan.name,
    priceMonthly: plan.priceMonthly,
    summary: plan.summary,
    note: 'Price in USD per month. Annual billing available at 20% discount.',
  };
}

// ─── send_checkout_link ───────────────────────────────────────────────────────

async function executeSendCheckoutLink(
  args: Record<string, unknown>,
  callerNumber?: string,
): Promise<Record<string, unknown>> {
  const stripeKey =
    process.env.STRIPE_SECRET_KEY ??
    process.env.BUILDMYBOT_STRIPE_SECRET_KEY;

  if (!stripeKey) {
    return { ok: false, error: 'Stripe is not configured on this server.' };
  }

  const rawPlan =
    typeof args.plan === 'string' ? args.plan.toLowerCase() : 'starter';
  const plan = PLANS[rawPlan] ? rawPlan : 'starter';
  const spec = PLANS[plan];

  const email = typeof args.email === 'string' ? args.email.trim() : '';
  const smsTo =
    typeof args.phone === 'string' && args.phone
      ? args.phone
      : callerNumber ?? '';

  // The caller may have requested signup, but a model tool call is not by
  // itself durable consent evidence. Require the same persisted contact/consent
  // gate before creating a checkout session whose delivery depends on SMS.
  if (smsTo) {
    try {
      await assertOutboundAllowed({
        channel: 'sms',
        destination: smsTo,
        purpose: 'requested_checkout_link',
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        checkoutCreated: false,
        smsSent: false,
      };
    }
  }

  // Create Stripe Checkout session.
  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', spec.priceId);
  params.append('line_items[0][quantity]', '1');
  params.append(
    'success_url',
    'https://www.buildmybot.app/dashboard?upgraded=true',
  );
  params.append('cancel_url', 'https://www.buildmybot.app/pricing');
  if (email) {
    params.append('customer_email', email);
  }
  params.append('subscription_data[metadata][source]', 'telnyx_inbound_call');
  params.append('subscription_data[metadata][plan]', plan);

  let checkoutUrl: string;

  try {
    const stripeRes = await fetch(
      'https://api.stripe.com/v1/checkout/sessions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      },
    );

    const data = (await stripeRes.json()) as {
      url?: string;
      error?: { message?: string };
    };

    if (!data.url) {
      return {
        ok: false,
        error: data.error?.message ?? 'Stripe did not return a checkout URL.',
      };
    }

    checkoutUrl = data.url;
  } catch (err) {
    return {
      ok: false,
      error: `Stripe request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Send SMS via Telnyx Messaging API.
  if (smsTo) {
    const telnyxKey = process.env.TELNYX_API_KEY;
    const fromNumber = process.env.TELNYX_MESSAGING_NUMBER;

    if (telnyxKey && fromNumber) {
      try {
        const smsBody = {
          from: fromNumber,
          to: smsTo,
          text: `Your BuildMyBot ${spec.name} checkout link: ${checkoutUrl}`,
        };

        await assertContactSendable({ channel: 'sms', destination: smsTo });
        const { assertSendAllowed, openOutboundSendJob } = await import('@workspace/core');
        const opened = await openOutboundSendJob({
          caller: 'voice',
          createdBy: 'voice-guardrails',
          recipients: [{
            channel: 'sms',
            destination: smsTo,
            messageText: smsBody.text,
            payload: { kind: 'telnyx_sms', from: fromNumber, text: smsBody.text },
          }],
        });
        await assertSendAllowed(opened.jobId, smsTo, 'sms');

        const smsRes = await fetch('https://api.telnyx.com/v2/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${telnyxKey}`,
          },
          body: JSON.stringify(smsBody),
        });

        const smsJson = smsRes.ok ? await smsRes.clone().json().catch(() => null) as { data?: { id?: string } } | null : null;
        if (!smsRes.ok) {
          const errText = await smsRes.text().catch(() => '');
          console.warn(
            `[Voice Guardrails] SMS send failed (${smsRes.status}): ${errText.slice(0, 200)}`,
          );
        }
        await commitSmsMessage({
          id: crypto.randomUUID(),
          direction: 'outbound',
          counterpartyNumber: smsTo,
          fromNumber,
          toNumber: smsTo,
          body: smsBody.text,
          status: smsRes.ok ? 'sent' : 'failed',
          providerId: smsJson?.data?.id ?? null,
          errorMessage: smsRes.ok ? null : `Telnyx returned ${smsRes.status}`,
          createdByAgentId: 'voice-guardrails',
        }, { actorType: 'agent', actorName: 'voice-guardrails' });
      } catch (smsErr) {
        console.warn(
          '[Voice Guardrails] SMS send error:',
          smsErr instanceof Error ? smsErr.message : String(smsErr),
        );
      }
    } else {
      console.warn(
        '[Voice Guardrails] TELNYX_API_KEY or TELNYX_MESSAGING_NUMBER not set; SMS skipped.',
      );
    }
  }

  return {
    ok: true,
    plan: spec.name,
    priceMonthly: spec.priceMonthly,
    checkoutUrl,
    smsSent: Boolean(smsTo),
    message: `I've texted you a ${spec.name} signup link at ${smsTo || 'your number'}. You can sign up right now — takes about 60 seconds.`,
  };
}

// ─── transfer_to_owner ────────────────────────────────────────────────────────

async function executeTransferToOwner(
  args: Record<string, unknown>,
  callControlId: string,
): Promise<Record<string, unknown>> {
  const reason =
    typeof args.reason === 'string' ? args.reason : 'Caller requested transfer';

  const telnyxKey = process.env.TELNYX_API_KEY;
  const ownerNumber = process.env.TELNYX_OWNER_NUMBER;

  // Attempt a live SIP transfer when both credentials are present.
  if (telnyxKey && ownerNumber) {
    try {
      const transferRes = await fetch(
        `https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${telnyxKey}`,
          },
          body: JSON.stringify({
            to: ownerNumber,
            timeout_secs: 30,
          }),
        },
      );

      if (transferRes.ok) {
        console.info(
          `[Voice Guardrails] Call ${callControlId} transferred to owner. Reason: ${reason}`,
        );

        return {
          ok: true,
          transferred: true,
          to: ownerNumber,
          reason,
          message:
            "I'm connecting you with the owner now. Please hold for just a moment.",
        };
      }

      const errText = await transferRes.text().catch(() => '');
      console.warn(
        `[Voice Guardrails] Transfer failed (${transferRes.status}): ${errText.slice(0, 200)}`,
      );
    } catch (err) {
      console.warn(
        '[Voice Guardrails] Transfer error:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Fallback: live transfer wasn't possible (env vars missing, or the
  // attempt above failed/timed out). This used to be notify-ONLY in name
  // alone -- it logged a line nobody watches in real time and then told the
  // caller "the owner will call you back within the hour" regardless,
  // a promise nothing behind this function actually kept. Best-effort SMS
  // to the owner via the same Telnyx Messaging call executeSendCheckoutLink
  // already uses a few dozen lines up, so the message the caller hears is
  // only ever as confident as what actually reached the owner's phone.
  console.info(
    `[Voice Guardrails] Transfer fallback for call ${callControlId}. Reason: ${reason}`,
  );

  let ownerNotified = false;
  const messagingKey = process.env.TELNYX_API_KEY;
  const messagingFrom = process.env.TELNYX_MESSAGING_NUMBER;
  if (ownerNumber && messagingKey && messagingFrom) {
    try {
      await assertContactSendable({ channel: 'sms', destination: ownerNumber });
      // Owner notification SMS to TELNYX_OWNER_NUMBER still passes the send safeguard.
      const { assertSendAllowed, openOutboundSendJob } = await import('@workspace/core');
      const ownerText = `BuildMyBot: a caller needs you (live transfer unavailable). Reason: ${reason}. Call ${callControlId}.`;
      const opened = await openOutboundSendJob({
        caller: 'voice',
        createdBy: 'voice-guardrails',
        recipients: [{
          channel: 'sms',
          destination: ownerNumber,
          messageText: ownerText,
          payload: { kind: 'telnyx_sms', from: messagingFrom, text: ownerText },
        }],
      });
      await assertSendAllowed(opened.jobId, ownerNumber, 'sms');
      const smsRes = await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${messagingKey}`,
        },
        body: JSON.stringify({
          from: messagingFrom,
          to: ownerNumber,
          text: ownerText,
        }),
      });
      ownerNotified = smsRes.ok;
      const ownerJson = smsRes.ok ? await smsRes.clone().json().catch(() => null) as { data?: { id?: string } } | null : null;
      await commitSmsMessage({
        id: crypto.randomUUID(),
        direction: 'outbound',
        counterpartyNumber: ownerNumber,
        fromNumber: messagingFrom,
        toNumber: ownerNumber,
        body: ownerText,
        status: smsRes.ok ? 'sent' : 'failed',
        providerId: ownerJson?.data?.id ?? null,
        createdByAgentId: 'voice-guardrails',
      }, { actorType: 'agent', actorName: 'voice-guardrails' });
      if (!smsRes.ok) {
        const errText = await smsRes.text().catch(() => '');
        console.warn(
          `[Voice Guardrails] Owner notification SMS failed (${smsRes.status}): ${errText.slice(0, 200)}`,
        );
      }
    } catch (smsErr) {
      console.warn(
        '[Voice Guardrails] Owner notification SMS error:',
        smsErr instanceof Error ? smsErr.message : String(smsErr),
      );
    }
  } else {
    console.warn(
      '[Voice Guardrails] TELNYX_OWNER_NUMBER, TELNYX_API_KEY, or TELNYX_MESSAGING_NUMBER not set; owner notification skipped.',
    );
  }

  return {
    ok: true,
    transferred: false,
    ownerNotified,
    reason,
    message: ownerNotified
      ? "I wasn't able to connect you directly right now, but I've texted the owner to call you back as soon as they can."
      : "I wasn't able to connect you directly right now. Please try calling back shortly, or I can take a message for the owner.",
  };
}


// ─── Operator channel: unlock / goal submission / status ─────────────────────

function executeUnlockOperator(
  args: Record<string, unknown>,
  callControlId: string,
): Record<string, unknown> {
  const expected = process.env.APEX_OPERATOR_UNLOCK_CODE;
  const given = String(args.code ?? '').replace(/[^0-9]/g, '');
  if (!expected) {
    console.error('[Operator Channel] APEX_OPERATOR_UNLOCK_CODE is not configured.');
    return { ok: false, error: 'Operator channel is not configured.' };
  }
  if (!given || given.length !== expected.length || !safeEqual(given, expected)) {
    console.warn(`[Operator Channel] Failed unlock attempt on call ${callControlId}.`);
    return { ok: false, error: 'That code is not valid.' };
  }
  unlockSession(callControlId);
  console.info(`[Operator Channel] Operator unlocked on call ${callControlId}.`);
  return {
    ok: true,
    operator_mode: true,
    instructions:
      'Operator mode unlocked. Treat the caller as the owner with full authority over APEX. ' +
      'You may now submit goals (apex_goal) and report workforce status (apex_status). ' +
      'Confirm every goal with the caller before submitting it.',
  };
}

function safeEqual(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

async function executeApexGoal(
  args: Record<string, unknown>,
  callControlId: string,
): Promise<Record<string, unknown>> {
  if (!isSessionUnlocked(callControlId)) {
    return { ok: false, error: 'Operator mode is locked. Provide the operator access code first.' };
  }
  const title = String(args.title ?? '').trim();
  const description = String(args.description ?? '').trim();
  const priority = typeof args.priority === 'number' ? args.priority : 5;
  if (title.length < 3 || description.length < 10) {
    return { ok: false, error: 'A goal needs a title (3+ chars) and a description (10+ chars).' };
  }
  const ceo = getOperatorCeo();
  if (!ceo) {
    return { ok: false, error: 'The APEX workforce is not available right now.' };
  }
  try {
    const goalId = await ceo.submitGoal(title, description, priority);
    console.info(`[Operator Channel] Goal submitted on call ${callControlId}: ${goalId}`);
    return {
      ok: true,
      goalId,
      message: `Goal "${title}" submitted to the APEX CEO. The workforce is on it.`,
    };
  } catch (err) {
    console.error('[Operator Channel] Goal submission failed:', err);
    return { ok: false, error: 'Goal submission failed. ' + (err instanceof Error ? err.message : String(err)) };
  }
}

async function executeApexStatus(
  callControlId: string,
): Promise<Record<string, unknown>> {
  if (!isSessionUnlocked(callControlId)) {
    return { ok: false, error: 'Operator mode is locked. Provide the operator access code first.' };
  }
  try {
    const recent = await db.select().from(goals).orderBy(desc(goals.createdAt)).limit(5);
    return {
      ok: true,
      goals: recent.map((g) => ({
        title: g.title,
        status: g.status,
        priority: g.priority,
        createdAt: g.createdAt,
      })),
    };
  } catch (err) {
    return { ok: false, error: 'Status lookup failed. ' + (err instanceof Error ? err.message : String(err)) };
  }
}
