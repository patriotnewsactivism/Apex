# BuildMyBot.app — Business Profile (Ground Truth for APEX)

**Compiled:** 2026-07-12, from live site scrape (buildmybot.app/pricing) + verified backend audits.
**Purpose:** This is the canonical context APEX's 12 AI employees should operate from. It separates
what is REAL and LIVE from what is MARKETED but not yet delivered — APEX must never assume a
promised feature works without checking. When in doubt, verify against the actual codebase
(`patriotnewsactivism/buildmybot2`) or ask Don/BuildMyBot Partner before promising it to a customer.

---

## What BuildMyBot Sells

White-label AI chatbot & voice agent platform for lead capture and customer conversation automation.
Target customer converts website visitors into customers 24/7 via chat + voice, with a CRM/lead layer
on top.

## Ideal Customer Profile (ICP)

- Home Services: HVAC, Roofing, Plumbing, Solar installation
- Legal: Personal Injury, DUI Defense, Family Law
- Medical/Esthetics: MedSpa, Plastic Surgery, Dental Implants
- Real Estate brokerages

Avoid: restaurants, generic retail, large corporations (per existing outbound research targeting rules).

## Pricing Tiers (live on site, 2026-07-12)

| Tier | Price/mo | Bots | Conversations/mo | Key features |
|---|---|---|---|---|
| Free | $0 | 1 | 60 | Basic FAQ + lead capture, 50MB KB, community support |
| Starter | $29 | 1 | 750 | Multi-page training, 500MB KB, Grok 4.1 Fast model, email/SMS lead alerts |
| Professional (MOST POPULAR) | $99 | 5 | 5,000 | CRM/calendar integrations, lead scoring, API/webhooks, priority support |
| Executive | $199 | 10 | 30,000 | Voice/phone agent included, workflow automation, A/B testing, team seats |
| Enterprise | $499 | Unlimited | 50,000 (+$0.01/over) | Full white-label, SAML/SSO+SCIM, SOC2/DPA/audit logs, dedicated success manager |

## Premium Add-Ons (13 total, stackable)

Advanced Analytics Pro ($49), Multi-Language Pack ($39, 40+ languages), E-Commerce Suite ($79,
Shopify/WooCommerce/BigCommerce), Appointment Scheduling Pro ($49), Social Media Auto-Responder ($59,
FB/IG/WhatsApp/Telegram), CRM Power Suite ($69, Salesforce/HubSpot/Pipedrive/Zoho), HIPAA & Compliance
Pack ($149), Priority Support & SLA ($99), White-Label Lite ($99), Lead Nurture Automation ($59),
AI Training Studio ($39), Dedicated Success Manager ($299).

## Voice Agent Add-On (separate tier structure)

Voice Basic $79/mo (150 min incl.) → Voice Standard $174/mo (450 min) → Voice Professional $279/mo
(1000 min) → Voice Enterprise $549/mo (2500 min). $0.50/min overage across all tiers.

## Professional Services (human/AI delivery menu — pricing exists, delivery pipeline unverified)

Custom Bot Development ($2,999–$14,999), Custom Integration Development ($1,499–$3,999), Bot
Migration Service ($999–$2,499), AI Strategy Consulting ($499–$2,999), Staff Training ($999–$4,999),
Conversion Optimization Audit ($1,499–$3,999). Delivery windows quoted 3–45 days.

## Template Marketplace

Starter Templates (Free) → Industry Packs ($49) → Advanced Workflows ($99) → Voice Agent Templates
($149) → Enterprise Suite ($299).

## Sales Agent Commission Program

Recurring commission by tier based on clients referred: Bronze (0-49 clients, 20%), Silver (50-149,
30%), Gold (150-250, 40%), Platinum (251+, 50%). Add-on commission 20-50%, services commission flat
25% across all tiers. Revenue milestone bonuses: Rising Star $500 @ $5K MRR, Sales Pro $1,500 @ $10K
MRR, Elite Closer $5,000 @ $25K MRR, Top Pro tier beyond that (amount not captured in this scrape).

---

## GROUND TRUTH: What's Actually Real vs. Just Marketed (as of 2026-07-12)

### ✅ Verified real and functional
- AI Chatbot Builder (no-code, drag-and-drop) — live
- Knowledge Base ingestion — fixed 2026-07-10 (was silently broken since inception, 2 schema bugs)
- Voice Agent v2.0 — confirmed live on Railway (`buildmybot2-backend`), streaming STT→LLM→TTS w/ barge-in
- Lead capture (`leads` table) — fixed 2026-07-12, was silently discarding leads before
- Outbound lead research (`researched_leads` table) — real, 124+ genuine records via Tavily search + LLM qualification (Sarah Collins + 5 sales-agent researcher roles)

### ⚠️ Sold on pricing page, NOT confirmed functional — verify before promising to customers
- HIPAA & Compliance Pack (BAA, SOC2 audit logs, encryption-at-rest attestation) — no evidence of actual compliance infrastructure
- SAML/SSO + SCIM provisioning (Enterprise tier) — not verified in codebase
- CRM Power Suite (Salesforce/HubSpot/Pipedrive/Zoho 2-way sync) — not verified
- E-Commerce Suite (Shopify/WooCommerce/BigCommerce sync, cart recovery) — not verified
- Social Media Auto-Responder add-on (FB/IG/WhatsApp/Telegram) — Frankie Mercer (internal social role) is DRAFT-ONLY, no real publish capability. This is being SOLD to customers as a feature but the internal team doesn't even have it working for BuildMyBot's own accounts.
- Multi-Language Pack (40+ languages, RTL support) — not verified
- Template Marketplace — not verified whether any templates actually exist/are purchasable
- Professional Services delivery pipeline (custom bot builds, migrations, audits) — pricing exists, no confirmed fulfillment process/team behind it

### 🔴 Blocking issue — this undermines EVERYTHING above
- **Stripe is TEST-MODE ONLY.** No live payment processing confirmed. None of these tiers, add-ons,
  or services can currently be purchased for real by a real customer. This is the single highest-priority
  gap — fix before any of the above matters commercially.

---

## APEX Mandate

1. Never represent an unverified feature (⚠️ list above) as working to a prospect or in generated
   marketing copy without first confirming it against the live codebase.
2. Treat the 🔴 Stripe live-mode gap as the top production-readiness blocker for BuildMyBot.
3. Escalate to Don/BuildMyBot Partner immediately if asked to build customer-facing copy or support
   responses that promise an unverified feature.
4. Update this file's Ground Truth section whenever a feature moves from ⚠️/🔴 to ✅ (or regresses).
