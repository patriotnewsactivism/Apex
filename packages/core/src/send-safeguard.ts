// Server-side SEND SAFEGUARD. Every outbound contact — email, call, SMS,
// calendar invite — must pass assertSendAllowed at the moment of the actual
// provider call. Fail closed on any error. The operator 4-digit code is never
// logged or stored in plaintext; only a scrypt hash + per-code salt.

import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { emitApexEvent } from './base-agent.js';

const scryptAsync = promisify(scrypt);

export const SEND_CHANNELS = ['email', 'call', 'sms', 'calendar'] as const;
export type SendChannel = (typeof SEND_CHANNELS)[number];

export const SEND_SAFEGUARD_ACTORS = [
  'operator_dashboard',
  'agent',
  'tool',
  'bot_token',
  'voice',
  'background_job',
  'unknown',
] as const;
export type SendSafeguardActor = (typeof SEND_SAFEGUARD_ACTORS)[number];

export const OPERATOR_DASHBOARD_CLIENT = 'apex-dashboard';
export const CODE_THRESHOLD = 5;
export const AGGREGATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_CODE_FAILURES = 3;
export const SCRYPT_KEYLEN = 64;
export const SCRYPT_SALT_LEN = 16;

export type SendJobStatus =
  | 'waiting_confirm'
  | 'waiting_confirm_2'
  | 'waiting_code'
  | 'cleared'
  | 'sending'
  | 'stopped'
  | 'voided'
  | 'completed'
  | 'cancelled';

export type SendRecipientStatus =
  | 'pending'
  | 'released'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export type SendSafeguardEventType =
  | 'job_created'
  | 'confirm_1'
  | 'confirm_2'
  | 'code_ok'
  | 'code_failed'
  | 'locked'
  | 'unlocked'
  | 'stop'
  | 'voided'
  | 'send_attempt'
  | 'send_ok'
  | 'send_blocked'
  | 'full_auto'
  | 'released'
  | 'updated';

export interface SendSafeguardSession {
  actor: SendSafeguardActor;
  client?: string | null;
  authKind?: 'admin' | 'bot_token' | 'none';
  operatorSessionValid?: boolean;
}

export interface SendJobRecipientInput {
  channel: SendChannel;
  destination: string;
  messageText: string;
  payload?: Record<string, unknown>;
}

export interface SendJobRecord {
  id: string;
  status: SendJobStatus;
  channelSummary: string;
  campaignKey: string | null;
  storyKey: string | null;
  messageText: string;
  messageFingerprint: string;
  recipientCount: number;
  fullAuto: boolean;
  confirm1At: Date | null;
  confirm2At: Date | null;
  codeVerifiedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  stoppedAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
}

export interface SendRecipientRecord {
  id: string;
  jobId: string;
  channel: SendChannel;
  destination: string;
  messageText: string;
  messageFingerprint: string;
  status: SendRecipientStatus;
  releasedAt: Date | null;
  sentAt: Date | null;
  cancelledAt: Date | null;
  errorMessage: string | null;
  payload: Record<string, unknown> | null;
}

export interface SendSafeguardEventRecord {
  id: string;
  jobId: string | null;
  recipientId: string | null;
  eventType: SendSafeguardEventType;
  detail: string | null;
  actor: string | null;
  createdAt: Date;
}

export interface OperatorCodeState {
  codeHash: string | null;
  codeSalt: string | null;
  failedAttempts: number;
  locked: boolean;
  lockedAt: Date | null;
}

export class SendSafeguardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SendSafeguardError';
    this.code = code;
  }
}

export function isSendSafeguardError(error: unknown): error is SendSafeguardError {
  return error instanceof SendSafeguardError;
}

export function isOperatorDashboardSession(session: SendSafeguardSession | null | undefined): boolean {
  if (!session) return false;
  return (
    session.actor === 'operator_dashboard'
    && session.client === OPERATOR_DASHBOARD_CLIENT
    && session.authKind === 'admin'
    && session.operatorSessionValid === true
  );
}

export function rejectNonOperatorCodeSource(session: SendSafeguardSession | null | undefined): void {
  if (isOperatorDashboardSession(session)) return;
  const actor = session?.actor ?? 'unknown';
  throw new SendSafeguardError(
    'code_source_rejected',
    `Safeguard code can only be entered from an authenticated operator dashboard session (rejected actor=${actor})`,
  );
}

export function normalizeDestination(channel: SendChannel, raw: string): string {
  const value = raw.trim();
  if (channel === 'email' || channel === 'calendar') return value.toLowerCase();
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (value.startsWith('+') && digits.length >= 8) return `+${digits}`;
  return value;
}

