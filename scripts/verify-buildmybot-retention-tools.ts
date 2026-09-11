import assert from "node:assert/strict";
import { summarizeRetentionRows } from "../packages/core/src/buildmybot-retention-tools.js";

const rows = [
  {
    id: "call-1",
    created_at: "2026-09-10T10:00:00.000Z",
    status: "completed",
    metadata: {
      retentionAudit: [
        {
          offerStage: "light",
          objection: "price",
          listedMonthlyPrice: 499,
          temporaryMonthlyPrice: 424.15,
          temporaryMonths: 2,
          accepted: false,
        },
        {
          offerStage: "moderate",
          objection: "price",
          listedMonthlyPrice: 499,
          temporaryMonthlyPrice: 349.3,
          temporaryMonths: 2,
          accepted: true,
        },
      ],
      interruptions: 3,
      voiceHandoffs: [{ from: "sales", to: "manager" }],
    },
  },
  {
    id: "call-2",
    created_at: "2026-09-10T11:00:00.000Z",
    status: "completed",
    metadata: {
      retentionAudit: [
        {
          offerStage: "light",
          objection: "competitor",
          listedMonthlyPrice: 279,
          temporaryMonthlyPrice: 237.15,
          temporaryMonths: 1,
          accepted: true,
        },
      ],
      ownerEscalationRequested: true,
      ownerEscalationHandoff: {
        reason: "Customer requested owner review",
        stepsAlreadyTaken: "Support issue resolved; value reviewed.",
      },
    },
  },
  {
    id: "call-3",
    created_at: "2026-09-10T12:00:00.000Z",
    status: "completed",
    metadata: { fallbackReason: "Voice engine connection closed" },
  },
];

const summary = summarizeRetentionRows(rows);
assert.equal(summary.sampledCalls, 3);
assert.equal(summary.callsWithRetention, 2);
assert.equal(summary.offersIssued, 3);
assert.equal(summary.accepted, 2);
assert.equal(summary.rejected, 1);
assert.equal(summary.pending, 0);
assert.equal(summary.acceptanceRate, 0.6667);
assert.equal(summary.ownerEscalations, 1);
assert.equal(summary.fallbackCalls, 1);
assert.deepEqual(summary.byStage.light, {
  offers: 2,
  accepted: 1,
  rejected: 1,
  pending: 0,
  acceptanceRate: 0.5,
  averageListedPrice: 389,
  averageTemporaryPrice: 330.65,
  averageTemporaryToListRatio: 0.85,
});
assert.equal(summary.byStage.moderate.acceptanceRate, 1);
assert.equal(summary.byObjection.price.offers, 2);
assert.equal(summary.byObjection.competitor.accepted, 1);

console.log("BuildMyBot retention telemetry aggregation verified.");
