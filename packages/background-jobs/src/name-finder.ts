/**
 * Name-finder work queue (Matthew, 2026-10-03 3:38 PM CT).
 *
 * Task type `name_finder` runs over the NEEDS-NAME set: verified, reachable
 * leads whose decision-maker ladder ended in cant_locate. Its only job is to
 * find the decision maker's name. Three steps:
 *
 *   1. research  automatic. Re-runs the ladder for every role with a larger
 *                fetch budget (transient/config-skipped steps re-run too).
 *   2. email     a queued, GATED action: a short "who handles X?" email.
 *   3. call      a queued, GATED action: a call asking for the right name.
 *
 * Steps 2 and 3 are never sent automatically:
 *   - each is created as `awaiting_approval` and needs an explicit approval
 *     from a named approver through POST /api/leads/name-finder/actions/:id/approve;
 *   - they are deliberately NOT written to the shared `approvals` table,
 *     because APEX_OPERATOR_AUTO_APPROVE_ALL sweeps that table and would
 *     approve them without Matthew;
 *   - on approval the existing outbound gate (decideSalesOutbound: kill
 *     switch, mode, suppression, caps, send window) is evaluated; a denial
 *     leaves the action `blocked_by_gate` with the reason;
 *   - this branch wires no sender. `executeApprovedAction` exists with
 *     injected senders and re-checks the gate, but nothing calls it yet.
 *
 * When a qualifying, verified name is found (research, an email reply or a
 * call), decisionMakerSearch.outcome becomes `found` with `source` recorded and
 * the lead moves to the contact-ready set immediately, with no review step.
 * Anything below the bar stays in needs-name with the candidate recorded.
 *
 * State lives in researched_leads.enrichment.nameFinder (no new columns).
 */
import { randomUUID } from 'crypto';
import { decideSalesOutbound, type OutboundPolicySnapshot, type SalesOutboundDecision } from '@workspace/core';
import { classifyTitle, loadTitlePolicy, type TitlePolicy } from './lead-quality/title-authority.js';
import { looksLikePersonName, type BelowBarCandidate } from './lead-quality/people.js';
import { industryProfileId } from './lead-quality/industry.js';
import type { DecisionMakerOutcome, DecisionMakerSearch } from './decision-maker-ladder.js';

export const NAME_FINDER_TASK_TYPE = 'name_finder';
export const NAME_FINDER_VERSION = 'name-finder-2026-10-03-v1';

export type NameFinderStep = 'research' | 'email' | 'call';
export type NameFinderActionStatus =
  | 'awaiting_approval'
  | 'rejected'
  | 'blocked_by_gate'
  | 'ready_to_execute'
  | 'executed'
  | 'failed'
  | 'cancelled';
export type NameFinderStatus = 'queued' | 'awaiting_approval' | 'found' | 'exhausted';
export type NameFoundSource = 'name_finder_research' | 'email_reply' | 'phone_call' | 'operator_entry';

export interface GateSnapshot { checkedAt: string; autoApprove: boolean; blocked: boolean; reason: string }

export interface NameFinderAction {
  id: string;
  step: Exclude<NameFinderStep, 'research'>;
  toolName: 'send_email' | 'make_outbound_call';
  status: NameFinderActionStatus;
  createdAt: string;
  updatedAt: string;
  email?: { to: string; subject: string; body: string };
  call?: { to: string; opener: string; ask: string; ifVoicemail: string };
  /** Gate as evaluated when the action was queued (informational) and at approval. */
  gateAtQueue?: GateSnapshot;
  gateAtApproval?: GateSnapshot;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  note?: string;
}

export interface NameFinderResearchRun {
  ranAt: string;
  outcome: DecisionMakerOutcome['status'];
  reason: string;
  candidate?: BelowBarCandidate | null;
}

