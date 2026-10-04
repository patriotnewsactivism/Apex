import crypto from 'crypto';
import { Router } from 'express';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  callBridgeSessions,
  emailCampaigns,
  emailSends,
  outboundPolicies,
  researchedLeads,
  salesSuggestionDismissals,
  workerHeartbeats,
} from '@workspace/db';
import {
  buildSalesSuggestions,
  SendBlockedError,
  assertContactSendable,
  commitCallOutcome,
  createQueuedEmailSend,
  deliverQueuedEmailSend,
  SendSafeguardError,
  emptyOutboundPolicy,
  getSalesPlaybook,
  listSalesPlaybooks,
  loadOutboundPolicy,
  recordOutboundAudit,
  rehearsalPersonaFields,
  renderPlaybookTemplate,
  runWithSendCaller,
  sameEmail,
  startCartesiaSalesCall,
} from '@workspace/core';
import { errorMessage, normalizeE164 } from './sales-ops.js';

const PROJECT_ID = 'apex';
const REHEARSAL_LEAD_ID = 'rehearsal-operator';
const LIVE_CALL_STATUSES = ['dialing_operator', 'dialing_customer', 'active', 'ai_dialing', 'ai_joined'];

async function readPolicyRow() {
  const [row] = await db.select().from(outboundPolicies).where(eq(outboundPolicies.projectId, PROJECT_ID)).limit(1);
  return row ?? null;
}

