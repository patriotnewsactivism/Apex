import { describe, expect, it } from "vitest";
import {
  planLeadImport,
  mapImportRows,
  recordsFromCsv,
  type ExistingLeadSnapshot,
} from "../../../core/src/lead-import.js";

/**
 * A phone-only book shares domains heavily. Before this, the import planner
 * matched on email/website only and applied its within-batch duplicate guard to
 * EVERY row, so re-importing our own export silently discarded the rows that
 * shared a domain: measured on production 2026-10-12, 9 of 200 rows (4.5%),
 * which across a 149,622-row book is roughly 6,700 leads lost without a count.
 *
 * The fix is an exact key (the Lead ID column the export now emits) plus a
 * duplicate guard that only applies where it was meant to — to rows that CREATE
 * a lead, never to rows that update one.
 */
const existing: ExistingLeadSnapshot[] = Array.from({ length: 7 }, (_, i) => ({
  id: `lead-000${i}`,
  contactEmail: null,
  website: "https://datamaxinc.com/",
  decisionMakerName: null,
  contactPhone: `+1512555000${i}`,
  title: null,
  linkedinUrl: null,
  employeeCount: null,
  outreachAngle: null,
  enrichment: null,
}));

const row = (id: string | null, phone: string) => ({
  leadId: id,
  companyName: "DataMax Inc",
  website: "datamaxinc.com",
  industry: null,
  city: null,
  decisionMakerName: null,
  title: null,
  contactEmail: null,
  contactPhone: phone,
  linkedinUrl: null,
  employeeCount: null,
  outreachAngle: null,
  fitReason: "",
  source: "roundtrip",
  enrichment: { enrichedBy: "outside-tool" },
});

describe("lead import round trip", () => {
  it("reaches every distinct lead when the file carries Lead IDs", () => {
    const plan = planLeadImport({
      leads: existing.map((e) => row(e.id, e.contactPhone!)),
      existing,
      overwrite: false,
    });
    const reached = new Set(
      plan.rows.filter((r) => r.action === "update").map((r) => r.existingId),
    );
    expect(plan.counts.updated).toBe(7);
    expect(plan.counts.skipped).toBe(0);
    expect(reached.size).toBe(7);
  });

  it("reports the loss instead of hiding it when there is no Lead ID", () => {
    const plan = planLeadImport({
      leads: existing.map((e) => row(null, e.contactPhone!)),
      existing,
      overwrite: false,
    });
    const reached = new Set(
      plan.rows.filter((r) => r.action === "update").map((r) => r.existingId),
    );
    // The website heuristic can only reach one lead on a shared domain. That is
    // a known limitation — the point is it is now COUNTED, not silent.
    expect(reached.size).toBe(1);
    expect(plan.counts.skipped).toBe(6);
    expect(plan.rows.some((r) => r.reason === "matches a lead already claimed earlier in this file")).toBe(true);
  });

  it("still de-dupes rows that would create a lead, so a fresh import cannot double-insert", () => {
    const fresh = Array.from({ length: 3 }, () => ({
      leadId: null,
      companyName: "Brand New Co",
      website: "brandnew.example",
      industry: null,
      city: null,
      decisionMakerName: null,
      title: null,
      contactEmail: null,
      contactPhone: "+15125559999",
      linkedinUrl: null,
      employeeCount: null,
      outreachAngle: null,
      fitReason: "",
      source: "fresh",
      enrichment: {},
    }));
    const plan = planLeadImport({ leads: fresh, existing, overwrite: false });
    expect(plan.counts.created).toBe(1);
    expect(plan.counts.skipped).toBe(2);
  });

  it("reads the Lead ID column back out of the exported CSV", () => {
    const csv = [
      "Lead ID,Company Name,Website,Industry,City,Decision Maker,Email,Phone",
      "lead-0000,DataMax Inc,datamaxinc.com,,,,,+15125550000",
      "lead-0001,DataMax Inc,datamaxinc.com,,,,,+15125550001",
    ].join("\r\n");
    const mapped = mapImportRows(recordsFromCsv(csv), "roundtrip");
    expect(mapped.leads).toHaveLength(2);
    expect(mapped.leads.map((l) => l.leadId)).toEqual(["lead-0000", "lead-0001"]);
  });

  it("applies an enriched file end to end onto distinct leads", () => {
    const csv = [
      "Lead ID,Company Name,Website,Industry,City,Decision Maker,Email,Phone",
      "lead-0000,DataMax Inc,datamaxinc.com,,,,,+15125559990",
      "lead-0001,DataMax Inc,datamaxinc.com,,,,,+15125559991",
    ].join("\r\n");
    const mapped = mapImportRows(recordsFromCsv(csv), "roundtrip");
    const plan = planLeadImport({ leads: mapped.leads, existing, overwrite: true });
    const reached = new Set(
      plan.rows.filter((r) => r.action === "update").map((r) => r.existingId),
    );
    expect(plan.counts.updated).toBe(2);
    expect(reached.size).toBe(2);
    expect(plan.rows.some((r) => r.lead.contactPhone === "+15125559990")).toBe(true);
  });

  it("treats a no-change re-import as idempotent, not lossy", () => {
    const csv = [
      "Lead ID,Company Name,Website,Industry,City,Decision Maker,Email,Phone",
      "lead-0000,DataMax Inc,datamaxinc.com,,,,,+15125550000",
      "lead-0001,DataMax Inc,datamaxinc.com,,,,,+15125550001",
    ].join("\r\n");
    const mapped = mapImportRows(recordsFromCsv(csv), "roundtrip");
    const plan = planLeadImport({ leads: mapped.leads, existing, overwrite: false });
    expect(plan.counts.updated).toBe(0);
    expect(plan.counts.skipped).toBe(2);
    expect(plan.rows.every((r) => r.reason !== "duplicate inside the file")).toBe(true);
  });
});
