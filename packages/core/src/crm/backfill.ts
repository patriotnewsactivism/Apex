/**
 * One-time copy from legacy outreach tables into the contact book.
 * Dry-run by default. Never deletes legacy rows.
 */
import { db } from '@workspace/db';
import {
  callBridgeSessions,
  callOutcomes,
  emailCampaigns,
  emailSends,
  emailSuppressions,
  leadCampaigns,
  lineCalls,
  outboundAudit,
  researchedLeads,
  smsMessages,
} from '@workspace/db';
import {
  applyDoNotContact,
  asExecutor,
  findOrCreateContact,
  insertTimelineEvent,
  legacyLinkExists,
} from './store.js';
import { crmLegacyLinks } from '@workspace/db';

export interface BackfillResult {
  dryRun: boolean;
  wouldCreate: number;
  created: number;
  skipped: number;
  byTable: Record<string, { create: number; skip: number }>;
}

async function note(
  stats: BackfillResult,
  table: string,
  sourceId: string,
  write: () => Promise<void>,
): Promise<void> {
  const bucket = stats.byTable[table] ?? { create: 0, skip: 0 };
  stats.byTable[table] = bucket;
  if (await legacyLinkExists(table, sourceId)) {
    bucket.skip += 1;
    stats.skipped += 1;
    return;
  }
  bucket.create += 1;
  stats.wouldCreate += 1;
  if (stats.dryRun) return;
  await write();
  stats.created += 1;
}