export interface NameFinderState {
  version: string;
  taskType: typeof NAME_FINDER_TASK_TYPE;
  status: NameFinderStatus;
  createdAt: string;
  updatedAt: string;
  researchRuns: NameFinderResearchRun[];
  nextResearchAt: string | null;
  actions: NameFinderAction[];
  /** Best below-bar person seen so far (never promoted on its own). */
  candidate: BelowBarCandidate | { name: string; title: string; source: NameFoundSource; reasons: string[] } | null;
  found?: { name: string; title: string; source: NameFoundSource; sourceUrl: string; at: string };
}

export interface NameFinderLead {
  id: string;
  companyName: string;
  industry: string | null;
  city: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  enrichment: Record<string, unknown> | null;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export function maxResearchRuns(): number { return envInt('APEX_NAME_FINDER_MAX_RESEARCH_RUNS', 3); }
export function researchIntervalMs(): number { return envInt('APEX_NAME_FINDER_RESEARCH_INTERVAL_HOURS', 72) * 3_600_000; }

export function readNameFinderState(lead: Pick<NameFinderLead, 'enrichment'>): NameFinderState | null {
  const raw = lead.enrichment?.['nameFinder'];
  return raw && typeof raw === 'object' ? (raw as NameFinderState) : null;
}

export function newNameFinderState(now: Date): NameFinderState {
  const iso = now.toISOString();
  return {
    version: NAME_FINDER_VERSION,
    taskType: NAME_FINDER_TASK_TYPE,
    status: 'queued',
    createdAt: iso,
    updatedAt: iso,
    researchRuns: [],
    nextResearchAt: iso,
    actions: [],
    candidate: null,
  };
}

/** Research is due when the queue is open, the run cap is not hit and the backoff elapsed. */
export function isResearchDue(state: NameFinderState | null, now: Date): boolean {
  if (!state) return true;
  if (state.status === 'found') return false;
  if (state.researchRuns.length >= maxResearchRuns()) return false;
  return !state.nextResearchAt || Date.parse(state.nextResearchAt) <= now.getTime();
}

/** What "X" is in "who handles X?" — plain and short, per industry. */
export function whoHandlesTopic(industry: string | null | undefined): string {
  switch (industry ? industryProfileId(industry) : 'generic') {
    case 'news_media': return 'advertising and reader phone lines';
    case 'legal': return 'new-client intake calls';
    case 'dental':
    case 'medspa': return 'new-patient calls and scheduling';
    default: return 'incoming customer calls and the front desk';
  }
}

export function buildEmailAsk(lead: NameFinderLead): NameFinderAction['email'] | undefined {
  if (!lead.contactEmail) return undefined;
  const topic = whoHandlesTopic(lead.industry);
  return {
    to: lead.contactEmail,
    subject: `Quick question for ${lead.companyName}`,
    body: [
      'Hi,',
      '',
      `Who is the right person at ${lead.companyName} to talk to about ${topic}? A name and title is all I need.`,
      '',
      'Thanks,',
    ].join('\n'),
  };
}

export function buildCallAsk(lead: NameFinderLead): NameFinderAction['call'] | undefined {
  if (!lead.contactPhone) return undefined;
  const topic = whoHandlesTopic(lead.industry);
  return {
    to: lead.contactPhone,
    opener: `Hi, quick question — who handles ${topic} at ${lead.companyName}?`,
    ask: 'Could I get their name and title? I will reach out to them directly.',
    ifVoicemail: 'Do not leave a pitch. Hang up and leave the action for a retry.',
  };
}

export function gateSnapshot(decision: SalesOutboundDecision, now: Date): GateSnapshot {
  return { checkedAt: now.toISOString(), autoApprove: decision.autoApprove, blocked: !decision.autoApprove, reason: decision.reason };
}

/** Evaluate APEX's existing outbound gate for one action. Pure: the caller loads the policy. */
export function evaluateGate(
  action: Pick<NameFinderAction, 'toolName' | 'email' | 'call'>,
  lead: Pick<NameFinderLead, 'id'>,
  policy: OutboundPolicySnapshot | null,
  opts: { suppressed?: boolean; now?: Date } = {},
): SalesOutboundDecision {
  return decideSalesOutbound({
    toolName: action.toolName,
    destinationEmail: action.email?.to ?? null,
    destinationPhone: action.call?.to ?? null,
    leadId: lead.id,
    leadExists: true,
    suppressed: opts.suppressed ?? false,
    policy,
    now: opts.now,
  });
}

/**
 * After a research run that found nothing: queue the email and call asks as
 * awaiting_approval (once each). Nothing is sent here.
 */
export function queueGatedActions(state: NameFinderState, lead: NameFinderLead, policy: OutboundPolicySnapshot | null, now: Date): NameFinderState {
  const iso = now.toISOString();
  const has = (step: NameFinderAction['step']) => state.actions.some((a) => a.step === step && a.status !== 'cancelled');
  const actions = [...state.actions];
  const email = buildEmailAsk(lead);
  if (email && !has('email')) {
    const action: NameFinderAction = { id: randomUUID(), step: 'email', toolName: 'send_email', status: 'awaiting_approval', createdAt: iso, updatedAt: iso, email };
    action.gateAtQueue = gateSnapshot(evaluateGate(action, lead, policy, { now }), now);
    actions.push(action);
  }
  const call = buildCallAsk(lead);
  if (call && !has('call')) {
    const action: NameFinderAction = { id: randomUUID(), step: 'call', toolName: 'make_outbound_call', status: 'awaiting_approval', createdAt: iso, updatedAt: iso, call };
    action.gateAtQueue = gateSnapshot(evaluateGate(action, lead, policy, { now }), now);
    actions.push(action);
  }
  const awaiting = actions.some((a) => a.status === 'awaiting_approval' || a.status === 'blocked_by_gate' || a.status === 'ready_to_execute');
  const researchLeft = state.researchRuns.length < maxResearchRuns();
  return { ...state, actions, status: awaiting ? 'awaiting_approval' : researchLeft ? 'queued' : 'exhausted', updatedAt: iso };
}

/** Record one automatic research run. `found` promotion is done by the caller via promoteFoundName. */
export function recordResearchRun(state: NameFinderState, search: DecisionMakerSearch, now: Date): NameFinderState {
  const iso = now.toISOString();
  const outcome = search.outcome;
  const candidate = outcome.status === 'cant_locate' ? outcome.candidate ?? null : null;
  const run: NameFinderResearchRun = { ranAt: iso, outcome: outcome.status, reason: search.reason, candidate };
  return {
    ...state,
    researchRuns: [...state.researchRuns, run].slice(-10),
    nextResearchAt: new Date(now.getTime() + researchIntervalMs()).toISOString(),
    candidate: candidate ?? state.candidate,
    updatedAt: iso,
  };
}

export interface ApprovalResult { state: NameFinderState; action: NameFinderAction | null; error?: string }

/**
 * Explicit approval by a named approver. The outbound gate is evaluated at
 * approval: a denial (kill switch on, mode off, suppressed, caps, window)
 * leaves the action blocked_by_gate. Approval never sends.
 */
export function approveAction(
  state: NameFinderState,
  actionId: string,
  approver: string,
  gate: SalesOutboundDecision,
  now: Date,
): ApprovalResult {
  const who = approver.trim();
  if (!who) return { state, action: null, error: 'approver_required' };
  const idx = state.actions.findIndex((a) => a.id === actionId);
  if (idx < 0) return { state, action: null, error: 'action_not_found' };
  const current = state.actions[idx]!;
  if (current.status !== 'awaiting_approval' && current.status !== 'blocked_by_gate') {
    return { state, action: current, error: `action_not_approvable:${current.status}` };
  }
  const iso = now.toISOString();
  const snapshot = gateSnapshot(gate, now);
  const next: NameFinderAction = {
    ...current,
    approvedBy: who,
    approvedAt: iso,
    gateAtApproval: snapshot,
    status: snapshot.blocked ? 'blocked_by_gate' : 'ready_to_execute',
    updatedAt: iso,
  };
  const actions = [...state.actions];
  actions[idx] = next;
  return { state: { ...state, actions, updatedAt: iso }, action: next };
}

export function rejectAction(state: NameFinderState, actionId: string, reviewer: string, note: string | undefined, now: Date): ApprovalResult {
  const idx = state.actions.findIndex((a) => a.id === actionId);
  if (idx < 0) return { state, action: null, error: 'action_not_found' };
  const iso = now.toISOString();
  const next: NameFinderAction = { ...state.actions[idx]!, status: 'rejected', rejectedBy: reviewer.trim() || 'operator', note, updatedAt: iso };
  const actions = [...state.actions];
  actions[idx] = next;
  return { state: { ...state, actions, updatedAt: iso }, action: next };
}

export interface ActionSenders {
  sendEmail?: (input: { to: string; subject: string; body: string; leadId: string }) => Promise<{ providerId?: string }>;
  placeCall?: (input: { to: string; opener: string; ask: string; leadId: string }) => Promise<{ providerId?: string }>;
}

/**
 * Execute an approved action. Not wired to any sender in this branch. Refuses
 * unless the action is ready_to_execute, APEX_NAME_FINDER_OUTBOUND_ENABLED is
 * "true", and the outbound gate allows it NOW (re-checked; the kill switch
 * may have been turned on since approval).
 */
export async function executeApprovedAction(
  action: NameFinderAction,
  lead: Pick<NameFinderLead, 'id'>,
  gateNow: SalesOutboundDecision,
  senders: ActionSenders,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NameFinderAction> {
  const iso = now.toISOString();
  if (action.status !== 'ready_to_execute' || !action.approvedBy) return { ...action, note: 'not_approved' };
  if (env.APEX_NAME_FINDER_OUTBOUND_ENABLED !== 'true') return { ...action, note: 'outbound_disabled_by_flag', updatedAt: iso };
  if (!gateNow.autoApprove) return { ...action, status: 'blocked_by_gate', gateAtApproval: gateSnapshot(gateNow, now), updatedAt: iso };
  try {
    if (action.step === 'email' && action.email && senders.sendEmail) {
      await senders.sendEmail({ ...action.email, leadId: lead.id });
    } else if (action.step === 'call' && action.call && senders.placeCall) {
      await senders.placeCall({ to: action.call.to, opener: action.call.opener, ask: action.call.ask, leadId: lead.id });
    } else {
      return { ...action, note: 'no_sender_configured', updatedAt: iso };
    }
    return { ...action, status: 'executed', updatedAt: iso };
  } catch (err) {
    return { ...action, status: 'failed', note: err instanceof Error ? err.message.slice(0, 160) : 'send_failed', updatedAt: iso };
  }
}

export interface FoundNameInput {
  name: string;
  title: string;
  source: NameFoundSource;
  /** Evidence: a page URL, or e.g. "email-reply:<messageId>" / "call:<callId>". Required. */
  sourceUrl: string;
}

export interface PromotionResult {
  promoted: boolean;
  reasons: string[];
  enrichment: Record<string, unknown>;
  decisionMakerName: string | null;
  title: string | null;
}

/**
 * Apply a name the queue found. Clears the bar → outcome found with source,
 * the lead moves to contact-ready immediately (no review step) and open
 * actions are cancelled. Below the bar → stays needs-name, candidate recorded.
 */
export function promoteFoundName(
  lead: NameFinderLead,
  input: FoundNameInput,
  now: Date,
  policy: TitlePolicy = loadTitlePolicy(),
): PromotionResult {
  const iso = now.toISOString();
  const enrichment = { ...(lead.enrichment ?? {}) };
  const state = readNameFinderState(lead) ?? newNameFinderState(now);
  const name = input.name.trim().replace(/\s+/g, ' ');
  const title = input.title.trim();
  const reasons: string[] = [];
  if (!looksLikePersonName(name)) reasons.push('name_invalid');
  const cls = classifyTitle(title, policy);
  if (!cls.qualifies) reasons.push(cls.deniedBy ? `title_denied:${cls.deniedBy}` : 'title_not_authority');
  if (!input.sourceUrl?.trim()) reasons.push('source_url_missing');

  if (reasons.length > 0) {
    enrichment['nameFinder'] = { ...state, candidate: { name, title, source: input.source, reasons }, updatedAt: iso } satisfies NameFinderState;
    return { promoted: false, reasons, enrichment, decisionMakerName: null, title: null };
  }

  const search = (enrichment['decisionMakerSearch'] ?? {}) as Partial<DecisionMakerSearch>;
  const previous = search.outcome;
  const method = input.source === 'name_finder_research' ? 'web_search' : input.source;
  enrichment['decisionMakerSearch'] = {
    ...search,
    outcome: {
      status: 'found',
      name,
      title,
      sourceUrl: input.sourceUrl.trim(),
      method,
      confidence: input.source === 'name_finder_research' ? 0.7 : 0.9,
      fromCache: false,
      tier: cls.tier ?? undefined,
      verifiedBy: input.source === 'name_finder_research' ? 'first_party' : 'company_direct',
      source: input.source,
    },
    reason: `found_via_${input.source}`,
    previousOutcome: previous && previous.status !== 'found' ? previous : undefined,
  };
  enrichment['nameFinder'] = {
    ...state,
    status: 'found',
    found: { name, title, source: input.source, sourceUrl: input.sourceUrl.trim(), at: iso },
    actions: state.actions.map((a) => (a.status === 'awaiting_approval' || a.status === 'blocked_by_gate' || a.status === 'ready_to_execute'
      ? { ...a, status: 'cancelled' as const, note: 'name_found', updatedAt: iso }
      : a)),
    updatedAt: iso,
  } satisfies NameFinderState;
  return { promoted: true, reasons: [], enrichment, decisionMakerName: name, title };
}

/** Apply a ladder-research result: found → promote with source research; else record and queue gated asks. */
export function applyResearchResult(
  lead: NameFinderLead,
  search: DecisionMakerSearch,
  policy: OutboundPolicySnapshot | null,
  now: Date,
): PromotionResult {
  const base = readNameFinderState(lead) ?? newNameFinderState(now);
  const recorded = recordResearchRun(base, search, now);
  const outcome = search.outcome;
  if (outcome.status === 'found') {
    const enrichment = { ...(lead.enrichment ?? {}), nameFinder: recorded };
    const result = promoteFoundName({ ...lead, enrichment }, { name: outcome.name, title: outcome.title, source: 'name_finder_research', sourceUrl: outcome.sourceUrl }, now);
    if (result.promoted) {
      // Keep the ladder's own evidence (verifiedBy/corroboration) on the outcome.
      const dms = result.enrichment['decisionMakerSearch'] as Record<string, unknown>;
      dms['outcome'] = { ...outcome, source: 'name_finder_research' };
      dms['ladderVersion'] = search.ladderVersion;
      dms['roles'] = search.roles;
    }
    return result;
  }
  const next = outcome.status === 'cant_locate' ? queueGatedActions(recorded, lead, policy, now) : recorded;
  return {
    promoted: false,
    reasons: [outcome.status === 'pending_retry' ? 'research_pending_retry' : 'research_no_verified_name'],
    enrichment: { ...(lead.enrichment ?? {}), nameFinder: next, decisionMakerSearch: { ...(lead.enrichment?.['decisionMakerSearch'] as object ?? {}), lastNameFinderSearch: { at: now.toISOString(), outcome: outcome.status, reason: search.reason } } },
    decisionMakerName: null,
    title: null,
  };
}
