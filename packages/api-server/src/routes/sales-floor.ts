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
  createQueuedEmailSend,
  deliverQueuedEmailSend,
  emptyOutboundPolicy,
  getSalesPlaybook,
  listSalesPlaybooks,
  loadOutboundPolicy,
  recordOutboundAudit,
  rehearsalPersonaFields,
  renderPlaybookTemplate,
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
      if (policy.killSwitch) {
        res.status(409).json({ error: 'The outbound kill switch is on.' });
        return;
      }
      const playbook = getSalesPlaybook('buildmybot-intro');
      if (!playbook) {
        res.status(500).json({ error: 'The intro playbook is missing.' });
        return;
      }
      const fields = rehearsalPersonaFields({
        buyerName: policy.personaName,
        companyName: policy.personaCompany,
        industry: policy.personaIndustry || 'local service',
        city: policy.personaCity || 'your area',
      });
      const subject = renderPlaybookTemplate(playbook.openEmail.subject, fields);
      const html = renderPlaybookTemplate(playbook.openEmail.html, fields);
      const text = renderPlaybookTemplate(playbook.openEmail.text, fields);
      if (subject.missing.length || html.missing.length) {
        res.status(400).json({ error: `Playbook is missing ${[...subject.missing, ...html.missing].join(', ')}.` });
        return;
      }
      if (!sameEmail(policy.rehearsalEmail, policy.rehearsalEmail)) {
        res.status(400).json({ error: 'Rehearsal email is not usable.' });
        return;
      }

      await db.insert(researchedLeads).values({
        id: REHEARSAL_LEAD_ID,
        companyName: policy.personaCompany,
        industry: policy.personaIndustry,
        city: policy.personaCity,
        decisionMakerName: policy.personaName,
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
          companyName: policy.personaCompany,
          industry: policy.personaIndustry,
          city: policy.personaCity,
          decisionMakerName: policy.personaName,
          contactEmail: policy.rehearsalEmail,
          contactPhone: policy.rehearsalPhone,
          outreachAngle: fields.outreachAngle ?? null,
          source: 'rehearsal',
        },
      });

      const sendId = crypto.randomUUID();
      await createQueuedEmailSend({
        id: sendId,
        leadId: REHEARSAL_LEAD_ID,
        toEmail: policy.rehearsalEmail,
        toName: policy.personaName,
        subject: subject.text,
        createdByAgentId: 'operator',
      });
      const email = await deliverQueuedEmailSend(sendId, policy.rehearsalEmail, subject.text, html.text, { text: text.text });
      await recordOutboundAudit({
        toolName: 'send_email',
        destination: policy.rehearsalEmail,
        leadId: REHEARSAL_LEAD_ID,
        policyMode: policy.mode,
        providerId: email.providerId ?? null,
        rehearsal: true,
        detail: email.success ? 'rehearsal open email' : email.error ?? 'rehearsal email failed',
      });

      const callOpening = renderPlaybookTemplate(playbook.call.firstMessage, fields);
      const callPrompt = renderPlaybookTemplate(playbook.call.assistantPrompt, fields);
      if (callOpening.missing.length || callPrompt.missing.length) {
        res.status(400).json({ error: `Call playbook is missing ${[...new Set([...callOpening.missing, ...callPrompt.missing])].join(', ')}.` });
        return;
      }

      const call = await startCartesiaSalesCall({
        toNumber: policy.rehearsalPhone,
        customerName: policy.personaName,
        firstMessage: callOpening.text,
        assistantPrompt: callPrompt.text,
        playbookId: playbook.id,
        leadId: REHEARSAL_LEAD_ID,
        createdByAgentId: 'operator',
      }).then(
        (started) => ({ success: true as const, ...started }),
        (err: unknown) => ({ success: false as const, error: err instanceof Error ? err.message : String(err) }),
      );

      await recordOutboundAudit({
        toolName: 'make_outbound_call',
        destination: policy.rehearsalPhone,
        leadId: REHEARSAL_LEAD_ID,
        policyMode: policy.mode,
        providerId: call.success ? call.callId : null,
        rehearsal: true,
        detail: call.success ? 'canonical Cartesia rehearsal call' : call.error,
      });

      res.status(email.success || call.success ? 201 : 502).json({
        email,
        call,
        playbookId: playbook.id,
        version: playbook.version,
      });
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

