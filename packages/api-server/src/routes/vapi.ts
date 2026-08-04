import { Router } from 'express';
import crypto from 'crypto';

// ─── Vapi Webhook Route ──────────────────────────────────────────────────────
//
// Receives server events from Vapi.ai when an outbound AI call is in progress
// or completes. Mounted BEFORE requireAdminAuth because Vapi's server can't
// send a Bearer token — it's a server-to-server webhook. Optionally protected
// by a shared-secret header (VAPI_WEBHOOK_SECRET) if configured.
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

      const { db, logs } = await import('@workspace/db');

      switch (message.type) {
        // ── Function call: AI called a tool during the conversation ──────────
        case 'function-call': {
          const fnName = message.functionCall?.name;
          const args = message.functionCall?.arguments || {};
          const callId = message.call?.id ?? 'unknown';
          const customerNumber = message.call?.customer?.number ?? '';
          const customerName = message.call?.customer?.name ?? '';

          console.log(`[Vapi] Function call: ${fnName}(${JSON.stringify(args)}) on call ${callId}`);

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
          const transcript = call.artifact?.transcript ?? message.artifact?.transcript ?? '';
          const endedReason = message.endedReason ?? call.endedReason ?? 'unknown';
          const cost = call.cost ?? 0;

          await db.insert(logs).values({
            agentId: 'apex-sales-001',
            taskId: null,
            level: 'info',
            message: `📞 Outbound call ended — ${endedReason}. Cost: $${Number(cost).toFixed(2)}. Summary: ${analysis.summary ?? 'N/A'}${transcript ? ` | Transcript: ${transcript.slice(0, 500)}...` : ''}`,
            timestamp: new Date(),
          });

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
