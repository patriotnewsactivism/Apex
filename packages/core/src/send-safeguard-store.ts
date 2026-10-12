// Postgres adapter for the send safeguard. Loaded only when a live send runs
// so the deterministic guard can exercise the in-memory engine without a database.

import { db, operatorSendCode, sendJobRecipients, sendJobs, sendSafeguardEvents } from '@workspace/db';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { loadOutboundPolicy } from './outbound-policy-store.js';
import {
  SendSafeguard,
  normalizeDestination,
  type OperatorCodeRecord,
  type SafeguardEventRecord,
  type SendChannel,
  type SendJobRecord,
  type SendJobStatus,
  type SendRecipientRecord,
  type SendSafeguardStore,
  type RecipientStatus,
  type RehearsalBypassAuditEntry,
  type RehearsalDestinations,
} from './send-safeguard.js';

/** outbound_audit.tool_name for rehearsal bypass rows (also the cap counter). */
export const REHEARSAL_BYPASS_AUDIT_TOOL = 'rehearsal_bypass';

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function date(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

export function createPersistentSendSafeguard(): SendSafeguard {
  return new SendSafeguard(new PostgresSendSafeguardStore());
}

class PostgresSendSafeguardStore implements SendSafeguardStore {
  now(): Date {
    return new Date();
  }

  async listJobs(): Promise<SendJobRecord[]> {
    const rows = await db.select().from(sendJobs);
    return rows.map(toJob);
  }

  async getJob(id: string): Promise<SendJobRecord | null> {
    const [row] = await db.select().from(sendJobs).where(eq(sendJobs.id, id)).limit(1);
    return row ? toJob(row) : null;
  }

  async saveJob(job: SendJobRecord): Promise<void> {
    await db.insert(sendJobs).values(fromJob(job)).onConflictDoUpdate({
      target: sendJobs.id,
      set: fromJob(job),
    });
  }

  async listRecipients(jobId?: string): Promise<SendRecipientRecord[]> {
    const rows = jobId
      ? await db.select().from(sendJobRecipients).where(eq(sendJobRecipients.jobId, jobId))
      : await db.select().from(sendJobRecipients);
    return rows.map(toRecipient);
  }

  async getRecipient(id: string): Promise<SendRecipientRecord | null> {
    const [row] = await db.select().from(sendJobRecipients).where(eq(sendJobRecipients.id, id)).limit(1);
    return row ? toRecipient(row) : null;
  }

  async saveRecipient(row: SendRecipientRecord): Promise<void> {
    await db.insert(sendJobRecipients).values(fromRecipient(row)).onConflictDoUpdate({
      target: sendJobRecipients.id,
      set: fromRecipient(row),
    });
  }

  async appendEvent(event: SafeguardEventRecord): Promise<void> {
    await db.insert(sendSafeguardEvents).values({
      id: event.id,
      jobId: event.jobId,
      eventType: event.eventType,
      detail: event.detail,
      createdAt: new Date(event.createdAt),
    });
  }

  async listEvents(jobId?: string | null): Promise<SafeguardEventRecord[]> {
    const rows = jobId
      ? await db.select().from(sendSafeguardEvents).where(eq(sendSafeguardEvents.jobId, jobId))
      : await db.select().from(sendSafeguardEvents);
    return rows.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      eventType: row.eventType as SafeguardEventRecord['eventType'],
      detail: row.detail ?? {},
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async getCode(): Promise<OperatorCodeRecord> {
    const [row] = await db.select().from(operatorSendCode).where(eq(operatorSendCode.id, 'operator')).limit(1);
    if (!row) return { codeHash: null, salt: null, failedAttempts: 0, locked: false, lockedAt: null };
    return {
      codeHash: row.codeHash,
      salt: row.salt,
      failedAttempts: row.failedAttempts,
      locked: row.locked,
      lockedAt: iso(row.lockedAt),
    };
  }

  async saveCode(row: OperatorCodeRecord): Promise<void> {
    const values = {
      id: 'operator',
      codeHash: row.codeHash,
      salt: row.salt,
      failedAttempts: row.failedAttempts,
      locked: row.locked,
      lockedAt: date(row.lockedAt),
      updatedAt: new Date(),
    };
    await db.insert(operatorSendCode).values(values).onConflictDoUpdate({
      target: operatorSendCode.id,
      set: values,
    });
  }

  async isKillSwitchOn(): Promise<boolean> {
    const policy = await loadOutboundPolicy();
    return policy?.killSwitch === true;
  }

  async rehearsalDestinations(): Promise<RehearsalDestinations> {
    const policy = await loadOutboundPolicy();
    return { phone: policy?.rehearsalPhone ?? null, email: policy?.rehearsalEmail ?? null };
  }

  async countRehearsalBypassesSince(since: Date): Promise<number> {
    const { outboundAudit } = await import('@workspace/db');
    const { and, eq, gte, sql } = await import('drizzle-orm');
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(outboundAudit)
      .where(and(eq(outboundAudit.toolName, REHEARSAL_BYPASS_AUDIT_TOOL), gte(outboundAudit.createdAt, since)));
    return Number(row?.n ?? 0);
  }

  /** Throws on failure on purpose: an un-audited bypass must not happen. */
  async recordRehearsalBypass(entry: RehearsalBypassAuditEntry): Promise<void> {
    const { outboundAudit } = await import('@workspace/db');
    const policy = await loadOutboundPolicy();
    await db.insert(outboundAudit).values({
      id: randomUUID(),
      projectId: 'apex',
      toolName: REHEARSAL_BYPASS_AUDIT_TOOL,
      destination: entry.maskedDestination,
      leadId: null,
      policyMode: policy?.mode ?? 'unknown',
      providerId: entry.jobId,
      rehearsal: true,
      detail: `${entry.detail} (${entry.channel})`,
      createdAt: new Date(),
    });
  }

  async isSuppressed(channel: SendChannel, destination: string): Promise<boolean> {
    const normalized = normalizeDestination(channel, destination);
    const { emailSuppressions, suppressions } = await import('@workspace/db');
    const { and, eq, or, isNull, gt } = await import('drizzle-orm');
    if (channel === 'email' || channel === 'calendar') {
      const [emailRow] = await db.select({ email: emailSuppressions.email }).from(emailSuppressions).where(eq(emailSuppressions.email, normalized)).limit(1);
      if (emailRow) return true;
    }
    const now = new Date();
    const rows = await db.select({ id: suppressions.id }).from(suppressions).where(and(
      or(
        eq(suppressions.channel, channel),
        eq(suppressions.channel, 'all'),
        channel === 'calendar' ? eq(suppressions.channel, 'email') : eq(suppressions.channel, channel),
      ),
      channel === 'email' || channel === 'calendar'
        ? eq(suppressions.email, normalized)
        : eq(suppressions.phoneE164, normalized),
      or(isNull(suppressions.expiresAt), gt(suppressions.expiresAt, now)),
      // A lifted opt-out no longer blocks: the row stays as the record that the
      // opt-out happened and was lifted by the operator.
      isNull(suppressions.liftedAt),
    )).limit(1);
    if (rows.length > 0) return true;
    // Contact-level do-not-contact covers every channel: a STOP by text or an
    // email bounce blocks a held call to the same person, including one the
    // operator released before the opt-out arrived. Errors propagate so the
    // engine fails closed.
    const { assertContactSendable } = await import('./crm/store.js');
    const { SendBlockedError } = await import('./crm/pure.js');
    try {
      await assertContactSendable({ channel, destination: normalized });
      return false;
    } catch (error) {
      if (error instanceof SendBlockedError) return true;
      throw error;
    }
  }
}

function toJob(row: typeof sendJobs.$inferSelect): SendJobRecord {
  return {
    id: row.id,
    campaignKey: row.campaignKey,
    storyKey: row.storyKey,
    fullAuto: row.fullAuto,
    status: row.status as SendJobStatus,
    confirm1At: iso(row.confirm1At),
    confirm2At: iso(row.confirm2At),
    codeVerifiedAt: iso(row.codeVerifiedAt),
    contentHash: row.contentHash,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function fromJob(job: SendJobRecord) {
  return {
    id: job.id,
    campaignKey: job.campaignKey,
    storyKey: job.storyKey,
    fullAuto: job.fullAuto,
    status: job.status,
    confirm1At: date(job.confirm1At),
    confirm2At: date(job.confirm2At),
    codeVerifiedAt: date(job.codeVerifiedAt),
    contentHash: job.contentHash,
    createdBy: job.createdBy,
    createdAt: new Date(job.createdAt),
    updatedAt: new Date(job.updatedAt),
  };
}

function toRecipient(row: typeof sendJobRecipients.$inferSelect): SendRecipientRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    channel: row.channel as SendChannel,
    destination: row.destination,
    messageText: row.messageText,
    payload: row.payload ?? {},
    status: row.status as RecipientStatus,
    released: row.released,
    externalId: row.externalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function fromRecipient(row: SendRecipientRecord) {
  return {
    id: row.id,
    jobId: row.jobId,
    channel: row.channel,
    destination: row.destination,
    messageText: row.messageText,
    payload: row.payload,
    status: row.status,
    released: row.released,
    externalId: row.externalId,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}