export function fingerprintMessage(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function isValidFourDigitCode(code: string): boolean {
  return /^\d{4}$/.test(code);
}

export async function hashOperatorCode(code: string): Promise<{ hashHex: string; saltHex: string }> {
  if (!isValidFourDigitCode(code)) {
    throw new SendSafeguardError('invalid_code_format', 'Code must be exactly four digits');
  }
  const salt = randomBytes(SCRYPT_SALT_LEN);
  const hash = await scryptAsync(code, salt, SCRYPT_KEYLEN) as Buffer;
  return { hashHex: hash.toString('hex'), saltHex: salt.toString('hex') };
}

export async function verifyOperatorCode(code: string, hashHex: string, saltHex: string): Promise<boolean> {
  if (!isValidFourDigitCode(code) || !hashHex || !saltHex) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await scryptAsync(code, salt, expected.length) as Buffer;
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function aggregatedRecipientCount(
  job: Pick<SendJobRecord, 'campaignKey' | 'storyKey' | 'recipientCount' | 'id'>,
  siblings: Array<Pick<SendJobRecord, 'id' | 'campaignKey' | 'storyKey' | 'recipientCount' | 'createdAt' | 'status'>>,
  now: Date,
): number {
  const windowStart = now.getTime() - AGGREGATION_WINDOW_MS;
  let total = job.recipientCount;
  for (const sibling of siblings) {
    if (sibling.id === job.id) continue;
    if (sibling.status === 'voided' || sibling.status === 'cancelled') continue;
    if (sibling.createdAt.getTime() < windowStart) continue;
    const sameCampaign = Boolean(job.campaignKey && sibling.campaignKey === job.campaignKey);
    const sameStory = Boolean(job.storyKey && sibling.storyKey === job.storyKey);
    if (sameCampaign || sameStory) total += sibling.recipientCount;
  }
  return total;
}

export function codeRequiredForCount(aggregatedCount: number): boolean {
  return aggregatedCount >= CODE_THRESHOLD;
}

export function publicJobStatus(job: SendJobRecord, aggregatedCount: number): string {
  if (job.status === 'stopped') return 'stopped';
  if (job.status === 'voided') return 'voided';
  if (job.status === 'cancelled') return 'stopped';
  if (job.status === 'sending') return 'code entered, sending';
  if (job.status === 'cleared' || job.status === 'completed') return 'code entered, sending';
  if (job.status === 'waiting_code') return 'waiting for code';
  if (job.status === 'waiting_confirm' || job.status === 'waiting_confirm_2') {
    if (codeRequiredForCount(aggregatedCount) && job.confirm1At && job.confirm2At) return 'waiting for code';
    return 'waiting for confirm';
  }
  return job.status;
}

function logBlocked(jobId: string, channel: string, code: string): void {
  console.error(`[send-safeguard] blocked job=${jobId} channel=${channel} reason=${code}`);
}

export interface SendSafeguardStore {
  getJob(id: string): Promise<SendJobRecord | null>;
  listJobs(): Promise<SendJobRecord[]>;
  listRecentRelatedJobs(campaignKey: string | null, storyKey: string | null, since: Date): Promise<SendJobRecord[]>;
  insertJob(job: SendJobRecord, recipients: SendRecipientRecord[]): Promise<void>;
  updateJob(id: string, patch: Partial<SendJobRecord>): Promise<void>;
  getRecipients(jobId: string): Promise<SendRecipientRecord[]>;
  getRecipient(jobId: string, destination: string, channel: SendChannel): Promise<SendRecipientRecord | null>;
  updateRecipient(id: string, patch: Partial<SendRecipientRecord>): Promise<void>;
  appendEvent(event: SendSafeguardEventRecord): Promise<void>;
  listEvents(jobId?: string): Promise<SendSafeguardEventRecord[]>;
  getOperator(): Promise<OperatorCodeState>;
  setOperator(patch: Partial<OperatorCodeState>): Promise<void>;
}

export class MemorySendSafeguardStore implements SendSafeguardStore {
  jobs = new Map<string, SendJobRecord>();
  recipients = new Map<string, SendRecipientRecord>();
  events: SendSafeguardEventRecord[] = [];
  operator: OperatorCodeState = {
    codeHash: null,
    codeSalt: null,
    failedAttempts: 0,
    locked: false,
    lockedAt: null,
  };

  async getJob(id: string): Promise<SendJobRecord | null> {
    return this.jobs.get(id) ?? null;
  }

  async listJobs(): Promise<SendJobRecord[]> {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async listRecentRelatedJobs(
    campaignKey: string | null,
    storyKey: string | null,
    since: Date,
  ): Promise<SendJobRecord[]> {
    return [...this.jobs.values()].filter((job) => {
      if (job.createdAt.getTime() < since.getTime()) return false;
      const sameCampaign = Boolean(campaignKey && job.campaignKey === campaignKey);
      const sameStory = Boolean(storyKey && job.storyKey === storyKey);
      return sameCampaign || sameStory;
    });
  }

  async insertJob(job: SendJobRecord, recipients: SendRecipientRecord[]): Promise<void> {
    this.jobs.set(job.id, { ...job });
    for (const recipient of recipients) this.recipients.set(recipient.id, { ...recipient });
  }

  async updateJob(id: string, patch: Partial<SendJobRecord>): Promise<void> {
    const current = this.jobs.get(id);
    if (!current) throw new SendSafeguardError('job_not_found', `Send job ${id} not found`);
    this.jobs.set(id, { ...current, ...patch, updatedAt: patch.updatedAt ?? new Date() });
  }

  async getRecipients(jobId: string): Promise<SendRecipientRecord[]> {
    return [...this.recipients.values()].filter((row) => row.jobId === jobId);
  }

  async getRecipient(jobId: string, destination: string, channel: SendChannel): Promise<SendRecipientRecord | null> {
    return [...this.recipients.values()].find((row) =>
      row.jobId === jobId && row.channel === channel && row.destination === destination,
    ) ?? null;
  }

  async updateRecipient(id: string, patch: Partial<SendRecipientRecord>): Promise<void> {
    const current = this.recipients.get(id);
    if (!current) throw new SendSafeguardError('recipient_not_found', `Recipient ${id} not found`);
    this.recipients.set(id, { ...current, ...patch });
  }

  async appendEvent(event: SendSafeguardEventRecord): Promise<void> {
    this.events.push({ ...event });
  }

  async listEvents(jobId?: string): Promise<SendSafeguardEventRecord[]> {
    return this.events.filter((event) => jobId ? event.jobId === jobId : true);
  }

  async getOperator(): Promise<OperatorCodeState> {
    return { ...this.operator };
  }

  async setOperator(patch: Partial<OperatorCodeState>): Promise<void> {
    this.operator = { ...this.operator, ...patch };
  }
}

export interface SendSafeguardDeps {
  store: SendSafeguardStore;
  loadKillSwitch: () => Promise<boolean>;
  isRecipientSuppressed: (channel: SendChannel, destination: string) => Promise<boolean>;
  now?: () => Date;
  emit?: (status: string, jobId: string | null, message: string, count?: number) => void;
  alertOperator?: (message: string) => Promise<void>;
}

let activeDeps: SendSafeguardDeps | null = null;

export function configureSendSafeguard(deps: SendSafeguardDeps): void {
  activeDeps = deps;
}

export function resetSendSafeguardForTests(): void {
  activeDeps = null;
}

export function getSendSafeguardDeps(): SendSafeguardDeps {
  if (!activeDeps) {
    throw new SendSafeguardError('fail_closed', 'Send safeguard is not configured');
  }
  return activeDeps;
}

function clock(deps: SendSafeguardDeps): Date {
  return deps.now ? deps.now() : new Date();
}

async function recordEvent(
  deps: SendSafeguardDeps,
  input: {
    jobId?: string | null;
    recipientId?: string | null;
    eventType: SendSafeguardEventType;
    detail?: string;
    actor?: string;
  },
): Promise<void> {
  await deps.store.appendEvent({
    id: randomUUID(),
    jobId: input.jobId ?? null,
    recipientId: input.recipientId ?? null,
    eventType: input.eventType,
    detail: input.detail ?? null,
    actor: input.actor ?? null,
    createdAt: clock(deps),
  });
}

function emitStatus(deps: SendSafeguardDeps, status: string, jobId: string | null, message: string, count?: number): void {
  try {
    deps.emit?.(status, jobId, message, count);
    emitApexEvent({
      type: 'send-safeguard:status',
      jobId,
      status,
      message,
      count,
      timestamp: clock(deps).toISOString(),
    });
  } catch {
    // Status fan-out must never convert a gate decision into a send.
  }
}

export async function createSendJob(input: {
  recipients: SendJobRecipientInput[];
  campaignKey?: string | null;
  storyKey?: string | null;
  messageText?: string;
  fullAuto?: boolean;
  createdBy?: string;
  jobId?: string;
}): Promise<SendJobRecord> {
  const deps = getSendSafeguardDeps();
  try {
    if (!input.recipients.length) {
      throw new SendSafeguardError('empty_job', 'A send job requires at least one recipient');
    }
    if (await deps.loadKillSwitch()) {
      throw new SendSafeguardError('kill_switch', 'Outbound kill switch is on; refusing to enqueue');
    }
    const operator = await deps.store.getOperator();
    if (operator.locked) {
      throw new SendSafeguardError('locked', 'Sending is locked after failed safeguard-code attempts');
    }

    const recipients: SendRecipientRecord[] = [];
    for (const raw of input.recipients) {
      if (!SEND_CHANNELS.includes(raw.channel)) {
        throw new SendSafeguardError('invalid_channel', `Unsupported channel ${String(raw.channel)}`);
      }
      const destination = normalizeDestination(raw.channel, raw.destination);
      if (!destination) throw new SendSafeguardError('blank_destination', 'Recipient destination is blank');
      const messageText = raw.messageText;
      recipients.push({
        id: randomUUID(),
        jobId: '',
        channel: raw.channel,
        destination,
        messageText,
        messageFingerprint: fingerprintMessage(messageText),
        status: 'pending',
        releasedAt: null,
        sentAt: null,
        cancelledAt: null,
        errorMessage: null,
        payload: raw.payload ?? null,
      });
    }

    const messageText = input.messageText ?? recipients.map((row) => row.messageText).join('\n---\n');
    const channels = [...new Set(recipients.map((row) => row.channel))];
    const now = clock(deps);
    const job: SendJobRecord = {
      id: input.jobId ?? randomUUID(),
      status: 'waiting_confirm',
      channelSummary: channels.length === 1 ? channels[0]! : 'mixed',
      campaignKey: input.campaignKey ?? null,
      storyKey: input.storyKey ?? null,
      messageText,
      messageFingerprint: fingerprintMessage(messageText),
      recipientCount: recipients.length,
      fullAuto: Boolean(input.fullAuto),
      confirm1At: null,
      confirm2At: null,
      codeVerifiedAt: null,
      createdBy: input.createdBy ?? 'system',
      createdAt: now,
      updatedAt: now,
      stoppedAt: null,
      voidedAt: null,
      voidReason: null,
    };
    for (const recipient of recipients) recipient.jobId = job.id;
    await deps.store.insertJob(job, recipients);
    await recordEvent(deps, {
      jobId: job.id,
      eventType: 'job_created',
      detail: `${recipients.length} recipient(s) across ${channels.join(',')}`,
      actor: input.createdBy ?? 'system',
    });
    emitStatus(deps, 'waiting for confirm', job.id, 'Send job created. Nothing has been sent.', recipients.length);
    return job;
  } catch (error) {
    if (error instanceof SendSafeguardError) throw error;
    throw new SendSafeguardError(
      'fail_closed',
      `Send job create failed closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function findReusableJob(input: {
  campaignKey?: string | null;
  storyKey?: string | null;
  recipients: SendJobRecipientInput[];
}): Promise<SendJobRecord | null> {
  const deps = getSendSafeguardDeps();
  const messageText = input.recipients.map((row) => row.messageText).join('\n---\n');
  const fingerprint = fingerprintMessage(messageText);
  const destKey = input.recipients
    .map((row) => `${row.channel}:${normalizeDestination(row.channel, row.destination)}`)
    .sort()
    .join('|');
  const since = new Date(clock(deps).getTime() - AGGREGATION_WINDOW_MS);
  const related = await deps.store.listRecentRelatedJobs(input.campaignKey ?? null, input.storyKey ?? null, since);
  const candidates = related.length > 0
    ? related
    : (await deps.store.listJobs()).filter((job) => job.createdAt.getTime() >= since.getTime());
  for (const job of candidates) {
    if (job.status === 'voided' || job.status === 'stopped' || job.status === 'cancelled' || job.status === 'completed') {
      continue;
    }
    if (job.messageFingerprint !== fingerprint) continue;
    const rows = await deps.store.getRecipients(job.id);
    const existing = rows.map((row) => `${row.channel}:${row.destination}`).sort().join('|');
    if (existing === destKey) return job;
  }
  return null;
}

export async function ensureSendJob(input: {
  recipients: SendJobRecipientInput[];
  campaignKey?: string | null;
  storyKey?: string | null;
  messageText?: string;
  createdBy?: string;
  jobId?: string;
}): Promise<SendJobRecord> {
  if (input.jobId) {
    const existing = await getSendSafeguardDeps().store.getJob(input.jobId);
    if (existing) return existing;
  }
  const reusable = await findReusableJob(input);
  if (reusable) return reusable;
  return createSendJob(input);
}

async function resolveAggregatedCount(deps: SendSafeguardDeps, job: SendJobRecord): Promise<number> {
  const since = new Date(clock(deps).getTime() - AGGREGATION_WINDOW_MS);
  const siblings = await deps.store.listRecentRelatedJobs(job.campaignKey, job.storyKey, since);
  return aggregatedRecipientCount(job, siblings, clock(deps));
}

async function nextStatusAfterConfirms(deps: SendSafeguardDeps, job: SendJobRecord): Promise<SendJobStatus> {
  const count = await resolveAggregatedCount(deps, job);
  if (codeRequiredForCount(count)) return 'waiting_code';
  return 'cleared';
}

export async function setJobFullAuto(jobId: string, fullAuto: boolean, session: SendSafeguardSession): Promise<SendJobRecord> {
  if (!isOperatorDashboardSession(session)) {
    throw new SendSafeguardError('operator_only', 'Only the operator dashboard can mark a job full-auto');
  }
  const deps = getSendSafeguardDeps();
  const job = await requireJob(deps, jobId);
  if (job.status === 'voided' || job.status === 'stopped' || job.status === 'cancelled') {
    throw new SendSafeguardError('job_closed', `Job ${jobId} is ${job.status} and cannot change full-auto`);
  }
  await deps.store.updateJob(jobId, { fullAuto, updatedAt: clock(deps) });
  await recordEvent(deps, { jobId, eventType: 'full_auto', detail: fullAuto ? 'enabled' : 'disabled', actor: 'operator' });
  return (await deps.store.getJob(jobId))!;
}

export async function confirmSendJob(jobId: string, step: 1 | 2, session: SendSafeguardSession): Promise<SendJobRecord> {
  if (!isOperatorDashboardSession(session)) {
    throw new SendSafeguardError('operator_only', 'Confirmations can only come from the operator dashboard');
  }
  const deps = getSendSafeguardDeps();
  const job = await requireOpenJob(deps, jobId);
  const now = clock(deps);
  if (step === 1) {
    if (job.confirm1At) return job;
    await deps.store.updateJob(jobId, { confirm1At: now, status: 'waiting_confirm_2', updatedAt: now });
    await recordEvent(deps, { jobId, eventType: 'confirm_1', detail: `${job.recipientCount} recipient(s)`, actor: 'operator' });
    emitStatus(deps, 'waiting for confirm', jobId, 'First confirm recorded. A second confirm is still required.', job.recipientCount);
    return (await deps.store.getJob(jobId))!;
  }
  if (!job.confirm1At) {
    throw new SendSafeguardError('confirm_order', 'Confirm 1 is required before confirm 2');
  }
  if (job.confirm2At) {
    const current = (await deps.store.getJob(jobId))!;
    return current;
  }
  const next = await nextStatusAfterConfirms(deps, job);
  await deps.store.updateJob(jobId, { confirm2At: now, status: next, updatedAt: now });
  await recordEvent(deps, { jobId, eventType: 'confirm_2', detail: `next=${next}`, actor: 'operator' });
  emitStatus(
    deps,
    next === 'waiting_code' ? 'waiting for code' : 'code entered, sending',
    jobId,
    next === 'waiting_code'
      ? 'Both confirms recorded. Enter the 4-digit code to release this job.'
      : 'Both confirms recorded. Job is cleared.',
    job.recipientCount,
  );
  if (next === 'cleared' && job.fullAuto) {
    await releaseAllPending(deps, jobId);
  }
  return (await deps.store.getJob(jobId))!;
}

export async function submitSafeguardCode(
  jobId: string,
  code: string,
  session: SendSafeguardSession,
): Promise<SendJobRecord> {
  rejectNonOperatorCodeSource(session);
  const deps = getSendSafeguardDeps();
  try {
    const operator = await deps.store.getOperator();
    if (operator.locked) {
      throw new SendSafeguardError('locked', 'Sending is locked after three failed code attempts');
    }
    const job = await requireOpenJob(deps, jobId);
    if (!job.confirm1At || !job.confirm2At) {
      throw new SendSafeguardError('confirms_required', 'Both confirms are required before the code');
    }
    const aggregated = await resolveAggregatedCount(deps, job);
    if (!codeRequiredForCount(aggregated)) {
      await deps.store.updateJob(jobId, { status: 'cleared', updatedAt: clock(deps) });
      return (await deps.store.getJob(jobId))!;
    }
    if (!operator.codeHash || !operator.codeSalt) {
      throw new SendSafeguardError('code_not_set', 'Operator has not set a 4-digit send code');
    }
    const ok = await verifyOperatorCode(code, operator.codeHash, operator.codeSalt);
    if (!ok) {
      const failures = operator.failedAttempts + 1;
      const locked = failures >= MAX_CODE_FAILURES;
      await deps.store.setOperator({
        failedAttempts: failures,
        locked,
        lockedAt: locked ? clock(deps) : operator.lockedAt,
      });
      await recordEvent(deps, {
        jobId,
        eventType: locked ? 'locked' : 'code_failed',
        detail: locked ? 'global send lock after 3 failed attempts' : 'incorrect code',
        actor: 'operator',
      });
      if (locked) {
        emitStatus(deps, 'locked', jobId, 'Sending is locked after three failed code attempts.');
        try {
          await deps.alertOperator?.('Send safeguard locked after 3 failed 4-digit code attempts. Unlock from Pending Sends with the operator password.');
        } catch {
          // Alert failure must not unlock or send.
        }
        throw new SendSafeguardError('locked', 'Sending is locked after three failed code attempts');
      }
      throw new SendSafeguardError('code_failed', `Incorrect code (${failures}/${MAX_CODE_FAILURES} attempts)`);
    }
    const now = clock(deps);
    await deps.store.setOperator({ failedAttempts: 0 });
    await deps.store.updateJob(jobId, { codeVerifiedAt: now, status: job.fullAuto ? 'sending' : 'cleared', updatedAt: now });
    await recordEvent(deps, { jobId, eventType: 'code_ok', detail: 'job cleared', actor: 'operator' });
    emitStatus(deps, 'code entered, sending', jobId, 'Code accepted for this job only.', job.recipientCount);
    if (job.fullAuto) await releaseAllPending(deps, jobId);
    return (await deps.store.getJob(jobId))!;
  } catch (error) {
    if (error instanceof SendSafeguardError) throw error;
    throw new SendSafeguardError(
      'fail_closed',
      `Code check failed closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function setOperatorCode(code: string): Promise<void> {
  const deps = getSendSafeguardDeps();
  const hashed = await hashOperatorCode(code);
  await deps.store.setOperator({
    codeHash: hashed.hashHex,
    codeSalt: hashed.saltHex,
    failedAttempts: 0,
    locked: false,
    lockedAt: null,
  });
}

export async function unlockSafeguard(): Promise<void> {
  const deps = getSendSafeguardDeps();
  await deps.store.setOperator({ failedAttempts: 0, locked: false, lockedAt: null });
  await recordEvent(deps, { eventType: 'unlocked', detail: 'operator unlocked sending', actor: 'operator' });
  emitStatus(deps, 'unlocked', null, 'Operator unlocked sending.');
}

export async function stopSendJob(jobId: string, session?: SendSafeguardSession): Promise<SendJobRecord> {
  if (session && !isOperatorDashboardSession(session)) {
    throw new SendSafeguardError('operator_only', 'Stop can only be issued from the operator dashboard');
  }
  const deps = getSendSafeguardDeps();
  const job = await requireJob(deps, jobId);
  const now = clock(deps);
  const recipients = await deps.store.getRecipients(jobId);
  for (const recipient of recipients) {
    if (recipient.status === 'sent' || recipient.status === 'cancelled') continue;
    await deps.store.updateRecipient(recipient.id, {
      status: 'cancelled',
      cancelledAt: now,
      errorMessage: recipient.errorMessage ?? 'Stopped by operator',
    });
  }
  await deps.store.updateJob(jobId, { status: 'stopped', stoppedAt: now, updatedAt: now });
  await recordEvent(deps, { jobId, eventType: 'stop', detail: 'operator stop', actor: 'operator' });
  emitStatus(deps, 'stopped', jobId, 'Job stopped. Queued items were cancelled, not deleted.');
  return (await deps.store.getJob(jobId))!;
}

export async function cancelSendJobsForCampaign(campaignKey: string): Promise<number> {
  const deps = getSendSafeguardDeps();
  const jobs = await deps.store.listRecentRelatedJobs(campaignKey, null, new Date(0));
  let cancelled = 0;
  for (const job of jobs) {
    if (job.campaignKey !== campaignKey) continue;
    if (job.status === 'completed' || job.status === 'voided' || job.status === 'stopped' || job.status === 'cancelled') {
      continue;
    }
    await stopSendJob(job.id);
    cancelled += 1;
  }
  return cancelled;
}

export async function voidSendJob(jobId: string, reason: string): Promise<SendJobRecord> {
  const deps = getSendSafeguardDeps();
  const job = await requireJob(deps, jobId);
  const now = clock(deps);
  await deps.store.updateJob(jobId, {
    status: 'voided',
    voidedAt: now,
    voidReason: reason,
    confirm1At: null,
    confirm2At: null,
    codeVerifiedAt: null,
    updatedAt: now,
  });
  await recordEvent(deps, { jobId, eventType: 'voided', detail: reason, actor: 'system' });
  emitStatus(deps, 'waiting for confirm', jobId, `Job voided: ${reason}. Start the confirm sequence again.`);
  return (await deps.store.getJob(jobId))!;
}

export async function updateSendJobContent(input: {
  jobId: string;
  recipients?: SendJobRecipientInput[];
  messageText?: string;
}): Promise<SendJobRecord> {
  const deps = getSendSafeguardDeps();
  const job = await requireJob(deps, input.jobId);
  const nextMessage = input.messageText ?? job.messageText;
  const nextFingerprint = fingerprintMessage(nextMessage);
  const recipientsChanged = Boolean(input.recipients);
  const messageChanged = nextFingerprint !== job.messageFingerprint;
  if ((recipientsChanged || messageChanged) && (job.confirm1At || job.confirm2At || job.codeVerifiedAt)) {
    return voidSendJob(job.id, 'Recipients or message changed after a confirm; all confirms and the code check are void.');
  }
  if (recipientsChanged && input.recipients) {
    throw new SendSafeguardError(
      'recreate_required',
      'Recipient edits after create require a new job. Existing confirms were voided if any existed.',
    );
  }
  if (messageChanged) {
    await deps.store.updateJob(job.id, {
      messageText: nextMessage,
      messageFingerprint: nextFingerprint,
      updatedAt: clock(deps),
    });
  }
  return (await deps.store.getJob(job.id))!;
}

export async function releaseRecipient(jobId: string, recipientId: string, session: SendSafeguardSession): Promise<void> {
  if (!isOperatorDashboardSession(session)) {
    throw new SendSafeguardError('operator_only', 'Per-message release requires the operator dashboard');
  }
  const deps = getSendSafeguardDeps();
  const job = await requireOpenJob(deps, jobId);
  if (job.status !== 'cleared' && job.status !== 'sending') {
    throw new SendSafeguardError('not_cleared', 'Job is not cleared; cannot release a recipient');
  }
  const recipients = await deps.store.getRecipients(jobId);
  const row = recipients.find((item) => item.id === recipientId);
  if (!row) throw new SendSafeguardError('recipient_not_found', 'Recipient is not on this job');
  await deps.store.updateRecipient(row.id, { status: 'released', releasedAt: clock(deps) });
  await recordEvent(deps, { jobId, recipientId, eventType: 'released', actor: 'operator' });
}

async function releaseAllPending(deps: SendSafeguardDeps, jobId: string): Promise<void> {
  const recipients = await deps.store.getRecipients(jobId);
  const now = clock(deps);
  for (const recipient of recipients) {
    if (recipient.status === 'pending') {
      await deps.store.updateRecipient(recipient.id, { status: 'released', releasedAt: now });
    }
  }
}

async function requireJob(deps: SendSafeguardDeps, jobId: string): Promise<SendJobRecord> {
  if (!jobId) throw new SendSafeguardError('missing_job', 'A send job id is required');
  const job = await deps.store.getJob(jobId);
  if (!job) throw new SendSafeguardError('job_not_found', `Send job ${jobId} not found`);
  return job;
}

async function requireOpenJob(deps: SendSafeguardDeps, jobId: string): Promise<SendJobRecord> {
  const job = await requireJob(deps, jobId);
  if (job.status === 'voided') throw new SendSafeguardError('voided', 'Job was voided; start over');
  if (job.status === 'stopped' || job.status === 'cancelled') {
    throw new SendSafeguardError('stopped', 'Job was stopped');
  }
  return job;
}

export async function assertSendAllowed(
  jobId: string,
  recipient: string,
  channel: SendChannel,
): Promise<void> {
  try {
    await assertSendAllowedInner(jobId, recipient, channel);
  } catch (error) {
    const code = error instanceof SendSafeguardError ? error.code : 'fail_closed';
    logBlocked(jobId || 'none', channel, code);
    try {
      if (activeDeps) {
        await recordEvent(activeDeps, {
          jobId: jobId || null,
          eventType: 'send_blocked',
          detail: code,
        });
      }
    } catch {
      // Audit write must not hide the original denial.
    }
    if (error instanceof SendSafeguardError) throw error;
    throw new SendSafeguardError(
      'fail_closed',
      `Send safeguard failed closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function assertSendAllowedInner(
  jobId: string,
  recipient: string,
  channel: SendChannel,
): Promise<void> {
  const deps = getSendSafeguardDeps();
  if (!SEND_CHANNELS.includes(channel)) {
    throw new SendSafeguardError('invalid_channel', `Unsupported channel ${String(channel)}`);
  }
  const operator = await deps.store.getOperator();
  if (operator.locked) {
    throw new SendSafeguardError('locked', 'Sending is locked after failed safeguard-code attempts');
  }
  if (await deps.loadKillSwitch()) {
    throw new SendSafeguardError('kill_switch', 'Outbound kill switch is on');
  }
  const job = await requireOpenJob(deps, jobId);
  const destination = normalizeDestination(channel, recipient);
  if (await deps.isRecipientSuppressed(channel, destination)) {
    throw new SendSafeguardError('suppressed', `Recipient ${destination} is on a do-not-contact / suppression list`);
  }
  const row = await deps.store.getRecipient(jobId, destination, channel);
  if (!row) {
    throw new SendSafeguardError('recipient_not_on_job', 'Recipient is not on this cleared send job');
  }
  if (row.status === 'cancelled' || row.status === 'blocked') {
    throw new SendSafeguardError('recipient_cancelled', 'Recipient was cancelled or blocked');
  }
  if (row.messageFingerprint !== fingerprintMessage(row.messageText)) {
    throw new SendSafeguardError('content_mismatch', 'Stored recipient message fingerprint does not match');
  }
  if (!job.confirm1At || !job.confirm2At) {
    throw new SendSafeguardError('not_confirmed', 'Both operator confirms are required before any send');
  }
  const aggregated = await resolveAggregatedCount(deps, job);
  if (codeRequiredForCount(aggregated) && !job.codeVerifiedAt) {
    throw new SendSafeguardError('code_required', 'A 4-digit operator code is required for this aggregated volume');
  }
  if (job.status !== 'cleared' && job.status !== 'sending') {
    throw new SendSafeguardError('not_cleared', `Job is ${job.status}; a fully cleared job is required`);
  }
  if (!job.fullAuto && row.status !== 'released' && row.status !== 'sending' && row.status !== 'sent') {
    throw new SendSafeguardError('per_message_wait', 'This job is not full-auto; the operator must release each send');
  }
  await recordEvent(deps, {
    jobId,
    recipientId: row.id,
    eventType: 'send_attempt',
    detail: `${channel}:${destination}`,
  });
}

export async function recordSendResult(
  jobId: string,
  recipient: string,
  channel: SendChannel,
  result: { ok: boolean; error?: string },
): Promise<void> {
  const deps = getSendSafeguardDeps();
  const destination = normalizeDestination(channel, recipient);
  const row = await deps.store.getRecipient(jobId, destination, channel);
  if (!row) return;
  await deps.store.updateRecipient(row.id, {
    status: result.ok ? 'sent' : 'failed',
    sentAt: result.ok ? clock(deps) : row.sentAt,
    errorMessage: result.ok ? null : (result.error ?? 'send failed').slice(0, 500),
  });
  await recordEvent(deps, {
    jobId,
    recipientId: row.id,
    eventType: result.ok ? 'send_ok' : 'send_blocked',
    detail: result.ok ? 'sent' : (result.error ?? 'failed'),
  });
}

export async function getSendJobView(jobId: string): Promise<{
  job: SendJobRecord;
  recipients: SendRecipientRecord[];
  aggregatedCount: number;
  codeRequired: boolean;
  publicStatus: string;
  events: SendSafeguardEventRecord[];
}> {
  const deps = getSendSafeguardDeps();
  const job = await requireJob(deps, jobId);
  const recipients = await deps.store.getRecipients(jobId);
  const aggregatedCount = await resolveAggregatedCount(deps, job);
  return {
    job,
    recipients,
    aggregatedCount,
    codeRequired: codeRequiredForCount(aggregatedCount),
    publicStatus: publicJobStatus(job, aggregatedCount),
    events: await deps.store.listEvents(jobId),
  };
}

export async function listSendJobs(): Promise<Array<{
  job: SendJobRecord;
  aggregatedCount: number;
  codeRequired: boolean;
  publicStatus: string;
}>> {
  const deps = getSendSafeguardDeps();
  const jobs = await deps.store.listJobs();
  const out = [];
  for (const job of jobs) {
    const aggregatedCount = await resolveAggregatedCount(deps, job);
    out.push({
      job,
      aggregatedCount,
      codeRequired: codeRequiredForCount(aggregatedCount),
      publicStatus: publicJobStatus(job, aggregatedCount),
    });
  }
  return out;
}

export async function getOperatorSafeguardSettings(): Promise<{
  codeSet: boolean;
  locked: boolean;
  failedAttempts: number;
  lockedAt: string | null;
}> {
  const operator = await getSendSafeguardDeps().store.getOperator();
  return {
    codeSet: Boolean(operator.codeHash && operator.codeSalt),
    locked: operator.locked,
    failedAttempts: operator.failedAttempts,
    lockedAt: operator.lockedAt ? operator.lockedAt.toISOString() : null,
  };
}

export async function gateOutboundSend(input: {
  channel: SendChannel;
  recipient: string;
  messageText: string;
  campaignKey?: string | null;
  storyKey?: string | null;
  jobId?: string | null;
  createdBy?: string;
  payload?: Record<string, unknown>;
}): Promise<{ jobId: string }> {
  const job = await ensureSendJob({
    jobId: input.jobId ?? undefined,
    campaignKey: input.campaignKey,
    storyKey: input.storyKey,
    createdBy: input.createdBy,
    messageText: input.messageText,
    recipients: [{
      channel: input.channel,
      destination: input.recipient,
      messageText: input.messageText,
      payload: input.payload,
    }],
  });
  await assertSendAllowed(job.id, input.recipient, input.channel);
  return { jobId: job.id };
}

export async function createProductionSendSafeguardDeps(): Promise<SendSafeguardDeps> {
  const store = await createDrizzleSendSafeguardStore();
  return {
    store,
    loadKillSwitch: async () => {
      try {
        const { loadOutboundPolicy } = await import('./outbound-policy-store.js');
        const policy = await loadOutboundPolicy();
        if (!policy) return true;
        return Boolean(policy.killSwitch);
      } catch {
        return true;
      }
    },
    isRecipientSuppressed: async (channel, destination) => {
      try {
        const { db, emailSuppressions, suppressions } = await import('@workspace/db');
        const { and, eq, or } = await import('drizzle-orm');
        if (channel === 'email' || channel === 'calendar') {
          const email = destination.toLowerCase();
          const [legacy] = await db.select({ email: emailSuppressions.email })
            .from(emailSuppressions)
            .where(eq(emailSuppressions.email, email))
            .limit(1);
          if (legacy) return true;
          const [row] = await db.select({ id: suppressions.id })
            .from(suppressions)
            .where(and(
              eq(suppressions.email, email),
              or(eq(suppressions.channel, 'all'), eq(suppressions.channel, 'email')),
            ))
            .limit(1);
          return Boolean(row);
        }
        const [row] = await db.select({ id: suppressions.id })
          .from(suppressions)
          .where(and(
            eq(suppressions.phoneE164, destination),
            or(eq(suppressions.channel, 'all'), eq(suppressions.channel, channel === 'sms' ? 'sms' : 'phone')),
          ))
          .limit(1);
        return Boolean(row);
      } catch {
        return true;
      }
    },
    alertOperator: async (message) => {
      try {
        const { db, approvals } = await import('@workspace/db');
        await db.insert(approvals).values({
          id: randomUUID(),
          taskId: 'send-safeguard',
          agentId: 'apex-system',
          toolName: 'send_safeguard_lock',
          toolArgs: { reason: 'lockout' },
          reason: message,
          status: 'pending',
          kind: 'escalation',
          createdAt: new Date(),
        });
      } catch (error) {
        console.error(
          '[send-safeguard] operator alert write failed:',
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

export async function ensureProductionSendSafeguard(): Promise<void> {
  if (activeDeps) return;
  configureSendSafeguard(await createProductionSendSafeguardDeps());
}

async function createDrizzleSendSafeguardStore(): Promise<SendSafeguardStore> {
  const { db, sendSafeguardJobs, sendSafeguardRecipients, sendSafeguardEvents, sendSafeguardOperator } = await import('@workspace/db');
  const { and, desc, eq, gte, or } = await import('drizzle-orm');

  const mapJob = (row: typeof sendSafeguardJobs.$inferSelect): SendJobRecord => ({
    id: row.id,
    status: row.status as SendJobStatus,
    channelSummary: row.channelSummary,
    campaignKey: row.campaignKey,
    storyKey: row.storyKey,
    messageText: row.messageText,
    messageFingerprint: row.messageFingerprint,
    recipientCount: row.recipientCount,
    fullAuto: row.fullAuto,
    confirm1At: row.confirm1At,
    confirm2At: row.confirm2At,
    codeVerifiedAt: row.codeVerifiedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    stoppedAt: row.stoppedAt,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
  });

  const mapRecipient = (row: typeof sendSafeguardRecipients.$inferSelect): SendRecipientRecord => ({
    id: row.id,
    jobId: row.jobId,
    channel: row.channel as SendChannel,
    destination: row.destination,
    messageText: row.messageText,
    messageFingerprint: row.messageFingerprint,
    status: row.status as SendRecipientStatus,
    releasedAt: row.releasedAt,
    sentAt: row.sentAt,
    cancelledAt: row.cancelledAt,
    errorMessage: row.errorMessage,
    payload: row.payload ?? null,
  });

  return {
    async getJob(id) {
      const [row] = await db.select().from(sendSafeguardJobs).where(eq(sendSafeguardJobs.id, id)).limit(1);
      return row ? mapJob(row) : null;
    },
    async listJobs() {
      const rows = await db.select().from(sendSafeguardJobs).orderBy(desc(sendSafeguardJobs.createdAt)).limit(200);
      return rows.map(mapJob);
    },
    async listRecentRelatedJobs(campaignKey, storyKey, since) {
      const clauses = [];
      if (campaignKey) clauses.push(eq(sendSafeguardJobs.campaignKey, campaignKey));
      if (storyKey) clauses.push(eq(sendSafeguardJobs.storyKey, storyKey));
      if (clauses.length === 0) return [];
      const rows = await db.select().from(sendSafeguardJobs).where(and(gte(sendSafeguardJobs.createdAt, since), or(...clauses))).limit(500);
      return rows.map(mapJob);
    },
    async insertJob(job, recipients) {
      await db.insert(sendSafeguardJobs).values({
        id: job.id,
        status: job.status,
        channelSummary: job.channelSummary,
        campaignKey: job.campaignKey,
        storyKey: job.storyKey,
        messageText: job.messageText,
        messageFingerprint: job.messageFingerprint,
        recipientCount: job.recipientCount,
        fullAuto: job.fullAuto,
        confirm1At: job.confirm1At,
        confirm2At: job.confirm2At,
        codeVerifiedAt: job.codeVerifiedAt,
        createdBy: job.createdBy,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        stoppedAt: job.stoppedAt,
        voidedAt: job.voidedAt,
        voidReason: job.voidReason,
      });
      if (recipients.length) {
        await db.insert(sendSafeguardRecipients).values(recipients.map((row) => ({
          id: row.id,
          jobId: row.jobId,
          channel: row.channel,
          destination: row.destination,
          messageText: row.messageText,
          messageFingerprint: row.messageFingerprint,
          status: row.status,
          releasedAt: row.releasedAt,
          sentAt: row.sentAt,
          cancelledAt: row.cancelledAt,
          errorMessage: row.errorMessage,
          payload: row.payload,
        })));
      }
    },
    async updateJob(id, patch) {
      await db.update(sendSafeguardJobs).set({
        ...patch,
        updatedAt: patch.updatedAt ?? new Date(),
      }).where(eq(sendSafeguardJobs.id, id));
    },
    async getRecipients(jobId) {
      const rows = await db.select().from(sendSafeguardRecipients).where(eq(sendSafeguardRecipients.jobId, jobId));
      return rows.map(mapRecipient);
    },
    async getRecipient(jobId, destination, channel) {
      const [row] = await db.select().from(sendSafeguardRecipients).where(and(
        eq(sendSafeguardRecipients.jobId, jobId),
        eq(sendSafeguardRecipients.destination, destination),
        eq(sendSafeguardRecipients.channel, channel),
      )).limit(1);
      return row ? mapRecipient(row) : null;
    },
    async updateRecipient(id, patch) {
      await db.update(sendSafeguardRecipients).set(patch).where(eq(sendSafeguardRecipients.id, id));
    },
    async appendEvent(event) {
      await db.insert(sendSafeguardEvents).values({
        id: event.id,
        jobId: event.jobId,
        recipientId: event.recipientId,
        eventType: event.eventType,
        detail: event.detail,
        actor: event.actor,
        createdAt: event.createdAt,
      });
    },
    async listEvents(jobId) {
      const rows = jobId
        ? await db.select().from(sendSafeguardEvents).where(eq(sendSafeguardEvents.jobId, jobId)).orderBy(desc(sendSafeguardEvents.createdAt)).limit(200)
        : await db.select().from(sendSafeguardEvents).orderBy(desc(sendSafeguardEvents.createdAt)).limit(200);
      return rows.map((row) => ({
        id: row.id,
        jobId: row.jobId,
        recipientId: row.recipientId,
        eventType: row.eventType as SendSafeguardEventType,
        detail: row.detail,
        actor: row.actor,
        createdAt: row.createdAt,
      }));
    },
    async getOperator() {
      const [row] = await db.select().from(sendSafeguardOperator).where(eq(sendSafeguardOperator.id, 'default')).limit(1);
      if (!row) {
        return { codeHash: null, codeSalt: null, failedAttempts: 0, locked: false, lockedAt: null };
      }
      return {
        codeHash: row.codeHash,
        codeSalt: row.codeSalt,
        failedAttempts: row.failedAttempts,
        locked: row.locked,
        lockedAt: row.lockedAt,
      };
    },
    async setOperator(patch) {
      const current = await this.getOperator();
      await db.insert(sendSafeguardOperator).values({
        id: 'default',
        codeHash: patch.codeHash ?? current.codeHash,
        codeSalt: patch.codeSalt ?? current.codeSalt,
        failedAttempts: patch.failedAttempts ?? current.failedAttempts,
        locked: patch.locked ?? current.locked,
        lockedAt: patch.lockedAt === undefined ? current.lockedAt : patch.lockedAt,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: sendSafeguardOperator.id,
        set: {
          codeHash: patch.codeHash ?? current.codeHash,
          codeSalt: patch.codeSalt ?? current.codeSalt,
          failedAttempts: patch.failedAttempts ?? current.failedAttempts,
          locked: patch.locked ?? current.locked,
          lockedAt: patch.lockedAt === undefined ? current.lockedAt : patch.lockedAt,
          updatedAt: new Date(),
        },
      });
    },
  };
}
