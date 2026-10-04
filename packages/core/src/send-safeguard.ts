// Server-side send safeguard. Every outbound email, call, SMS, and calendar
// invite must pass assertSendAllowed before the provider is contacted.
// Fail closed: a missing job, a lock, a kill switch, or any lookup error blocks
// the send. The four-digit code is never logged, stored in events, or returned.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export const SEND_CODE_THRESHOLD = 5;
export const SEND_CODE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SEND_CODE_MAX_FAILURES = 3;

export type SendChannel = 'email' | 'phone' | 'sms' | 'calendar';

export type SendCaller =
  | 'operator-dashboard'
  | 'agent'
  | 'tool'
  | 'api-token'
  | 'voice'
  | 'chat'
  | 'background-job';

export type SendJobStatus =
  | 'waiting_confirm'
  | 'waiting_second_confirm'
  | 'waiting_code'
  | 'waiting_release'
  | 'sending'
  | 'stopped'
  | 'completed'
  | 'voided';

export type RecipientStatus =
  | 'queued'
  | 'released'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'voided';

export type SafeguardEventType =
  | 'job_created'
  | 'operator_direct'
  | 'confirm_1'
  | 'confirm_2'
  | 'code_ok'
  | 'code_failed'
  | 'code_rejected_source'
  | 'code_set'
  | 'locked'
  | 'unlocked'
  | 'stop'
  | 'voided'
  | 'send_attempt';

export type SendStatusLabel =
  | 'waiting for confirm'
  | 'waiting for code'
  | 'code entered, sending'
  | 'stopped'
  | 'locked';

