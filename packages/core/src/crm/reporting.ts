/**
 * CRM reporting. This is the analytics half of the CRM that did not exist: the
 * contact book, the pipeline and the email automation were all readable one
 * record at a time, but there was no way to ask "how is the quarter going?".
 *
 * Everything here is derived from tables that already exist — contacts,
 * sales_opportunities, pipeline_stages, crm_tasks, contact_timeline,
 * email_sends and call_outcomes. Nothing is written, so the whole module is
 * safe to expose on a read-only route and safe for an agent to call.
 *
 * The aggregation is split from the querying on purpose: `build*` functions
 * take plain rows and return the report, so a guard can prove the arithmetic
 * without a database, and the `*Report` functions only fetch the rows.
 */
import { and, asc, eq, gte, lte, lt, sql } from 'drizzle-orm';
import {
  callOutcomes,
  contactTimeline,
  contacts,
  crmTasks,
  db,
  emailSends,
  pipelineStages,
  salesOpportunities,
} from '@workspace/db';
import { CRM_ORGANIZATION_ID } from './pure.js';

// ─── Range ──────────────────────────────────────────────────────────────────
// A report is always over a window. `from`/`to` are ISO strings (or null for an
// open end); the window is inclusive of both bounds. A missing window is "all
// time", which is what the dashboard shows before anyone picks a date.

export interface ReportingRange {
  from?: string | null;
  to?: string | null;
}

export interface ResolvedRange {
  from: Date | null;
  to: Date | null;
}

export function resolveRange(range: ReportingRange = {}): ResolvedRange {
  const parse = (value: string | null | undefined): Date | null => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  return { from: parse(range.from), to: parse(range.to) };
}

/** `YYYY-MM` for a date, in UTC. The unit every trend line is bucketed by. */
export function monthKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  return `${year}-${month}`;
}

function daysBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return round(numerator / denominator);
}

// ─── Facts ──────────────────────────────────────────────────────────────────
// The plain shapes the builders consume. The DB readers map drizzle rows into
// these, so the builders never depend on a driver type.

export interface DealFact {
  id: string;
  status: string;
  amountUsd: number;
  probability: number | null;
  source: string | null;
  stageId: string | null;
  stageName: string | null;
  stagePosition: number | null;
  expectedCloseAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  wonReason: string | null;
  lostReason: string | null;
}

export interface StageFact {
  id: string;
  name: string;
  position: number;
}

export function isOpenDeal(status: string): boolean {
  return status !== 'won' && status !== 'lost';
}

/** The value a deal contributes to a weighted forecast. An unset probability is
 *  treated as certain, matching the pipeline board's header figure. */
export function weightedValue(deal: DealFact): number {
  return deal.amountUsd * (deal.probability === null ? 1 : deal.probability);
}

// ─── Pipeline funnel ────────────────────────────────────────────────────────

export interface FunnelStage {
  stageId: string | null;
  name: string;
  position: number;
  dealCount: number;
  totalUsd: number;
  weightedUsd: number;
  /** Deals that reached at least this stage, i.e. this stage or any later one. */
  reachedCount: number;
  /** Reached-here ÷ reached-previous, as a fraction. Null for the first stage. */
  conversionFromPrevious: number | null;
}

export interface PipelineFunnelReport {
  stages: FunnelStage[];
  unassigned: { dealCount: number; totalUsd: number };
  totals: { openCount: number; openUsd: number; weightedUsd: number };
  asOf: string;
}

/**
 * The funnel counts every deal that ever reached a stage — a won deal passed
 * through "Qualified" even though it no longer sits there. Stage-to-stage
 * conversion is therefore monotonic and never exceeds 100%.
 */