export async function backfillCrm(options: { dryRun: boolean }): Promise<BackfillResult> {
  const stats: BackfillResult = {
    dryRun: options.dryRun,
    wouldCreate: 0,
    created: 0,
    skipped: 0,
    byTable: {},
  };

  const leads = await db.select().from(researchedLeads);
  for (const lead of leads) {
    await note(stats, 'researched_leads', lead.id, async () => {
      const destination = lead.contactEmail || lead.contactPhone || `${lead.id}@legacy.local`;
      const contactId = await findOrCreateContact(db, destination, {
        name: lead.decisionMakerName,
        organizationName: lead.companyName,
        source: 'researched_leads',
      });
      await db.insert(crmLegacyLinks).values({ sourceTable: 'researched_leads', sourceId: lead.id, contactId });
    });
  }

  const sends = await db.select().from(emailSends);
  for (const send of sends) {
    await note(stats, 'email_sends', send.id, async () => {
      await db.transaction(async (tx) => {
        const executor = asExecutor(tx);
        const contactId = await findOrCreateContact(executor, send.toEmail, { name: send.toName, source: 'email_sends' });
        const timeline = await insertTimelineEvent(executor, {
          contactId,
          channel: 'email',
          direction: 'outbound',
          actorType: 'agent',
          actorName: send.createdByAgentId ?? 'legacy',
          eventKind: 'email',
          occurredAt: send.sentAt ?? send.createdAt,
          subject: send.subject,
          bodyHtml: send.body,
          bodyText: send.body,
          provider: 'resend',
          providerMessageId: send.providerId ? `legacy-email:${send.providerId}` : `legacy-email:${send.id}`,
          sendRecordTable: 'email_sends',
          sendRecordId: send.id,
        });
        await executor.insert(crmLegacyLinks).values({
          sourceTable: 'email_sends',
          sourceId: send.id,
          contactId,
          timelineId: timeline.id,
        });
      });
    });
  }

  const suppressions = await db.select().from(emailSuppressions);
  for (const row of suppressions) {
    await note(stats, 'email_suppressions', row.email, async () => {
      await db.transaction(async (tx) => {
        const executor = asExecutor(tx);
        const contactId = await applyDoNotContact(executor, {
          destination: row.email,
          reason: row.reason,
          setBy: 'legacy-suppression',
          channel: 'email',
          providerMessageId: `legacy-suppression:${row.email}`,
        });
        await executor.insert(crmLegacyLinks).values({
          sourceTable: 'email_suppressions',
          sourceId: row.email,
          contactId,
        });
      });
    });
  }

  const texts = await db.select().from(smsMessages);
  for (const text of texts) {
    await note(stats, 'sms_messages', text.id, async () => {
      await db.transaction(async (tx) => {
        const executor = asExecutor(tx);
        const contactId = await findOrCreateContact(executor, text.counterpartyNumber, { source: 'sms_messages' });
        const timeline = await insertTimelineEvent(executor, {
          contactId,
          channel: 'sms',
          direction: text.direction === 'inbound' ? 'inbound' : 'outbound',
          actorType: text.direction === 'inbound' ? 'system' : 'agent',
          actorName: text.createdByAgentId ?? 'legacy',
          eventKind: 'sms',
          occurredAt: text.createdAt,
          bodyText: text.body,
          provider: 'telnyx',
          providerMessageId: text.providerId ? `legacy-sms:${text.providerId}` : `legacy-sms:${text.id}`,
          sendRecordTable: 'sms_messages',
          sendRecordId: text.id,
        });
        await executor.insert(crmLegacyLinks).values({
          sourceTable: 'sms_messages',
          sourceId: text.id,
          contactId,
          timelineId: timeline.id,
        });
      });
    });
  }

  const outcomes = await db.select().from(callOutcomes);
  for (const call of outcomes) {
    await note(stats, 'call_outcomes', call.id, async () => {
      await db.transaction(async (tx) => {
        const executor = asExecutor(tx);
        const contactId = await findOrCreateContact(executor, call.customerNumber, {
          name: call.customerName,
          source: 'call_outcomes',
        });
        const timeline = await insertTimelineEvent(executor, {
          contactId,
          channel: 'call',
          direction: 'outbound',
          actorType: 'agent',
          actorName: call.createdByAgentId ?? 'legacy',
          eventKind: 'call',
          occurredAt: call.createdAt,
          bodyText: call.transcript || call.summary,
          provider: 'cartesia',
          providerMessageId: `legacy-call:${call.callId}`,
          sendRecordTable: 'call_outcomes',
          sendRecordId: call.id,
        });
        await executor.insert(crmLegacyLinks).values({
          sourceTable: 'call_outcomes',
          sourceId: call.id,
          contactId,
          timelineId: timeline.id,
        });
      });
    });
  }

  const bridges = await db.select().from(callBridgeSessions);
  for (const session of bridges) {
    await note(stats, 'call_bridge_sessions', session.id, async () => {
      await db.transaction(async (tx) => {
        const executor = asExecutor(tx);
        const contactId = await findOrCreateContact(executor, session.customerNumber, {
          name: session.buyerName,
          source: 'call_bridge_sessions',
        });
        const timeline = await insertTimelineEvent(executor, {
          contactId,
          channel: 'call',
          direction: 'outbound',
          actorType: 'operator',
          actorName: session.createdByAgentId ?? 'operator',
          eventKind: 'call',
          occurredAt: session.createdAt,
          bodyText: session.transcriptTail || `Call bridge ${session.status}`,
          provider: 'telnyx',
          providerMessageId: `legacy-bridge:${session.id}`,
          sendRecordTable: 'call_bridge_sessions',
          sendRecordId: session.id,
        });
        await executor.insert(crmLegacyLinks).values({
          sourceTable: 'call_bridge_sessions',
          sourceId: session.id,
          contactId,
          timelineId: timeline.id,
        });
      });
    });
  }

  const lines = await db.select().from(lineCalls);
  for (const line of lines) {
    await note(stats, 'line_calls', line.id, async () => {
      const destination = line.remoteNumber || 'unknown';
      await db.transaction(async (tx) => {
        const executor = asExecutor(tx);
        const contactId = line.remoteNumber
          ? await findOrCreateContact(executor, line.remoteNumber, { name: line.remoteName, source: 'line_calls' })
          : null;
        const timeline = await insertTimelineEvent(executor, {
          contactId,
          createContact: false,
          channel: 'call',
          direction: line.direction === 'inbound' ? 'inbound' : 'outbound',
          actorType: 'system',
          actorName: line.source,
          eventKind: 'call',
          occurredAt: line.startedAt,
          bodyText: `${line.direction} line call ${destination}`,
          provider: 'telnyx',
          providerMessageId: `legacy-line:${line.id}`,
          sendRecordTable: 'line_calls',
          sendRecordId: line.id,
        });
        await executor.insert(crmLegacyLinks).values({
          sourceTable: 'line_calls',
          sourceId: line.id,
          contactId,
          timelineId: timeline.id,
        });
      });
    });
  }

  const audits = await db.select().from(outboundAudit);
  for (const audit of audits) {
    await note(stats, 'outbound_audit', audit.id, async () => {
      await db.transaction(async (tx) => {
        const executor = asExecutor(tx);
        const contactId = audit.destination
          ? await findOrCreateContact(executor, audit.destination, { source: 'outbound_audit' })
          : null;
        const timeline = await insertTimelineEvent(executor, {
          contactId,
          createContact: Boolean(audit.destination),
          channel: 'internal',
          direction: 'internal',
          actorType: 'system',
          actorName: audit.toolName,
          eventKind: 'audit',
          occurredAt: audit.createdAt,
          bodyText: audit.detail,
          provider: 'apex',
          providerMessageId: `legacy-audit:${audit.id}`,
          sendRecordTable: 'outbound_audit',
          sendRecordId: audit.id,
        });
        await executor.insert(crmLegacyLinks).values({
          sourceTable: 'outbound_audit',
          sourceId: audit.id,
          contactId,
          timelineId: timeline.id,
        });
      });
    });
  }

  const leadCampaignRows = await db.select().from(leadCampaigns);
  for (const campaign of leadCampaignRows) {
    await note(stats, 'lead_campaigns', campaign.id, async () => {
      await db.transaction(async (tx) => {
        const executor = asExecutor(tx);
        const timeline = await insertTimelineEvent(executor, {
          createContact: false,
          channel: 'internal',
          direction: 'internal',
          actorType: 'agent',
          actorName: campaign.createdByAgentId ?? 'legacy',
          eventKind: 'legacy_campaign',
          occurredAt: campaign.createdAt,
          bodyText: `Lead campaign ${campaign.name} (${campaign.status})`,
          provider: 'apex',
          providerMessageId: `legacy-lead-campaign:${campaign.id}`,
        });
        await executor.insert(crmLegacyLinks).values({
          sourceTable: 'lead_campaigns',
          sourceId: campaign.id,
          timelineId: timeline.id,
        });
      });
    });
  }

  const emailCampaignRows = await db.select().from(emailCampaigns);
  for (const campaign of emailCampaignRows) {
    await note(stats, 'email_campaigns', campaign.id, async () => {
      await db.transaction(async (tx) => {
        const executor = asExecutor(tx);
        const timeline = await insertTimelineEvent(executor, {
          createContact: false,
          channel: 'email',
          direction: 'internal',
          actorType: 'agent',
          actorName: campaign.createdByAgentId ?? 'legacy',
          eventKind: 'legacy_campaign',
          occurredAt: campaign.createdAt,
          subject: campaign.subjectTemplate,
          bodyText: campaign.bodyTemplate,
          provider: 'apex',
          providerMessageId: `legacy-email-campaign:${campaign.id}`,
          sendRecordTable: 'email_campaigns',
          sendRecordId: campaign.id,
        });
        await executor.insert(crmLegacyLinks).values({
          sourceTable: 'email_campaigns',
          sourceId: campaign.id,
          timelineId: timeline.id,
        });
      });
    });
  }

  return stats;
}
