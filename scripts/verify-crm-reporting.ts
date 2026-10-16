/**
 * CRM reporting guard. Pure only: it proves the aggregation arithmetic on
 * crafted rows and source-checks the wiring (routes, dashboard client, panel,
 * barrel export). It never touches Postgres, so it runs in the fast gate and
 * needs no database.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildActivity,
  buildContactGrowth,
  buildPipelineFunnel,
  buildRevenueForecast,
  buildSourceAttribution,
  buildWinLoss,
  isOpenDeal,
  monthKey,
  resolveRange,
  weightedValue,
  type DealFact,
} from '../packages/core/src/crm/reporting.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.GITHUB_WORKSPACE ?? path.resolve(here, '..');

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

const day = (iso: string): Date => new Date(iso);

function deal(overrides: Partial<DealFact>): DealFact {
  return {
    id: overrides.id ?? 'd',
    status: overrides.status ?? 'open',
    amountUsd: overrides.amountUsd ?? 0,
    probability: overrides.probability ?? null,
    source: overrides.source ?? null,
    stageId: overrides.stageId ?? null,
    stageName: overrides.stageName ?? null,
    stagePosition: overrides.stagePosition ?? null,
    expectedCloseAt: overrides.expectedCloseAt ?? null,
    closedAt: overrides.closedAt ?? null,
    createdAt: overrides.createdAt ?? day('2026-01-01T00:00:00Z'),
    wonReason: overrides.wonReason ?? null,
    lostReason: overrides.lostReason ?? null,
  };
}

function pureChecks(): void {
  const range = resolveRange({ from: '2026-01-01', to: '2026-03-31' });
  assert.ok(range.from instanceof Date && range.to instanceof Date, 'a range parses');
  assert.equal(resolveRange({ from: 'nonsense' }).from, null, 'an unparseable bound is dropped');
  assert.equal(monthKey(day('2026-07-15T00:00:00Z')), '2026-07', 'the month key is YYYY-MM');

  assert.equal(isOpenDeal('open'), true);
  assert.equal(isOpenDeal('won'), false);
  assert.equal(weightedValue(deal({ amountUsd: 1000, probability: 0.5 })), 500);
  assert.equal(weightedValue(deal({ amountUsd: 1000, probability: null })), 1000, 'an unset probability is certain');

  const stages = [
    { id: 's1', name: 'Qualified', position: 1 },
    { id: 's2', name: 'Proposal', position: 2 },
    { id: 's3', name: 'Won', position: 3 },
  ];
  const deals = [
    deal({ id: 'a', status: 'open', amountUsd: 1000, probability: 0.5, stageId: 's2', stagePosition: 2 }),
    deal({ id: 'b', status: 'won', amountUsd: 2000, probability: 1, stageId: 's3', stagePosition: 3, closedAt: day('2026-02-10T00:00:00Z') }),
    deal({ id: 'c', status: 'lost', amountUsd: 500, probability: 0.2, stageId: 's1', stagePosition: 1, closedAt: day('2026-02-20T00:00:00Z') }),
    deal({ id: 'd', status: 'open', amountUsd: 400, probability: null, stageId: null }),
  ];

  const funnel = buildPipelineFunnel(stages, deals, day('2026-03-01T00:00:00Z'));
  assert.equal(funnel.totals.openCount, 2, 'two deals are open');
  assert.equal(funnel.totals.openUsd, 1400, 'open value sums only open deals');
  assert.equal(funnel.totals.weightedUsd, 900, 'weighted value uses probability (500 + 400)');
  assert.equal(funnel.stages[0]?.reachedCount, 3, 'the three staged deals reached the first stage');
  assert.equal(funnel.stages[1]?.reachedCount, 2, 'two staged deals reached proposal or later');
  assert.equal(funnel.stages[1]?.conversionFromPrevious, 0.6667, 'proposal conversion is 2/3');
  assert.equal(funnel.unassigned.dealCount, 1, 'a deal with no stage is counted separately');

  const winLoss = buildWinLoss(deals);
  assert.equal(winLoss.won, 1);
  assert.equal(winLoss.lost, 1);
  assert.equal(winLoss.winRate, 0.5);
  assert.equal(winLoss.wonUsd, 2000);
  assert.equal(winLoss.avgWonUsd, 2000);
  assert.ok(winLoss.avgSalesCycleDays !== null && winLoss.avgSalesCycleDays > 0, 'a sales cycle is measured');

  const forecast = buildRevenueForecast(deals, day('2026-03-01T00:00:00Z'));
  assert.equal(forecast.openUsd, 1400);
  assert.equal(forecast.weightedUsd, 900);
  assert.equal(forecast.committedUsd, 0, 'no open deal is at least 70% likely');
  assert.equal(forecast.likelyUsd, 1000, 'the 50% deal counts as likely (>=40%)');
  assert.equal(forecast.wonToDateUsd, 2000);
  assert.ok(forecast.byMonth.some((month) => month.month === 'unscheduled'), 'a deal with no close date is never dropped');

  const sources = buildSourceAttribution([
    deal({ id: 'x', source: 'webinar', amountUsd: 1000, status: 'won' }),
    deal({ id: 'y', source: 'webinar', amountUsd: 500, status: 'lost' }),
    deal({ id: 'z', source: null, amountUsd: 100, status: 'open' }),
  ]);
  const webinar = sources.find((source) => source.source === 'webinar');
  assert.ok(webinar, 'a source row exists');
  assert.equal(webinar?.dealCount, 2);
  assert.equal(webinar?.wonCount, 1);
  assert.equal(webinar?.winRate, 0.5);
  assert.ok(sources.some((source) => source.source === 'unknown'), 'a deal with no source is labelled, not dropped');

  const activity = buildActivity({
    emailStatuses: [
      { status: 'delivered', count: 10 },
      { status: 'opened', count: 4 },
      { status: 'clicked', count: 1 },
      { status: 'bounced', count: 2 },
    ],
    callDispositions: [
      { disposition: 'appointment_booked', count: 3 },
      { disposition: 'no_answer', count: 7 },
    ],
    taskStatuses: [
      { status: 'open', count: 5 },
      { status: 'done', count: 5 },
    ],
    overdueTasks: 2,
    timelineDirections: [
      { direction: 'outbound', count: 10 },
      { direction: 'inbound', count: 4 },
      { direction: 'internal', count: 1 },
    ],
  });
  assert.equal(activity.emails.delivered, 15, 'delivered includes opened and clicked');
  assert.equal(activity.emails.opened, 5, 'opened includes clicked');
  assert.equal(activity.emails.sent, 17, 'sent = delivered + bounced + complained + sent');
  assert.equal(activity.calls.total, 10);
  assert.equal(activity.calls.connected, 3);
  assert.equal(activity.calls.appointmentsBooked, 3);
  assert.equal(activity.tasks.overdue, 2);
  assert.equal(activity.tasks.completionRate, 0.5);
  assert.equal(activity.timeline.total, 15);

  const growth = buildContactGrowth({
    total: 100,
    newInRange: 12,
    doNotContact: 7,
    byLifecycle: [
      { stage: 'client', count: 10 },
      { stage: 'prospect', count: 40 },
      { stage: 'lead', count: 50 },
    ],
    byStatus: [{ status: 'active', count: 90 }],
    byMonth: [
      { month: '2026-02', count: 5 },
      { month: '2026-01', count: 7 },
    ],
  });
  assert.equal(growth.byLifecycle[0]?.stage, 'prospect', 'lifecycle buckets sort into the canonical order');
  assert.equal(growth.byMonth[0]?.month, '2026-01', 'months sort ascending');
}

function sourceChecks(): void {
  const reporting = read('packages/core/src/crm/reporting.ts');
  assert.equal(/\.insert\(|\.update\(|\.delete\(/.test(reporting), false, 'reporting never writes');
  assert.ok(reporting.includes('reportingOverview'), 'the combined overview exists');

  const index = read('packages/core/src/crm/index.ts');
  assert.ok(index.includes("'./reporting.js'"), 'reporting is exported from the barrel');

  const routes = read('packages/api-server/src/routes/crm.ts');
  for (const route of [
    '/reporting/overview',
    '/reporting/funnel',
    '/reporting/win-loss',
    '/reporting/forecast',
    '/reporting/sources',
    '/reporting/activity',
    '/reporting/contacts',
  ]) {
    assert.ok(routes.includes(`'${route}'`), `the ${route} route exists`);
  }
  // The reporting block is read-only, so it must not gate on the operator
  // session: there is nothing to authorise, and the dashboard should be able to
  // render it for any signed-in operator.
  const reportingAt = routes.indexOf("'/reporting/overview'");
  const integrationsAt = routes.indexOf("'/integrations'");
  assert.ok(reportingAt > 0 && integrationsAt > reportingAt, 'the reporting block precedes the integrations block');
  const reportingBlock = routes.slice(reportingAt, integrationsAt);
  assert.equal(reportingBlock.includes('requireOperatorSession'), false, 'reporting is not operator-gated');
  assert.equal(/\.insert\(|\.update\(|\.delete\(/.test(reportingBlock), false, 'the reporting routes never write');

  const api = read('packages/dashboard/src/lib/api.ts');
  assert.ok(api.includes('reporting:'), 'the dashboard client exposes reporting');
  assert.ok(api.includes('crmRangeQuery'), 'the range query builder exists');

  const panel = read('packages/dashboard/src/components/CrmReportingPanel.tsx');
  assert.ok(panel.includes('api.crm.reporting.overview'), 'the panel calls the overview');
  assert.ok(panel.includes('export function CrmReportingPanel'), 'the panel is exported');

  const app = read('packages/dashboard/src/App.tsx');
  assert.ok(app.includes('CrmReportingPanel'), 'the panel is registered in the app');
  assert.ok(app.includes("id: 'reporting'"), 'the reporting nav item exists');
}

pureChecks();
sourceChecks();
console.log('CRM reporting checks passed');
