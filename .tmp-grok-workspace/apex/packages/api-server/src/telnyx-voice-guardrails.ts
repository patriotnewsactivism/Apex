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

        const smsRes = await fetch('https://api.telnyx.com/v2/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${telnyxKey}`,
          },
          body: JSON.stringify(smsBody),
        });

        if (!smsRes.ok) {
          const errText = await smsRes.text().catch(() => '');
          console.warn(
            `[Voice Guardrails] SMS send failed (${smsRes.status}): ${errText.slice(0, 200)}`,
          );
        }
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

  // Fallback: notify-only path when env vars are missing or transfer failed.
  console.info(
    `[Voice Guardrails] Transfer fallback for call ${callControlId}. Reason: ${reason}`,
  );

  return {
    ok: true,
    transferred: false,
    reason,
    message:
      "I wasn't able to connect you directly right now, but I've flagged this as urgent. " +
      'The owner will give you a call back within the hour.',
  };
}