export function createSalesFloorRouter(): Router {
  const router = Router();

  router.get('/playbooks', (_req, res) => {
    res.json({
      playbooks: listSalesPlaybooks().map((playbook) => ({
        id: playbook.id,
        version: playbook.version,
        name: playbook.name,
        summary: playbook.summary,
        subject: playbook.openEmail.subject,
        text: playbook.openEmail.text,
      })),
    });
  });

  router.get('/outbound-policy', async (_req, res) => {
    try {
      const policy = await loadOutboundPolicy();
      res.json({ policy: policy ?? emptyOutboundPolicy() });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.put('/outbound-policy', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const mode = body.mode === 'rehearsal_only' || body.mode === 'capped_live' ? body.mode : 'off';
      const phone = body.rehearsalPhone == null || body.rehearsalPhone === ''
        ? null
        : normalizeE164(body.rehearsalPhone);
      if (body.rehearsalPhone && !phone) {
        res.status(400).json({ error: 'Rehearsal phone must be a valid number, for example +18325551212.' });
        return;
      }
      const email = typeof body.rehearsalEmail === 'string' ? body.rehearsalEmail.trim().toLowerCase() : null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ error: 'Rehearsal email is not a valid address.' });
        return;
      }
      const current = await readPolicyRow();
      const values = {
        projectId: PROJECT_ID,
        mode,
        killSwitch: Boolean(body.killSwitch),
        rehearsalEmail: email,
        rehearsalPhone: phone,
        personaName: textOrNull(body.personaName),
        personaCompany: textOrNull(body.personaCompany),
        personaIndustry: textOrNull(body.personaIndustry),
        personaCity: textOrNull(body.personaCity),
        dailyEmailCap: clampInt(body.dailyEmailCap, current?.dailyEmailCap ?? 25, 1, 500),
        dailyCallCap: clampInt(body.dailyCallCap, current?.dailyCallCap ?? 10, 1, 100),
        sendWindowStartHour: clampInt(body.sendWindowStartHour, 8, 0, 23),
        sendWindowEndHour: clampInt(body.sendWindowEndHour, 19, 0, 23),
        timezone: typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : 'America/Chicago',
        postalAddress: textOrNull(body.postalAddress),
        unsubscribeEmail: textOrNull(body.unsubscribeEmail),
        liveEnabledAt: mode === 'capped_live' ? (current?.liveEnabledAt ?? new Date()) : null,
        updatedAt: new Date(),
      };
      await db.insert(outboundPolicies).values(values).onConflictDoUpdate({
        target: outboundPolicies.projectId,
        set: values,
      });
      const policy = await loadOutboundPolicy();
      res.json({ policy: policy ?? emptyOutboundPolicy() });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.post('/kill-switch', async (req, res) => {
    try {
      const on = Boolean((req.body ?? {}).on);
      const current = await readPolicyRow();
      if (!current) {
        await db.insert(outboundPolicies).values({ ...emptyPolicyInsert(), killSwitch: on, updatedAt: new Date() });
      } else {
        await db.update(outboundPolicies).set({ killSwitch: on, updatedAt: new Date() }).where(eq(outboundPolicies.projectId, PROJECT_ID));
      }
      res.json({ killSwitch: on });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.get('/rehearsal/preview', async (_req, res) => {
    try {
      const policy = await loadOutboundPolicy();
      const playbook = getSalesPlaybook('buildmybot-intro');
      if (!policy || !playbook) {
        res.status(503).json({ error: 'Rehearsal preview is unavailable.' });
        return;
      }
      const fields = rehearsalPersonaFields({
        buyerName: policy.personaName || 'there',
        companyName: policy.personaCompany || 'your company',
        industry: policy.personaIndustry || 'local service',
        city: policy.personaCity || 'your area',
      });
      const subject = renderPlaybookTemplate(playbook.openEmail.subject, fields);
      const text = renderPlaybookTemplate(playbook.openEmail.text, fields);
      const opening = renderPlaybookTemplate(playbook.call.firstMessage, fields);
      res.json({
        playbookId: playbook.id,
        version: playbook.version,
        subject: subject.text,
        body: text.text,
        firstMessage: opening.text,
        missing: [...new Set([...subject.missing, ...text.missing, ...opening.missing])],
        profileComplete: Boolean(policy.rehearsalEmail && policy.rehearsalPhone && policy.personaName && policy.personaCompany),
      });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.post('/rehearsal', async (_req, res) => {
    try {
      const policy = await loadOutboundPolicy();
      if (!policy?.rehearsalEmail || !policy.rehearsalPhone || !policy.personaName || !policy.personaCompany) {
        res.status(400).json({ error: 'Save your rehearsal email, phone, name, and company before selling to yourself.' });
        return;
      }
      const outcome = await runRehearsal(policy, {
        leadId: REHEARSAL_LEAD_ID,
        buyerName: policy.personaName,
        companyName: policy.personaCompany,
        industry: policy.personaIndustry || 'local service',
        city: policy.personaCity || 'your area',
        outreachAngle: null,
        persistPersonaLead: true,
      });
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // Practice-pitch a REAL lead: the email and call are written from that lead's
  // own details but delivered ONLY to the operator's rehearsal email and phone.
  // The lead is never contacted, and nothing on the lead record is modified.
  router.post('/rehearsal/lead/:leadId', async (req, res) => {
    try {
      const policy = await loadOutboundPolicy();
      if (!policy?.rehearsalEmail || !policy.rehearsalPhone) {
        res.status(400).json({ error: 'Save your rehearsal email and phone in the Sales floor profile first.' });
        return;
      }
      const [lead] = await db.select().from(researchedLeads).where(eq(researchedLeads.id, req.params.leadId)).limit(1);
      if (!lead) {
        res.status(404).json({ error: 'That lead no longer exists.' });
        return;
      }
      if (lead.id === REHEARSAL_LEAD_ID) {
        res.status(400).json({ error: 'Use Sell to me for your own rehearsal persona.' });
        return;
      }
      const outcome = await runRehearsal(policy, {
        leadId: lead.id,
        buyerName: lead.decisionMakerName || 'there',
        companyName: lead.companyName,
        industry: lead.industry || 'local service',
        city: lead.city || 'your area',
        outreachAngle: lead.outreachAngle ?? null,
        persistPersonaLead: false,
      });
      res.status(outcome.status).json({ ...outcome.body, leadId: lead.id, leadCompany: lead.companyName });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.get('/floor', async (_req, res) => {
    try {
      const policy = (await loadOutboundPolicy()) ?? emptyOutboundPolicy();
      const [calls, emails, heartbeats, dismissals, queued, imported, failures, rehearsalAudit] = await Promise.all([
        db.select().from(callBridgeSessions).orderBy(desc(callBridgeSessions.updatedAt)).limit(12),
        db.select().from(emailSends).orderBy(desc(emailSends.createdAt)).limit(12),
        db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastHeartbeatAt)).limit(1),
        db.select().from(salesSuggestionDismissals),
        db.select({ id: emailCampaigns.id }).from(emailCampaigns).where(inArray(emailCampaigns.status, ['draft', 'running'])).limit(20),
        db.select({ id: researchedLeads.id }).from(researchedLeads).where(and(
          eq(researchedLeads.contactResearchStatus, 'imported'),
          sql`${researchedLeads.contactEmail} is not null`,
        )).limit(200),
        db.select({
          campaignId: emailSends.campaignId,
          errorMessage: emailSends.errorMessage,
        }).from(emailSends).where(eq(emailSends.status, 'failed')).orderBy(desc(emailSends.createdAt)).limit(40),
        db.select({ status: emailSends.status, errorMessage: emailSends.errorMessage })
          .from(emailSends)
          .where(eq(emailSends.leadId, REHEARSAL_LEAD_ID))
          .orderBy(desc(emailSends.createdAt))
          .limit(1),
      ]);
      const hidden = new Set(dismissals.map((row) => row.fingerprint));
      const failureGroups = groupFailures(failures);
      const live = calls.filter((call) => LIVE_CALL_STATUSES.includes(call.status));
      const unjoined = live.find((call) => call.sessionMode === 'ai_first' && !call.operatorJoinRole && call.operatorNumber !== call.customerNumber);
      const worker = heartbeats[0];
      const workerAgeMs = worker ? Date.now() - new Date(worker.lastHeartbeatAt).getTime() : null;
      const suggestions = buildSalesSuggestions({
        policyMode: policy.mode,
        killSwitch: policy.killSwitch,
        rehearsalReady: Boolean(policy.rehearsalEmail && policy.rehearsalPhone && policy.personaName && policy.personaCompany),
        rehearsalSucceeded: rehearsalAudit.some((row) => row.status === 'sent' || row.status === 'delivered' || row.status === 'opened'),
        lastRehearsalError: rehearsalAudit[0] && rehearsalAudit[0].status === 'failed' ? rehearsalAudit[0].errorMessage : null,
        liveUnjoinedCallId: unjoined?.id ?? null,
        failureGroups,
        queuedCampaigns: queued.length,
        importedWithEmail: imported.length,
      }).filter((suggestion) => !hidden.has(suggestion.fingerprint));
      res.json({
        policy,
        worker: worker ? { status: worker.status, ageMs: workerAgeMs, stale: (workerAgeMs ?? 0) > 60_000 } : { status: 'missing', ageMs: null, stale: true },
        calls: calls.map((call) => ({
          id: call.id,
          status: call.status,
          sessionMode: call.sessionMode,
          buyerName: call.buyerName,
          customerNumber: call.customerNumber,
          operatorJoinRole: call.operatorJoinRole,
          transcriptTail: call.transcriptTail,
          coachNote: call.coachNote,
          lastError: call.lastError,
          updatedAt: call.updatedAt,
          joinable: call.sessionMode === 'ai_first' && call.operatorNumber !== call.customerNumber && LIVE_CALL_STATUSES.includes(call.status),
        })),
        emails: emails.map((email) => ({
          id: email.id,
          toEmail: email.toEmail,
          subject: email.subject,
          status: email.status,
          errorMessage: email.errorMessage,
          createdAt: email.createdAt,
        })),
        suggestions,
      });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.post('/suggestions/dismiss', async (req, res) => {
    try {
      const fingerprint = typeof req.body?.fingerprint === 'string' ? req.body.fingerprint.trim().slice(0, 300) : '';
      if (!fingerprint) {
        res.status(400).json({ error: 'fingerprint is required' });
        return;
      }
      await db.insert(salesSuggestionDismissals).values({ fingerprint, dismissedAt: new Date() }).onConflictDoNothing();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  return router;
}

type RehearsalTarget = {
  leadId: string;
  buyerName: string;
  companyName: string;
  industry: string;
  city: string;
  outreachAngle: string | null;
  persistPersonaLead: boolean;
};

type RehearsalPolicy = NonNullable<Awaited<ReturnType<typeof loadOutboundPolicy>>>;

/** Confirm / code / release holds. The call is still staged so Pending sends
 *  can dial it. Kill switch and lock are not holds — they stop the call too. */
const REHEARSAL_SAFEGUARD_HOLDS = new Set(['awaiting_confirm', 'awaiting_code', 'awaiting_release']);

/**
 * Sends the designed email to the OPERATOR's rehearsal address and calls the
 * OPERATOR's rehearsal phone, written as if the target were the buyer. The
 * target's own email/phone are never used as a destination.
 */
async function runRehearsal(policy: RehearsalPolicy, target: RehearsalTarget) {
  if (!policy.rehearsalEmail || !policy.rehearsalPhone) {
    return { status: 400, body: { error: 'Rehearsal email and phone are required.' } };
  }
  if (policy.killSwitch) {
    return { status: 409, body: { error: 'The outbound kill switch is on.' } };
  }
  const playbook = getSalesPlaybook('buildmybot-intro');
  if (!playbook) return { status: 500, body: { error: 'The intro playbook is missing.' } };

  const fields = rehearsalPersonaFields({
    buyerName: target.buyerName,
    companyName: target.companyName,
    industry: target.industry,
    city: target.city,
  });
  if (target.outreachAngle?.trim()) fields.outreachAngle = target.outreachAngle.trim();

  const subject = renderPlaybookTemplate(playbook.openEmail.subject, fields);
  const html = renderPlaybookTemplate(playbook.openEmail.html, fields);
  const text = renderPlaybookTemplate(playbook.openEmail.text, fields);
  if (subject.missing.length || html.missing.length) {
    return { status: 400, body: { error: `Playbook is missing ${[...subject.missing, ...html.missing].join(', ')}.` } };
  }

  if (target.persistPersonaLead) {
    await db.insert(researchedLeads).values({
      id: target.leadId,
      companyName: target.companyName,
      industry: target.industry,
      city: target.city,
      decisionMakerName: target.buyerName,
      contactEmail: policy.rehearsalEmail,
      contactPhone: policy.rehearsalPhone,
      contactResearchStatus: 'complete',
      fitReason: 'Operator rehearsal persona. Not a real prospect.',
      outreachAngle: fields.outreachAngle ?? null,
      status: 'new',
      source: 'rehearsal',
      researchedByAgentId: 'operator',
      createdAt: new Date(),
    }).onConflictDoUpdate({
      target: researchedLeads.id,
      set: {
        companyName: target.companyName,
        industry: target.industry,
        city: target.city,
        decisionMakerName: target.buyerName,
        contactEmail: policy.rehearsalEmail,
        contactPhone: policy.rehearsalPhone,
        outreachAngle: fields.outreachAngle ?? null,
        source: 'rehearsal',
      },
    });
  }

  const sendId = crypto.randomUUID();
  await createQueuedEmailSend({
    id: sendId,
    leadId: target.leadId,
    toEmail: policy.rehearsalEmail,
    toName: policy.personaName ?? target.buyerName,
    subject: `[Practice] ${subject.text}`,
    createdByAgentId: 'operator',
  });
  // The operator already asked for this rehearsal. Dial and mail their own
  // profile without the two confirmations or the volume code. A held email
  // must not skip the call.
  return runWithSendCaller('operator-dashboard', () => finishRehearsal(policy, target, playbook, fields, sendId, subject.text, html.text, text.text));
}

async function finishRehearsal(
  policy: RehearsalPolicy,
  target: RehearsalTarget,
  playbook: NonNullable<ReturnType<typeof getSalesPlaybook>>,
  fields: ReturnType<typeof rehearsalPersonaFields>,
  sendId: string,
  subjectText: string,
  htmlText: string,
  textBody: string,
) {
  if (!policy.rehearsalEmail || !policy.rehearsalPhone) {
    return { status: 400, body: { error: 'Rehearsal email and phone are required.' } };
  }
  const rehearsalEmail = policy.rehearsalEmail;
  const rehearsalPhone = policy.rehearsalPhone;
  let email: Awaited<ReturnType<typeof deliverQueuedEmailSend>>;
  let emailHeld = false;
  let emailJobId: string | null = null;
  try {
    email = await deliverQueuedEmailSend(sendId, rehearsalEmail, `[Practice] ${subjectText}`, htmlText, {
      text: textBody,
      operatorDirect: true,
    });
  } catch (error) {
    // A held practice email used to return here with no `call` object. The
    // Revenue page then crashed on `call.id`, and the phone job was never
    // staged, so releasing Pending sends could not dial. Hold reasons keep
    // going and stage the call. A kill switch or lock still stops both.
    if (!(error instanceof SendSafeguardError) || !REHEARSAL_SAFEGUARD_HOLDS.has(error.reason)) {
      if (error instanceof SendSafeguardError) {
        return {
          status: error.reason === 'kill_switch' || error.reason === 'locked' ? 409 : 502,
          body: {
            email: { success: false, status: 'blocked', error: error.message },
            call: { success: false, error: error.message },
            error: error.message,
          },
        };
      }
      throw error;
    }
    emailHeld = true;
    emailJobId = error.jobId;
    email = {
      success: false,
      status: 'pending',
      error: 'Nothing was sent. Clear this send in Pending sends.',
    };
  }
  if (!emailHeld) {
    await recordOutboundAudit({
      toolName: 'send_email',
      destination: rehearsalEmail,
      leadId: target.leadId,
      policyMode: policy.mode,
      providerId: email.providerId ?? null,
      rehearsal: true,
      detail: email.success ? 'rehearsal open email' : email.error ?? 'rehearsal email failed',
    });
  }

  const callOpening = renderPlaybookTemplate(playbook.call.firstMessage, fields);
  const callPrompt = renderPlaybookTemplate(playbook.call.assistantPrompt, fields);
  if (callOpening.missing.length || callPrompt.missing.length) {
    return {
      status: 400,
      body: { email, error: `Call playbook is missing ${[...new Set([...callOpening.missing, ...callPrompt.missing])].join(', ')}.` },
    };
  }

  try {
    await assertContactSendable({ channel: 'phone', destination: rehearsalPhone });
  } catch (error) {
    if (error instanceof SendBlockedError) {
      return { status: 409, body: { email, error: error.message, doNotContact: true } };
    }
    throw error;
  }

  const call = await startCartesiaSalesCall({
    toNumber: rehearsalPhone,
    customerName: policy.personaName ?? target.buyerName,
    firstMessage: callOpening.text,
    assistantPrompt: callPrompt.text,
    playbookId: playbook.id,
    leadId: target.leadId,
    createdByAgentId: 'operator',
    operatorDirect: true,
  }).then(
    (started) => ({ success: true as const, ...started }),
    (err: unknown) => {
      const held = err instanceof SendSafeguardError && REHEARSAL_SAFEGUARD_HOLDS.has(err.reason);
      return {
        success: false as const,
        awaitingSafeguard: held,
        sendJobId: err instanceof SendSafeguardError ? err.jobId : undefined,
        error: held
          ? 'Nothing was sent. Clear this send in Pending sends.'
          : err instanceof Error ? err.message : String(err),
      };
    },
  );

  const callHeld = !call.success && call.awaitingSafeguard;
  const failureError = call.success ? null : (call.error || email.error || 'The rehearsal call did not start.');
  // A safeguard hold is not a failed dial. The release path writes the outcome
  // when the operator actually lets the call go out.
  if (!callHeld) {
    await commitCallOutcome({
      id: crypto.randomUUID(),
      callId: call.success ? `cartesia:${call.callId}` : `failed_${crypto.randomUUID()}`,
      leadId: target.leadId,
      customerNumber: rehearsalPhone,
      customerName: policy.personaName ?? target.buyerName,
      disposition: call.success ? 'no_decision' : 'failed_to_dial',
      summary: call.success ? 'Playbook rehearsal call initiated.' : `Playbook call failed: ${call.error}`,
      createdByAgentId: 'operator',
      conflictUpdate: call.success,
    });
  }

  await recordOutboundAudit({
    toolName: 'make_outbound_call',
    destination: rehearsalPhone,
    leadId: target.leadId,
    policyMode: policy.mode,
    providerId: call.success ? call.callId : null,
    rehearsal: true,
    detail: call.success
      ? 'canonical Cartesia rehearsal call'
      : callHeld
        ? 'rehearsal call waiting in Pending sends'
        : call.error,
  });

  const awaiting = !call.success && (emailHeld || callHeld);
  const status = call.success ? 201 : awaiting ? 202 : email.success ? 201 : 502;
  return {
    status,
    body: {
      email,
      call,
      playbookId: playbook.id,
      version: playbook.version,
      awaitingSafeguard: awaiting,
      sendJobId: call.success ? emailJobId : (call.sendJobId ?? emailJobId),
      ...(status >= 400 && failureError ? { error: failureError } : {}),
    },
  };
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function emptyPolicyInsert() {
  const policy = emptyOutboundPolicy();
  return {
    projectId: PROJECT_ID,
    mode: policy.mode,
    killSwitch: false,
    rehearsalEmail: null,
    rehearsalPhone: null,
    personaName: null,
    personaCompany: null,
    personaIndustry: null,
    personaCity: null,
    dailyEmailCap: policy.dailyEmailCap,
    dailyCallCap: policy.dailyCallCap,
    sendWindowStartHour: policy.sendWindowStartHour,
    sendWindowEndHour: policy.sendWindowEndHour,
    timezone: policy.timezone,
    postalAddress: null,
    unsubscribeEmail: null,
  };
}

function groupFailures(rows: Array<{ campaignId: string | null; errorMessage: string | null }>) {
  const groups = new Map<string, { reason: string; count: number; campaignId: string | null }>();
  for (const row of rows) {
    const reason = (row.errorMessage ?? 'Email failed').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]').slice(0, 180);
    const key = `${row.campaignId ?? ''}:${reason}`;
    const current = groups.get(key);
    if (current) current.count += 1;
    else groups.set(key, { reason, count: 1, campaignId: row.campaignId });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 3);
}

