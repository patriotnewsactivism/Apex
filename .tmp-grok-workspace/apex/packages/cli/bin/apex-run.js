#!/usr/bin/env node
/**
 * apex-run — the runtime layer on top of apex-install's config (.apex/crons.json,
 * .apex/connectors.json). This does NOT invoke an LLM/agent itself — that's
 * inherently framework-specific per installed project (Convex actions vs
 * Express routes vs whatever). Its job is the generic part: figure out which
 * enabled crons are due right now, gate them on whether their required
 * connectors are actually configured, and (only if --dispatch is passed)
 * POST each due+ready cron to a webhook URL the installed project owns —
 * that webhook is where the project's own agent-invocation code lives.
 *
 * Deliberately zero-dependency and self-contained (no import of @workspace/core
 * or any other monorepo-local package) — this file, like apex-install.js, is
 * meant to be sparse-checked-out and run standalone inside ANY target repo,
 * which never has the Apex monorepo's other workspace packages available.
 *
 * Usage:
 *   node apex-run.js [targetDir] [--at=<ISO datetime>] [--timezone=<IANA tz>]
 *                     [--dispatch --webhook=<url>]
 *
 * Default (no --dispatch): dry-run, just prints what's due+ready as JSON.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const targetDir = args.find((a) => !a.startsWith("--")) || ".";
const atArg = args.find((a) => a.startsWith("--at="))?.split("=")[1];
const at = atArg ? new Date(atArg) : new Date();
const timeZone = (args.find((a) => a.startsWith("--timezone="))?.split("=")[1]) || "UTC";
const dispatch = args.includes("--dispatch");
const webhook = args.find((a) => a.startsWith("--webhook="))?.split("=")[1];

if (Number.isNaN(at.getTime())) {
  console.error(`apex-run: invalid --at= value, could not parse as a date`);
  process.exit(1);
}

const FIELD_RANGES = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];

function parseField(raw, range) {
  const values = new Set();
  for (const part of raw.split(",")) {
    const stepMatch = part.match(/^(\*|\d+-\d+|\d+)\/(\d+)$/);
    let base = part;
    let step = 1;
    if (stepMatch) {
      base = stepMatch[1];
      step = parseInt(stepMatch[2], 10);
      if (step <= 0) throw new Error(`Invalid step 0 in field "${raw}"`);
    }
    let lo, hi;
    if (base === "*") {
      lo = range.min;
      hi = range.max;
    } else if (base.includes("-")) {
      const [a, b] = base.split("-").map((n) => parseInt(n, 10));
      if (Number.isNaN(a) || Number.isNaN(b) || a > b) throw new Error(`Invalid range "${base}" in field "${raw}"`);
      lo = a;
      hi = b;
    } else {
      const n = parseInt(base, 10);
      if (Number.isNaN(n)) throw new Error(`Invalid value "${base}" in field "${raw}"`);
      lo = n;
      hi = n;
    }
    if (lo < range.min || hi > range.max) throw new Error(`Value out of range [${range.min}-${range.max}] in field "${raw}"`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

function parseCronExpression(expr) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Expected 5 fields (minute hour day month weekday), got ${fields.length}: "${expr}"`);
  return fields.map((f, i) => parseField(f, FIELD_RANGES[i]));
}

function cronMatches(expr, atDate, tz) {
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parseCronExpression(expr);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(atDate);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return (
    minutes.has(parseInt(get("minute"), 10)) &&
    hours.has(parseInt(get("hour"), 10)) &&
    daysOfMonth.has(parseInt(get("day"), 10)) &&
    months.has(parseInt(get("month"), 10)) &&
    daysOfWeek.has(weekdayMap[get("weekday")])
  );
}

function readJson(relPath) {
  const p = path.join(targetDir, relPath);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

async function main() {
  const cronsConfig = readJson(".apex/crons.json");
  const connectorsConfig = readJson(".apex/connectors.json") || {};

  if (!cronsConfig) {
    console.error(`apex-run: no .apex/crons.json found in ${path.resolve(targetDir)} — run apex-install first.`);
    process.exit(1);
  }

  const due = [];
  for (const cron of cronsConfig.crons || []) {
    if (!cron.enabled) continue;
    if (!cronMatches(cron.schedule, at, timeZone)) continue;

    const requiredConnectors = cron.requiredConnectors || [];
    const missingConnectors = requiredConnectors.filter((id) => {
      const c = connectorsConfig[id];
      if (!c || !c.enabled) return true;
      return (c.requiredEnvVars || []).some((v) => !process.env[v]);
    });

    due.push(missingConnectors.length > 0
      ? { ...cron, ready: false, blockedBy: missingConnectors }
      : { ...cron, ready: true, blockedBy: [] });
  }

  const readyToDispatch = due.filter((c) => c.ready);
  const blocked = due.filter((c) => !c.ready);

  console.log(
    JSON.stringify(
      { at: at.toISOString(), timeZone, due: due.length, ready: readyToDispatch.length, blocked: blocked.length, crons: due },
      null,
      2,
    ),
  );

  if (!dispatch) {
    if (due.length > 0) console.error(`apex-run: dry-run (pass --dispatch --webhook=<url> to actually POST these).`);
    return;
  }

  if (!webhook) {
    console.error(`apex-run: --dispatch requires --webhook=<url>`);
    process.exit(1);
  }

  for (const cron of readyToDispatch) {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cronId: cron.id, roleId: cron.roleId, description: cron.description, firedAt: at.toISOString() }),
    });
    console.error(`apex-run: dispatched "${cron.id}" to ${webhook} -> HTTP ${res.status}`);
  }
}

main().catch((err) => {
  console.error(`apex-run: fatal error: ${err.message}`);
  process.exit(1);
});