export interface SendJobRecord {
  id: string;
  campaignKey: string | null;
  storyKey: string | null;
  fullAuto: boolean;
  status: SendJobStatus;
  confirm1At: string | null;
  confirm2At: string | null;
  codeVerifiedAt: string | null;
  contentHash: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SendRecipientRecord {
  id: string;
  jobId: string;
  channel: SendChannel;
  destination: string;
  messageText: string;
  payload: Record<string, unknown>;
  status: RecipientStatus;
  released: boolean;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OperatorCodeRecord {
  codeHash: string | null;
  salt: string | null;
  failedAttempts: number;
  locked: boolean;
  lockedAt: string | null;
}

export interface SafeguardEventRecord {
  id: string;
  jobId: string | null;
  eventType: SafeguardEventType;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface SendSafeguardStore {
  now(): Date;
  listJobs(): Promise<SendJobRecord[]>;
  getJob(id: string): Promise<SendJobRecord | null>;
  saveJob(job: SendJobRecord): Promise<void>;
  listRecipients(jobId?: string): Promise<SendRecipientRecord[]>;
  getRecipient(id: string): Promise<SendRecipientRecord | null>;
  saveRecipient(row: SendRecipientRecord): Promise<void>;
  appendEvent(event: SafeguardEventRecord): Promise<void>;
  listEvents(jobId?: string | null): Promise<SafeguardEventRecord[]>;
  getCode(): Promise<OperatorCodeRecord>;
  saveCode(row: OperatorCodeRecord): Promise<void>;
  isKillSwitchOn(): Promise<boolean>;
  isSuppressed(channel: SendChannel, destination: string): Promise<boolean>;
}

export interface SendStatusEvent {
  type: 'send-safeguard:status';
  jobId: string | null;
  status: string;
  label: SendStatusLabel;
  timestamp: string;
}

export class SendSafeguardError extends Error {
  readonly reason: string;
  readonly jobId: string | null;
  readonly channel: SendChannel | null;

  constructor(message: string, reason: string, jobId: string | null = null, channel: SendChannel | null = null) {
    super(message);
    this.name = 'SendSafeguardError';
    this.reason = reason;
    this.jobId = jobId;
    this.channel = channel;
  }
}

const callerStore = new AsyncLocalStorage<SendCaller>();

export function runWithSendCaller<T>(caller: SendCaller, fn: () => T): T {
  return callerStore.run(caller, fn);
}

export function currentSendCaller(): SendCaller | null {
  return callerStore.getStore() ?? null;
}

const NON_OPERATOR_CALLERS = new Set<SendCaller>([
  'agent',
  'tool',
  'api-token',
  'voice',
  'chat',
  'background-job',
]);

export function classifySendCaller(input: {
  declared?: string | null;
  operatorSessionValid: boolean;
}): SendCaller {
  const declared = (input.declared ?? '').trim();
  if (NON_OPERATOR_CALLERS.has(declared as SendCaller)) return declared as SendCaller;
  const runtime = currentSendCaller();
  if (runtime && runtime !== 'operator-dashboard') return runtime;
  if (input.operatorSessionValid && (declared === '' || declared === 'operator-dashboard')) {
    return 'operator-dashboard';
  }
  return 'api-token';
}

export function normalizeDestination(channel: SendChannel, raw: string): string {
  const value = raw.trim();
  if (channel === 'email' || channel === 'calendar') return value.toLowerCase();
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (value.startsWith('+') && digits.length > 0) return `+${digits}`;
  return digits ? `+${digits}` : value.toLowerCase();
}

export function hashSendContent(
  recipients: Array<{ channel: SendChannel; destination: string; messageText: string }>,
): string {
  const canonical = recipients.map((recipient) => ({
    channel: recipient.channel,
    destination: normalizeDestination(recipient.channel, recipient.destination),
    message: recipient.messageText,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export async function hashOperatorSendCode(code: string, salt = randomBytes(16).toString('hex')): Promise<{ hash: string; salt: string }> {
  const derived = (await scryptAsync(code, salt, 32)) as Buffer;
  return { hash: derived.toString('hex'), salt };
}

export async function operatorSendCodeMatches(code: string, hash: string, salt: string): Promise<boolean> {
  const derived = (await scryptAsync(code, salt, 32)) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  if (expected.length === 0 || expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}

let statusHook: ((event: SendStatusEvent) => void) | null = null;

export function setSendSafeguardStatusHook(hook: ((event: SendStatusEvent) => void) | null): void {
  statusHook = hook;
}

function emitStatus(jobId: string | null, status: string, label: SendStatusLabel): void {
  const event: SendStatusEvent = {
    type: 'send-safeguard:status',
    jobId,
    status,
    label,
    timestamp: new Date().toISOString(),
  };
  if (statusHook) {
    statusHook(event);
    return;
  }
  void import('./base-agent.js')
    .then((mod) => {
      mod.emitApexEvent(event);
      if (label === 'locked') {
        mod.emitApexEvent({
          type: 'health:alert',
          alertId: `send-safeguard-lock-${event.timestamp}`,
          severity: 'critical',
          message: 'Outbound sending is locked after repeated safeguard code failures.',
          component: 'send-safeguard',
        });
      }
    })
    .catch((error: unknown) => {
      console.error(
        '[send-safeguard] status event failed',
        error instanceof Error ? error.message : 'unavailable',
      );
    });
}

function labelForStatus(status: SendJobStatus): SendStatusLabel | null {
  if (status === 'waiting_confirm' || status === 'waiting_second_confirm' || status === 'waiting_release') {
    return 'waiting for confirm';
  }
  if (status === 'waiting_code') return 'waiting for code';
  if (status === 'sending') return 'code entered, sending';
  if (status === 'stopped') return 'stopped';
  return null;
}

function emptyCode(): OperatorCodeRecord {
  return { codeHash: null, salt: null, failedAttempts: 0, locked: false, lockedAt: null };
}

const COUNTED_STATUSES = new Set<RecipientStatus>([
  'queued',
  'released',
  'sending',
  'sent',
  'failed',
  'cancelled',
  'blocked',
]);

export class MemorySendSafeguardStore implements SendSafeguardStore {
  jobs = new Map<string, SendJobRecord>();
  recipients = new Map<string, SendRecipientRecord>();
  events: SafeguardEventRecord[] = [];
  code: OperatorCodeRecord = emptyCode();
  killSwitch = false;
  suppressed = new Set<string>();
  clock = new Date();

  now(): Date {
    return new Date(this.clock.getTime());
  }

  async listJobs(): Promise<SendJobRecord[]> {
    return [...this.jobs.values()];
  }

  async getJob(id: string): Promise<SendJobRecord | null> {
    return this.jobs.get(id) ?? null;
  }

  async saveJob(job: SendJobRecord): Promise<void> {
    this.jobs.set(job.id, { ...job });
  }

  async listRecipients(jobId?: string): Promise<SendRecipientRecord[]> {
    const rows = [...this.recipients.values()];
    return jobId ? rows.filter((row) => row.jobId === jobId) : rows;
  }

  async getRecipient(id: string): Promise<SendRecipientRecord | null> {
    return this.recipients.get(id) ?? null;
  }

  async saveRecipient(row: SendRecipientRecord): Promise<void> {
    this.recipients.set(row.id, { ...row, payload: { ...row.payload } });
  }

  async appendEvent(event: SafeguardEventRecord): Promise<void> {
    this.events.push({ ...event, detail: { ...event.detail } });
  }

  async listEvents(jobId?: string | null): Promise<SafeguardEventRecord[]> {
    if (jobId === undefined) return [...this.events];
    return this.events.filter((event) => event.jobId === jobId);
  }

  async getCode(): Promise<OperatorCodeRecord> {
    return { ...this.code };
  }

  async saveCode(row: OperatorCodeRecord): Promise<void> {
    this.code = { ...row };
  }

  async isKillSwitchOn(): Promise<boolean> {
    return this.killSwitch;
  }

  async isSuppressed(channel: SendChannel, destination: string): Promise<boolean> {
    const normalized = normalizeDestination(channel, destination);
    return this.suppressed.has(`${channel}:${normalized}`) || this.suppressed.has(`all:${normalized}`);
  }
}

export interface CreateSendJobInput {
  caller: SendCaller;
  campaignKey?: string | null;
  storyKey?: string | null;
  fullAuto?: boolean;
  /**
   * Operator-started rehearsal or test send. Honored only for caller
   * `operator-dashboard`. It records both confirmations and waives the
   * volume code for this job alone. The kill switch, lockout, and
   * do-not-contact checks still run. Any other caller is rejected.
   */
  operatorDirect?: boolean;
  createdBy: string;
  recipients: Array<{
    channel: SendChannel;
    destination: string;
    messageText: string;
    payload?: Record<string, unknown>;
  }>;
}

function scrubDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (key === 'code' || key === 'hash' || key === 'codeHash' || key === 'salt' || key === 'password') continue;
    clean[key] = value;
  }
  return clean;
}

export class SendSafeguard {
  constructor(private readonly store: SendSafeguardStore) {}

  private iso(date = this.store.now()): string {
    return date.toISOString();
  }

  private requireOperator(caller: SendCaller): void {
    if (caller !== 'operator-dashboard') {
      throw new SendSafeguardError(
        'This safeguard action is only available from an authenticated operator dashboard session.',
        'operator_session_required',
      );
    }
  }

  private async audit(
    jobId: string | null,
    eventType: SafeguardEventType,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.store.appendEvent({
      id: randomUUID(),
      jobId,
      eventType,
      detail: scrubDetail(detail),
      createdAt: this.iso(),
    });
  }

  private async readCode(): Promise<OperatorCodeRecord> {
    try {
      return await this.store.getCode();
    } catch (error) {
      throw new SendSafeguardError(
        'Safeguard code state is unavailable.',
        'safeguard_error',
        null,
        null,
      );
    }
  }

  private async killSwitchOn(): Promise<boolean> {
    try {
      return await this.store.isKillSwitchOn();
    } catch {
      throw new SendSafeguardError('Kill switch state is unavailable. Sending is blocked.', 'kill_switch');
    }
  }

  async isLocked(): Promise<boolean> {
    const code = await this.readCode();
    return code.locked;
  }

  async list(): Promise<Array<{ job: SendJobRecord; recipients: SendRecipientRecord[] }>> {
    const jobs = await this.store.listJobs();
    const out = [];
    for (const job of jobs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
      out.push({ job, recipients: await this.store.listRecipients(job.id) });
    }
    return out;
  }

  async describe(jobId: string): Promise<{ job: SendJobRecord; recipients: SendRecipientRecord[] }> {
    const job = await this.requireJob(jobId);
    return { job, recipients: await this.store.listRecipients(jobId) };
  }

  async aggregatedCount(job: SendJobRecord): Promise<number> {
    const jobs = await this.store.listJobs();
    const since = this.store.now().getTime() - SEND_CODE_WINDOW_MS;
    const keyKind = job.campaignKey ? 'campaign' : job.storyKey ? 'story' : null;
    let total = 0;
    for (const other of jobs) {
      if (keyKind === 'campaign' && other.campaignKey !== job.campaignKey) continue;
      if (keyKind === 'story' && other.storyKey !== job.storyKey) continue;
      if (!keyKind && other.id !== job.id) continue;
      if (other.id !== job.id && Date.parse(other.createdAt) < since) continue;
      const recipients = await this.store.listRecipients(other.id);
      total += recipients.filter((row) => COUNTED_STATUSES.has(row.status)).length;
    }
    return total;
  }

  async requiresCode(job: SendJobRecord): Promise<boolean> {
    return (await this.aggregatedCount(job)) >= SEND_CODE_THRESHOLD;
  }

  async createJob(input: CreateSendJobInput): Promise<{ job: SendJobRecord; recipients: SendRecipientRecord[] }> {
    if (input.recipients.length === 0) {
      throw new SendSafeguardError('A send job needs at least one recipient.', 'empty_job');
    }
    if (await this.isLocked()) {
      throw new SendSafeguardError('Outbound sending is locked.', 'locked');
    }
    if (await this.killSwitchOn()) {
      await this.audit(null, 'send_attempt', { result: 'blocked', reason: 'kill_switch', phase: 'enqueue' });
      throw new SendSafeguardError('The outbound kill switch is on. Nothing was queued.', 'kill_switch');
    }
    const direct = input.operatorDirect === true;
    if (direct && input.caller !== 'operator-dashboard') {
      throw new SendSafeguardError(
        'Only an operator-started rehearsal or test send can go out without the confirmations.',
        'operator_session_required',
      );
    }
    const now = this.iso();
    const normalized = input.recipients.map((recipient) => ({
      channel: recipient.channel,
      destination: normalizeDestination(recipient.channel, recipient.destination),
      messageText: recipient.messageText,
      payload: recipient.payload ?? {},
    }));
    const job: SendJobRecord = {
      id: randomUUID(),
      campaignKey: input.campaignKey?.trim() || null,
      storyKey: input.storyKey?.trim() || null,
      fullAuto: direct || (input.caller === 'operator-dashboard' && input.fullAuto === true),
      status: direct ? 'sending' : 'waiting_confirm',
      confirm1At: direct ? now : null,
      confirm2At: direct ? now : null,
      codeVerifiedAt: direct ? now : null,
      contentHash: hashSendContent(normalized),
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveJob(job);
    const recipients: SendRecipientRecord[] = [];
    for (const recipient of normalized) {
      const row: SendRecipientRecord = {
        id: randomUUID(),
        jobId: job.id,
        channel: recipient.channel,
        destination: recipient.destination,
        messageText: recipient.messageText,
        payload: recipient.payload,
        status: 'queued',
        released: false,
        externalId: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.store.saveRecipient(row);
      recipients.push(row);
    }
    await this.audit(job.id, direct ? 'operator_direct' : 'job_created', {
      count: recipients.length,
      channels: [...new Set(recipients.map((row) => row.channel))],
      fullAuto: job.fullAuto,
      operatorDirect: direct,
    });
    emitStatus(job.id, job.status, direct ? 'code entered, sending' : 'waiting for confirm');
    return { job, recipients };
  }

  async revise(
    jobId: string,
    caller: SendCaller,
    recipients: CreateSendJobInput['recipients'],
  ): Promise<SendJobRecord> {
    const job = await this.requireJob(jobId);
    if (job.status === 'stopped' || job.status === 'completed') {
      throw new SendSafeguardError('This send job can no longer be edited.', 'not_editable', jobId);
    }
    const now = this.iso();
    const normalized = recipients.map((recipient) => ({
      channel: recipient.channel,
      destination: normalizeDestination(recipient.channel, recipient.destination),
      messageText: recipient.messageText,
      payload: recipient.payload ?? {},
    }));
    const nextHash = hashSendContent(normalized);
    if (nextHash === job.contentHash) return job;
    const existing = await this.store.listRecipients(jobId);
    for (const row of existing) {
      if (row.status === 'sent' || row.status === 'failed' || row.status === 'cancelled') continue;
      row.status = 'voided';
      row.updatedAt = now;
      await this.store.saveRecipient(row);
    }
    for (const recipient of normalized) {
      await this.store.saveRecipient({
        id: randomUUID(),
        jobId,
        channel: recipient.channel,
        destination: recipient.destination,
        messageText: recipient.messageText,
        payload: recipient.payload,
        status: 'queued',
        released: false,
        externalId: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    job.contentHash = nextHash;
    job.confirm1At = null;
    job.confirm2At = null;
    job.codeVerifiedAt = null;
    job.status = 'waiting_confirm';
    job.updatedAt = now;
    await this.store.saveJob(job);
    await this.audit(jobId, 'voided', { reason: 'content_changed', caller });
    emitStatus(jobId, job.status, 'waiting for confirm');
    return job;
  }

  async setFullAuto(jobId: string, caller: SendCaller, fullAuto: boolean): Promise<SendJobRecord> {
    this.requireOperator(caller);
    const job = await this.requireJob(jobId);
    job.fullAuto = fullAuto;
    job.updatedAt = this.iso();
    if (job.confirm1At && job.confirm2At) await this.advanceAfterClearance(job);
    else await this.store.saveJob(job);
    return job;
  }

  async confirm(jobId: string, caller: SendCaller, step: 1 | 2): Promise<SendJobRecord> {
    this.requireOperator(caller);
    if (await this.isLocked()) {
      throw new SendSafeguardError('Outbound sending is locked.', 'locked', jobId);
    }
    const job = await this.requireJob(jobId);
    if (job.status === 'stopped' || job.status === 'voided') {
      throw new SendSafeguardError('This send job is not waiting for confirmation.', 'not_confirmable', jobId);
    }
    const now = this.iso();
    if (step === 1) {
      if (!job.confirm1At) {
        job.confirm1At = now;
        job.status = 'waiting_second_confirm';
        job.updatedAt = now;
        await this.store.saveJob(job);
        await this.audit(jobId, 'confirm_1', { count: await this.aggregatedCount(job) });
        emitStatus(jobId, job.status, 'waiting for confirm');
      }
      return job;
    }
    if (!job.confirm1At) {
      throw new SendSafeguardError('Confirm the send once before the second confirmation.', 'confirm_order', jobId);
    }
    if (!job.confirm2At) {
      job.confirm2At = now;
      job.updatedAt = now;
      await this.audit(jobId, 'confirm_2', { count: await this.aggregatedCount(job) });
      await this.advanceAfterClearance(job);
    }
    return (await this.store.getJob(jobId)) ?? job;
  }

  private async advanceAfterClearance(job: SendJobRecord): Promise<void> {
    const needsCode = await this.requiresCode(job);
    if (needsCode && !job.codeVerifiedAt) {
      job.status = 'waiting_code';
      job.updatedAt = this.iso();
      await this.store.saveJob(job);
      emitStatus(job.id, job.status, 'waiting for code');
      return;
    }
    job.status = job.fullAuto ? 'sending' : 'waiting_release';
    job.updatedAt = this.iso();
    await this.store.saveJob(job);
    const label = labelForStatus(job.status);
    if (label) emitStatus(job.id, job.status, label);
  }

  async submitCode(jobId: string, caller: SendCaller, code: string): Promise<SendJobRecord> {
    if (caller !== 'operator-dashboard') {
      await this.audit(jobId, 'code_rejected_source', { caller });
      throw new SendSafeguardError(
        'The safeguard code can only be entered from the operator dashboard.',
        'code_source_rejected',
        jobId,
      );
    }
    const state = await this.readCode();
    if (state.locked) {
      throw new SendSafeguardError('Outbound sending is locked.', 'locked', jobId);
    }
    if (!/^\d{4}$/.test(code)) {
      throw new SendSafeguardError('Enter the four-digit operator code.', 'invalid_code_format', jobId);
    }
    if (!state.codeHash || !state.salt) {
      throw new SendSafeguardError('No operator send code is configured.', 'code_not_configured', jobId);
    }
    const matches = await operatorSendCodeMatches(code, state.codeHash, state.salt);
    if (!matches) {
      state.failedAttempts += 1;
      if (state.failedAttempts >= SEND_CODE_MAX_FAILURES) {
        state.locked = true;
        state.lockedAt = this.iso();
        await this.store.saveCode(state);
        await this.audit(jobId, 'code_failed', { attempts: state.failedAttempts });
        await this.audit(null, 'locked', { attempts: state.failedAttempts });
        emitStatus(null, 'locked', 'locked');
        throw new SendSafeguardError('Outbound sending is locked after repeated incorrect codes.', 'locked', jobId);
      }
      await this.store.saveCode(state);
      await this.audit(jobId, 'code_failed', { attempts: state.failedAttempts });
      throw new SendSafeguardError('The safeguard code was not accepted.', 'code_failed', jobId);
    }
    state.failedAttempts = 0;
    await this.store.saveCode(state);
    const job = await this.requireJob(jobId);
    if (!job.confirm1At || !job.confirm2At) {
      throw new SendSafeguardError('Both confirmations are required before the code.', 'awaiting_confirm', jobId);
    }
    job.codeVerifiedAt = this.iso();
    job.updatedAt = job.codeVerifiedAt;
    await this.audit(jobId, 'code_ok', { jobOnly: true });
    await this.advanceAfterClearance(job);
    return (await this.store.getJob(jobId)) ?? job;
  }

  async setCode(caller: SendCaller, code: string, passwordOk: boolean): Promise<void> {
    this.requireOperator(caller);
    if (!passwordOk) {
      throw new SendSafeguardError('Re-enter the operator password to set the send code.', 'password_required');
    }
    if (!/^\d{4}$/.test(code)) {
      throw new SendSafeguardError('The send code must be four digits.', 'invalid_code_format');
    }
    const hashed = await hashOperatorSendCode(code);
    const current = await this.readCode();
    await this.store.saveCode({
      codeHash: hashed.hash,
      salt: hashed.salt,
      failedAttempts: current.failedAttempts,
      locked: current.locked,
      lockedAt: current.lockedAt,
    });
    await this.audit(null, 'code_set', { changed: true });
  }

  async unlock(caller: SendCaller, passwordOk: boolean): Promise<void> {
    this.requireOperator(caller);
    if (!passwordOk) {
      throw new SendSafeguardError('Re-enter the operator password to unlock sending.', 'password_required');
    }
    await this.store.saveCode({
      ...(await this.readCode()),
      failedAttempts: 0,
      locked: false,
      lockedAt: null,
    });
    await this.audit(null, 'unlocked', {});
  }

  async release(jobId: string, caller: SendCaller, recipientId: string): Promise<SendRecipientRecord> {
    this.requireOperator(caller);
    if (await this.isLocked()) throw new SendSafeguardError('Outbound sending is locked.', 'locked', jobId);
    const job = await this.requireJob(jobId);
    if (job.fullAuto) {
      throw new SendSafeguardError('This job is full auto. Individual release is not required.', 'full_auto', jobId);
    }
    if (!job.confirm1At || !job.confirm2At) {
      throw new SendSafeguardError('Both confirmations are required before a recipient can be released.', 'awaiting_confirm', jobId);
    }
    if ((await this.requiresCode(job)) && !job.codeVerifiedAt) {
      throw new SendSafeguardError('The four-digit code is required before this recipient can be released.', 'awaiting_code', jobId);
    }
    const recipient = await this.store.getRecipient(recipientId);
    if (!recipient || recipient.jobId !== jobId) {
      throw new SendSafeguardError('Recipient not found on this send job.', 'recipient_not_found', jobId);
    }
    recipient.released = true;
    recipient.status = 'released';
    recipient.updatedAt = this.iso();
    await this.store.saveRecipient(recipient);
    if (job.status === 'waiting_release') {
      job.status = 'sending';
      job.updatedAt = recipient.updatedAt;
      await this.store.saveJob(job);
      emitStatus(jobId, job.status, 'code entered, sending');
    }
    return recipient;
  }

  async stop(jobId: string, caller: SendCaller): Promise<SendJobRecord> {
    this.requireOperator(caller);
    return this.stopInternal(jobId, 'operator_stop');
  }

  async stopCampaign(campaignKey: string): Promise<number> {
    const jobs = await this.store.listJobs();
    let stopped = 0;
    for (const job of jobs) {
      if (job.campaignKey !== campaignKey) continue;
      if (job.status === 'stopped' || job.status === 'completed' || job.status === 'voided') continue;
      await this.stopInternal(job.id, 'campaign_cancelled');
      stopped += 1;
    }
    return stopped;
  }

  private async stopInternal(jobId: string, reason: string): Promise<SendJobRecord> {
    const job = await this.requireJob(jobId);
    const now = this.iso();
    const recipients = await this.store.listRecipients(jobId);
    for (const recipient of recipients) {
      if (recipient.status === 'queued' || recipient.status === 'released' || recipient.status === 'blocked') {
        recipient.status = 'cancelled';
        recipient.updatedAt = now;
        await this.store.saveRecipient(recipient);
      }
    }
    job.status = 'stopped';
    job.updatedAt = now;
    await this.store.saveJob(job);
    await this.audit(jobId, 'stop', { reason });
    emitStatus(jobId, job.status, 'stopped');
    return job;
  }

  async assertSendAllowed(jobId: string, recipient: string, channel: SendChannel): Promise<SendRecipientRecord> {
    try {
      return await this.assertInner(jobId, recipient, channel);
    } catch (error) {
      const wrapped = error instanceof SendSafeguardError
        ? error
        : new SendSafeguardError('Send safeguard failed closed.', 'safeguard_error', jobId, channel);
      try {
        await this.audit(wrapped.jobId ?? jobId, 'send_attempt', {
          result: 'blocked',
          reason: wrapped.reason,
          channel,
        });
      } catch (auditError) {
        console.error(
          `[send-safeguard] blocked job=${jobId} channel=${channel} reason=${wrapped.reason} audit=failed`,
        );
        throw new SendSafeguardError('Send safeguard failed closed.', 'safeguard_error', jobId, channel);
      }
      console.error(`[send-safeguard] blocked job=${wrapped.jobId ?? jobId} channel=${channel} reason=${wrapped.reason}`);
      throw wrapped;
    }
  }

  private async assertInner(jobId: string, recipient: string, channel: SendChannel): Promise<SendRecipientRecord> {
    if (await this.isLocked()) {
      throw new SendSafeguardError('Outbound sending is locked.', 'locked', jobId, channel);
    }
    if (await this.killSwitchOn()) {
      throw new SendSafeguardError('The outbound kill switch is on.', 'kill_switch', jobId, channel);
    }
    const job = await this.store.getJob(jobId);
    if (!job) throw new SendSafeguardError('No send job is cleared for this recipient.', 'job_not_found', jobId, channel);
    if (job.status === 'stopped') throw new SendSafeguardError('This send job was stopped.', 'stopped', jobId, channel);
    if (job.status === 'voided') throw new SendSafeguardError('This send job was voided.', 'voided', jobId, channel);
    const destination = normalizeDestination(channel, recipient);
    const recipients = await this.store.listRecipients(jobId);
    const match = recipients.find((row) => row.channel === channel && row.destination === destination && row.status !== 'voided' && row.status !== 'sent' && row.status !== 'failed' && row.status !== 'cancelled');
    if (!match) {
      throw new SendSafeguardError('Recipient is not queued on a cleared send job.', 'recipient_not_found', jobId, channel);
    }
    if (match.status === 'blocked') {
      throw new SendSafeguardError('Recipient is blocked.', 'blocked', jobId, channel);
    }
    if (match.status === 'sending') {
      throw new SendSafeguardError('This recipient is already sending and will not be retried automatically.', 'already_sending', jobId, channel);
    }
    let suppressed = true;
    try {
      suppressed = await this.store.isSuppressed(channel, destination);
    } catch {
      suppressed = true;
    }
    if (suppressed) {
      match.status = 'blocked';
      match.updatedAt = this.iso();
      await this.store.saveRecipient(match);
      throw new SendSafeguardError('Recipient is on a do-not-contact list.', 'suppressed', jobId, channel);
    }
    if (!job.confirm1At || !job.confirm2At) {
      throw new SendSafeguardError('Both operator confirmations are required before sending.', 'awaiting_confirm', jobId, channel);
    }
    if ((await this.requiresCode(job)) && !job.codeVerifiedAt) {
      if (job.status !== 'waiting_code') {
        job.status = 'waiting_code';
        job.updatedAt = this.iso();
        await this.store.saveJob(job);
        emitStatus(jobId, job.status, 'waiting for code');
      }
      throw new SendSafeguardError('This send needs the four-digit operator code.', 'awaiting_code', jobId, channel);
    }
    if (!job.fullAuto && !match.released) {
      throw new SendSafeguardError('The operator has not released this recipient.', 'awaiting_release', jobId, channel);
    }
    match.status = 'sending';
    match.updatedAt = this.iso();
    await this.store.saveRecipient(match);
    if (job.status !== 'sending') {
      job.status = 'sending';
      job.updatedAt = match.updatedAt;
      await this.store.saveJob(job);
      emitStatus(jobId, job.status, 'code entered, sending');
    }
    return match;
  }

  async recordSendResult(
    jobId: string,
    recipientId: string,
    result: 'sent' | 'failed',
    externalId?: string | null,
  ): Promise<void> {
    const recipient = await this.store.getRecipient(recipientId);
    if (!recipient || recipient.jobId !== jobId) return;
    recipient.status = result;
    recipient.externalId = externalId ?? recipient.externalId;
    recipient.updatedAt = this.iso();
    await this.store.saveRecipient(recipient);
    await this.audit(jobId, 'send_attempt', {
      result,
      channel: recipient.channel,
      recipientId,
    });
    const rows = await this.store.listRecipients(jobId);
    const open = rows.some((row) => row.status === 'queued' || row.status === 'released' || row.status === 'sending');
    if (!open) {
      const job = await this.store.getJob(jobId);
      if (job && job.status === 'sending') {
        job.status = 'completed';
        job.updatedAt = this.iso();
        await this.store.saveJob(job);
      }
    }
  }

  private async requireJob(jobId: string): Promise<SendJobRecord> {
    const job = await this.store.getJob(jobId);
    if (!job) throw new SendSafeguardError('Send job not found.', 'job_not_found', jobId);
    return job;
  }
}

let testOverride: SendSafeguard | null | undefined;
let persistent: Promise<SendSafeguard> | null = null;

export function installSendSafeguardForTests(engine: SendSafeguard | null): void {
  testOverride = engine;
  persistent = null;
}

export async function getSendSafeguard(): Promise<SendSafeguard> {
  if (testOverride) return testOverride;
  if (testOverride === null) {
    throw new SendSafeguardError('Send safeguard is unavailable.', 'safeguard_error');
  }
  if (!persistent) {
    persistent = import('./send-safeguard-store.js')
      .then((mod) => mod.createPersistentSendSafeguard())
      .catch(() => {
        persistent = null;
        throw new SendSafeguardError(
          'Send safeguard store is unavailable.',
          'safeguard_error',
          null,
          null,
        );
      });
  }
  return persistent;
}

export async function assertSendAllowed(
  jobId: string,
  recipient: string,
  channel: SendChannel,
): Promise<SendRecipientRecord> {
  const engine = await getSendSafeguard();
  return engine.assertSendAllowed(jobId, recipient, channel);
}

export async function openOutboundSendJob(
  input: CreateSendJobInput,
): Promise<{ jobId: string; recipientIds: string[] }> {
  const engine = await getSendSafeguard();
  const created = await engine.createJob(input);
  return { jobId: created.job.id, recipientIds: created.recipients.map((row) => row.id) };
}

export async function recordOutboundSendResult(
  jobId: string,
  recipientId: string,
  result: 'sent' | 'failed',
  externalId?: string | null,
): Promise<void> {
  const engine = await getSendSafeguard();
  await engine.recordSendResult(jobId, recipientId, result, externalId);
}

export async function cascadeCampaignCancellation(campaignKey: string): Promise<number> {
  const engine = await getSendSafeguard();
  return engine.stopCampaign(campaignKey);
}