export function buildPipelineFunnel(stages: StageFact[], deals: DealFact[], asOf: Date = new Date()): PipelineFunnelReport {
  const ordered = [...stages].sort((a, b) => a.position - b.position);
  const open = deals.filter((deal) => isOpenDeal(deal.status));

  const reachedByStage = new Map<string, number>();
  for (const deal of deals) {
    if (!deal.stageId) continue;
    const position = deal.stagePosition ?? ordered.find((stage) => stage.id === deal.stageId)?.position ?? 0;
    for (const stage of ordered) {
      if (stage.position <= position) reachedByStage.set(stage.id, (reachedByStage.get(stage.id) ?? 0) + 1);
    }
  }

  let previousReached: number | null = null;
  const funnelStages: FunnelStage[] = ordered.map((stage) => {
    const openHere = open.filter((deal) => deal.stageId === stage.id);
    const reached = reachedByStage.get(stage.id) ?? 0;
    const conversion = previousReached === null ? null : rate(reached, previousReached);
    previousReached = reached;
    return {
      stageId: stage.id,
      name: stage.name,
      position: stage.position,
      dealCount: openHere.length,
      totalUsd: openHere.reduce((sum, deal) => sum + deal.amountUsd, 0),
      weightedUsd: openHere.reduce((sum, deal) => sum + weightedValue(deal), 0),
      reachedCount: reached,
      conversionFromPrevious: conversion,
    };
  });

  const unassigned = open.filter((deal) => !deal.stageId);
  return {
    stages: funnelStages,
    unassigned: {
      dealCount: unassigned.length,
      totalUsd: unassigned.reduce((sum, deal) => sum + deal.amountUsd, 0),
    },
    totals: {
      openCount: open.length,
      openUsd: open.reduce((sum, deal) => sum + deal.amountUsd, 0),
      weightedUsd: open.reduce((sum, deal) => sum + weightedValue(deal), 0),
    },
    asOf: asOf.toISOString(),
  };
}

// ─── Win / loss ─────────────────────────────────────────────────────────────

export interface WinLossReport {
  won: number;
  lost: number;
  open: number;
  wonUsd: number;
  lostUsd: number;
  winRate: number | null;
  avgWonUsd: number;
  avgLostUsd: number;
  avgSalesCycleDays: number | null;
  wonReasons: Array<{ reason: string; count: number }>;
  lostReasons: Array<{ reason: string; count: number }>;
}

function reasonTally(deals: DealFact[], pick: (deal: DealFact) => string | null): Array<{ reason: string; count: number }> {
  const tally = new Map<string, number>();
  for (const deal of deals) {
    const reason = (pick(deal) ?? '').trim();
    if (!reason) continue;
    tally.set(reason, (tally.get(reason) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export function buildWinLoss(deals: DealFact[]): WinLossReport {
  const won = deals.filter((deal) => deal.status === 'won');
  const lost = deals.filter((deal) => deal.status === 'lost');
  const open = deals.filter((deal) => isOpenDeal(deal.status));
  const cycles = won
    .filter((deal) => deal.closedAt)
    .map((deal) => daysBetween(deal.createdAt, deal.closedAt as Date));
  return {
    won: won.length,
    lost: lost.length,
    open: open.length,
    wonUsd: won.reduce((sum, deal) => sum + deal.amountUsd, 0),
    lostUsd: lost.reduce((sum, deal) => sum + deal.amountUsd, 0),
    winRate: rate(won.length, won.length + lost.length),
    avgWonUsd: won.length > 0 ? round(won.reduce((sum, deal) => sum + deal.amountUsd, 0) / won.length, 2) : 0,
    avgLostUsd: lost.length > 0 ? round(lost.reduce((sum, deal) => sum + deal.amountUsd, 0) / lost.length, 2) : 0,
    avgSalesCycleDays: cycles.length > 0 ? round(cycles.reduce((sum, value) => sum + value, 0) / cycles.length, 1) : null,
    wonReasons: reasonTally(won, (deal) => deal.wonReason),
    lostReasons: reasonTally(lost, (deal) => deal.lostReason),
  };
}

// ─── Revenue forecast ───────────────────────────────────────────────────────

export interface ForecastMonth {
  month: string;
  dealCount: number;
  totalUsd: number;
  weightedUsd: number;
}

export interface RevenueForecastReport {
  openUsd: number;
  weightedUsd: number;
  /** Open value on deals the operator has marked as at least 70% likely. */
  committedUsd: number;
  /** Open value on deals at least 40% likely, a softer bar than committed. */
  likelyUsd: number;
  wonToDateUsd: number;
  byMonth: ForecastMonth[];
  asOf: string;
}

/**
 * A three-tier forecast, which is what a sales lead actually reports: the
 * number they will defend (committed), the number they believe (likely), and
 * the whole open pipeline (best case). Deals with no expected close date are
 * grouped under "unscheduled" so they are never silently dropped.
 */
export function buildRevenueForecast(deals: DealFact[], asOf: Date = new Date()): RevenueForecastReport {
  const open = deals.filter((deal) => isOpenDeal(deal.status));
  const buckets = new Map<string, ForecastMonth>();
  for (const deal of open) {
    const key = deal.expectedCloseAt ? monthKey(deal.expectedCloseAt) : 'unscheduled';
    const bucket = buckets.get(key) ?? { month: key, dealCount: 0, totalUsd: 0, weightedUsd: 0 };
    bucket.dealCount += 1;
    bucket.totalUsd += deal.amountUsd;
    bucket.weightedUsd += weightedValue(deal);
    buckets.set(key, bucket);
  }
  const byMonth = [...buckets.values()].sort((a, b) => {
    if (a.month === 'unscheduled') return 1;
    if (b.month === 'unscheduled') return -1;
    return a.month.localeCompare(b.month);
  });
  const probabilityAtLeast = (floor: number) =>
    open
      .filter((deal) => deal.probability !== null && deal.probability >= floor)
      .reduce((sum, deal) => sum + deal.amountUsd, 0);
  return {
    openUsd: open.reduce((sum, deal) => sum + deal.amountUsd, 0),
    weightedUsd: open.reduce((sum, deal) => sum + weightedValue(deal), 0),
    committedUsd: probabilityAtLeast(0.7),
    likelyUsd: probabilityAtLeast(0.4),
    wonToDateUsd: deals.filter((deal) => deal.status === 'won').reduce((sum, deal) => sum + deal.amountUsd, 0),
    byMonth,
    asOf: asOf.toISOString(),
  };
}

// ─── Source attribution ─────────────────────────────────────────────────────

export interface SourceRow {
  source: string;
  dealCount: number;
  totalUsd: number;
  wonCount: number;
  wonUsd: number;
  winRate: number | null;
}

export function buildSourceAttribution(deals: DealFact[]): SourceRow[] {
  const buckets = new Map<string, DealFact[]>();
  for (const deal of deals) {
    const key = (deal.source ?? 'unknown').trim() || 'unknown';
    const list = buckets.get(key) ?? [];
    list.push(deal);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .map(([source, list]) => {
      const won = list.filter((deal) => deal.status === 'won');
      const lost = list.filter((deal) => deal.status === 'lost');
      return {
        source,
        dealCount: list.length,
        totalUsd: list.reduce((sum, deal) => sum + deal.amountUsd, 0),
        wonCount: won.length,
        wonUsd: won.reduce((sum, deal) => sum + deal.amountUsd, 0),
        winRate: rate(won.length, won.length + lost.length),
      };
    })
    .sort((a, b) => b.totalUsd - a.totalUsd || a.source.localeCompare(b.source));
}

// ─── Activity ───────────────────────────────────────────────────────────────

export interface EmailActivity {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  openRate: number | null;
  clickRate: number | null;
  bounceRate: number | null;
}

export interface CallActivity {
  total: number;
  connected: number;
  appointmentsBooked: number;
  byDisposition: Array<{ disposition: string; count: number }>;
}

export interface TaskActivity {
  open: number;
  completed: number;
  cancelled: number;
  overdue: number;
  completionRate: number | null;
}

export interface TimelineActivity {
  total: number;
  outbound: number;
  inbound: number;
  internal: number;
}

export interface ActivityReport {
  emails: EmailActivity;
  calls: CallActivity;
  tasks: TaskActivity;
  timeline: TimelineActivity;
}

export interface ActivityFacts {
  emailStatuses: Array<{ status: string; count: number }>;
  callDispositions: Array<{ disposition: string; count: number }>;
  taskStatuses: Array<{ status: string; count: number }>;
  overdueTasks: number;
  timelineDirections: Array<{ direction: string; count: number }>;
}

const CONNECTED_DISPOSITIONS = new Set(['appointment_booked', 'callback_requested', 'not_interested', 'no_decision']);

/**
 * Engagement rates. `sent` is every accepted send; open/click/bounce are read
 * from the furthest status a row reached, so an opened-then-clicked email
 * counts once in each column rather than double-counting.
 */
export function buildActivity(facts: ActivityFacts): ActivityReport {
  const status = (name: string) => facts.emailStatuses.find((row) => row.status === name)?.count ?? 0;
  const delivered = status('delivered') + status('opened') + status('clicked');
  const opened = status('opened') + status('clicked');
  const clicked = status('clicked');
  const bounced = status('bounced');
  const complained = status('complained');
  const sent = delivered + bounced + complained + status('sent');

  const dispositions = [...facts.callDispositions].sort((a, b) => b.count - a.count || a.disposition.localeCompare(b.disposition));
  const callsTotal = dispositions.reduce((sum, row) => sum + row.count, 0);
  const connected = dispositions.filter((row) => CONNECTED_DISPOSITIONS.has(row.disposition)).reduce((sum, row) => sum + row.count, 0);

  const taskStatus = (name: string) => facts.taskStatuses.find((row) => row.status === name)?.count ?? 0;
  const completed = taskStatus('done');
  const cancelled = taskStatus('cancelled');
  const openTasks = taskStatus('open');

  const direction = (name: string) => facts.timelineDirections.find((row) => row.direction === name)?.count ?? 0;
  const outbound = direction('outbound');
  const inbound = direction('inbound');
  const internal = direction('internal');

  return {
    emails: {
      sent,
      delivered,
      opened,
      clicked,
      bounced,
      complained,
      openRate: rate(opened, delivered),
      clickRate: rate(clicked, delivered),
      bounceRate: rate(bounced, sent),
    },
    calls: {
      total: callsTotal,
      connected,
      appointmentsBooked: status0(facts.callDispositions, 'appointment_booked'),
      byDisposition: dispositions,
    },
    tasks: {
      open: openTasks,
      completed,
      cancelled,
      overdue: facts.overdueTasks,
      completionRate: rate(completed, completed + openTasks),
    },
    timeline: {
      total: outbound + inbound + internal,
      outbound,
      inbound,
      internal,
    },
  };
}

function status0(rows: Array<{ disposition: string; count: number }>, name: string): number {
  return rows.find((row) => row.disposition === name)?.count ?? 0;
}

// ─── Contact growth ─────────────────────────────────────────────────────────

export interface ContactGrowthReport {
  total: number;
  newInRange: number;
  doNotContact: number;
  byLifecycle: Array<{ stage: string; count: number }>;
  byStatus: Array<{ status: string; count: number }>;
  byMonth: Array<{ month: string; count: number }>;
}

export interface ContactGrowthFacts {
  total: number;
  newInRange: number;
  doNotContact: number;
  byLifecycle: Array<{ stage: string; count: number }>;
  byStatus: Array<{ status: string; count: number }>;
  byMonth: Array<{ month: string; count: number }>;
}

/** Sorts the lifecycle buckets into the canonical prospect→churned order. */
const LIFECYCLE_ORDER = ['prospect', 'lead', 'qualified', 'client', 'churned'];

export function buildContactGrowth(facts: ContactGrowthFacts): ContactGrowthReport {
  const byLifecycle = [...facts.byLifecycle].sort((a, b) => {
    const ai = LIFECYCLE_ORDER.indexOf(a.stage);
    const bi = LIFECYCLE_ORDER.indexOf(b.stage);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.stage.localeCompare(b.stage);
  });
  const byStatus = [...facts.byStatus].sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
  const byMonth = [...facts.byMonth].sort((a, b) => a.month.localeCompare(b.month));
  return { ...facts, byLifecycle, byStatus, byMonth };
}

// ─── Combined overview ──────────────────────────────────────────────────────

export interface ReportingOverview {
  range: { from: string | null; to: string | null };
  funnel: PipelineFunnelReport;
  winLoss: WinLossReport;
  forecast: RevenueForecastReport;
  sources: SourceRow[];
  activity: ActivityReport;
  contacts: ContactGrowthReport;
  asOf: string;
}

// ─── Database readers ───────────────────────────────────────────────────────

function amountToNumber(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadDeals(range: ResolvedRange): Promise<DealFact[]> {
  const clauses = [eq(salesOpportunities.organizationId, CRM_ORGANIZATION_ID)];
  if (range.from) clauses.push(gte(salesOpportunities.createdAt, range.from));
  if (range.to) clauses.push(lte(salesOpportunities.createdAt, range.to));
  const rows = await db
    .select({
      id: salesOpportunities.id,
      status: salesOpportunities.status,
      amountCents: salesOpportunities.amountCents,
      probability: salesOpportunities.probability,
      source: salesOpportunities.source,
      stageId: salesOpportunities.stageId,
      stageName: pipelineStages.name,
      stagePosition: pipelineStages.position,
      expectedCloseAt: salesOpportunities.expectedCloseAt,
      closedAt: salesOpportunities.closedAt,
      createdAt: salesOpportunities.createdAt,
      wonReason: salesOpportunities.wonReason,
      lostReason: salesOpportunities.lostReason,
    })
    .from(salesOpportunities)
    .leftJoin(pipelineStages, eq(pipelineStages.id, salesOpportunities.stageId))
    .where(and(...clauses))
    .orderBy(asc(salesOpportunities.createdAt))
    .limit(5000);
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    amountUsd: amountToNumber(row.amountCents),
    probability: row.probability,
    source: row.source,
    stageId: row.stageId,
    stageName: row.stageName,
    stagePosition: row.stagePosition,
    expectedCloseAt: row.expectedCloseAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    wonReason: row.wonReason,
    lostReason: row.lostReason,
  }));
}

async function loadStages(): Promise<StageFact[]> {
  const rows = await db
    .select({ id: pipelineStages.id, name: pipelineStages.name, position: pipelineStages.position })
    .from(pipelineStages)
    .where(eq(pipelineStages.organizationId, CRM_ORGANIZATION_ID))
    .orderBy(asc(pipelineStages.position));
  return rows;
}

export async function pipelineFunnelReport(range: ReportingRange = {}): Promise<PipelineFunnelReport> {
  const resolved = resolveRange(range);
  const [stages, deals] = await Promise.all([loadStages(), loadDeals(resolved)]);
  return buildPipelineFunnel(stages, deals);
}

export async function winLossReport(range: ReportingRange = {}): Promise<WinLossReport> {
  return buildWinLoss(await loadDeals(resolveRange(range)));
}

export async function revenueForecastReport(range: ReportingRange = {}): Promise<RevenueForecastReport> {
  return buildRevenueForecast(await loadDeals(resolveRange(range)));
}

export async function sourceAttributionReport(range: ReportingRange = {}): Promise<SourceRow[]> {
  return buildSourceAttribution(await loadDeals(resolveRange(range)));
}

async function loadActivityFacts(range: ResolvedRange): Promise<ActivityFacts> {
  // email_sends and call_outcomes are single-tenant (no organization_id);
  // crm_tasks and contact_timeline are scoped to the CRM organization.
  const emailClauses = [];
  if (range.from) emailClauses.push(gte(emailSends.createdAt, range.from));
  if (range.to) emailClauses.push(lte(emailSends.createdAt, range.to));
  const callClauses = [];
  if (range.from) callClauses.push(gte(callOutcomes.createdAt, range.from));
  if (range.to) callClauses.push(lte(callOutcomes.createdAt, range.to));
  const timelineClauses = [eq(contactTimeline.organizationId, CRM_ORGANIZATION_ID)];
  if (range.from) timelineClauses.push(gte(contactTimeline.occurredAt, range.from));
  if (range.to) timelineClauses.push(lte(contactTimeline.occurredAt, range.to));

  const [emailRows, callRows, taskRows, overdueRows, timelineRows] = await Promise.all([
    db
      .select({ status: emailSends.status, count: sql<number>`count(*)::int` })
      .from(emailSends)
      .where(emailClauses.length > 0 ? and(...emailClauses) : undefined)
      .groupBy(emailSends.status),
    db
      .select({ disposition: callOutcomes.disposition, count: sql<number>`count(*)::int` })
      .from(callOutcomes)
      .where(callClauses.length > 0 ? and(...callClauses) : undefined)
      .groupBy(callOutcomes.disposition),
    db
      .select({ status: crmTasks.status, count: sql<number>`count(*)::int` })
      .from(crmTasks)
      .where(eq(crmTasks.organizationId, CRM_ORGANIZATION_ID))
      .groupBy(crmTasks.status),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(crmTasks)
      .where(and(eq(crmTasks.organizationId, CRM_ORGANIZATION_ID), eq(crmTasks.status, 'open'), lt(crmTasks.dueAt, new Date()))),
    db
      .select({ direction: contactTimeline.direction, count: sql<number>`count(*)::int` })
      .from(contactTimeline)
      .where(and(...timelineClauses))
      .groupBy(contactTimeline.direction),
  ]);
  return {
    emailStatuses: emailRows.map((row) => ({ status: row.status, count: Number(row.count) })),
    callDispositions: callRows.map((row) => ({ disposition: row.disposition, count: Number(row.count) })),
    taskStatuses: taskRows.map((row) => ({ status: row.status, count: Number(row.count) })),
    overdueTasks: Number(overdueRows[0]?.count ?? 0),
    timelineDirections: timelineRows.map((row) => ({ direction: row.direction, count: Number(row.count) })),
  };
}

export async function activityReport(range: ReportingRange = {}): Promise<ActivityReport> {
  return buildActivity(await loadActivityFacts(resolveRange(range)));
}

async function loadContactGrowthFacts(range: ResolvedRange): Promise<ContactGrowthFacts> {
  const org = eq(contacts.organizationId, CRM_ORGANIZATION_ID);
  const [totalRow, dncRow, newRow, lifecycleRows, statusRows, monthRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(contacts).where(org),
    db.select({ count: sql<number>`count(*)::int` }).from(contacts).where(and(org, eq(contacts.doNotContact, true))),
    range.from || range.to
      ? db
          .select({ count: sql<number>`count(*)::int` })
          .from(contacts)
          .where(and(org, range.from ? gte(contacts.createdAt, range.from) : undefined, range.to ? lte(contacts.createdAt, range.to) : undefined))
      : Promise.resolve([{ count: 0 }]),
    db
      .select({ stage: contacts.lifecycleStage, count: sql<number>`count(*)::int` })
      .from(contacts)
      .where(org)
      .groupBy(contacts.lifecycleStage),
    db
      .select({ status: contacts.status, count: sql<number>`count(*)::int` })
      .from(contacts)
      .where(org)
      .groupBy(contacts.status),
    db
      .select({
        month: sql<string>`to_char(date_trunc('month', ${contacts.createdAt}), 'YYYY-MM')`,
        count: sql<number>`count(*)::int`,
      })
      .from(contacts)
      .where(and(org, range.from ? gte(contacts.createdAt, range.from) : undefined, range.to ? lte(contacts.createdAt, range.to) : undefined))
      .groupBy(sql`date_trunc('month', ${contacts.createdAt})`),
  ]);
  return {
    total: Number(totalRow[0]?.count ?? 0),
    newInRange: Number(newRow[0]?.count ?? 0),
    doNotContact: Number(dncRow[0]?.count ?? 0),
    byLifecycle: lifecycleRows.map((row) => ({ stage: row.stage, count: Number(row.count) })),
    byStatus: statusRows.map((row) => ({ status: row.status, count: Number(row.count) })),
    byMonth: monthRows.map((row) => ({ month: row.month, count: Number(row.count) })),
  };
}

export async function contactGrowthReport(range: ReportingRange = {}): Promise<ContactGrowthReport> {
  return buildContactGrowth(await loadContactGrowthFacts(resolveRange(range)));
}

/**
 * Everything the dashboard's reporting page needs, in one round trip. Each
 * section is independent, so a failure in one does not blank the page.
 */
export async function reportingOverview(range: ReportingRange = {}): Promise<ReportingOverview> {
  const resolved = resolveRange(range);
  const [stages, deals, activity, contactsReport] = await Promise.all([
    loadStages(),
    loadDeals(resolved),
    loadActivityFacts(resolved).then(buildActivity),
    loadContactGrowthFacts(resolved).then(buildContactGrowth),
  ]);
  const asOf = new Date();
  return {
    range: { from: resolved.from ? resolved.from.toISOString() : null, to: resolved.to ? resolved.to.toISOString() : null },
    funnel: buildPipelineFunnel(stages, deals, asOf),
    winLoss: buildWinLoss(deals),
    forecast: buildRevenueForecast(deals, asOf),
    sources: buildSourceAttribution(deals),
    activity,
    contacts: contactsReport,
    asOf: asOf.toISOString(),
  };
}
