/**
 * cron-utils.ts — minimal, dependency-free standard 5-field cron parser
 * (minute hour day-of-month month day-of-week), supporting `*`, numeric
 * values, comma lists, ranges (a-b), and step values (star-slash-n or a-b-slash-n).
 *
 * Used by the installable-OS's `.apex/crons.json` layer to (a) actually
 * validate a project's declared cron expressions at install/read time
 * instead of trusting arbitrary strings, and (b) compute real next-run
 * timestamps so an agent (or a human) can sanity-check "when does this
 * actually fire" without needing a live scheduler running.
 */

export interface CronFieldRange {
  min: number;
  max: number;
}

const FIELD_RANGES: CronFieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0 = Sunday)
];

export class CronParseError extends Error {}

function parseField(raw: string, range: CronFieldRange): Set<number> {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const stepMatch = part.match(/^(\*|\d+-\d+|\d+)\/(\d+)$/);
    let base = part;
    let step = 1;
    if (stepMatch) {
      base = stepMatch[1];
      step = parseInt(stepMatch[2], 10);
      if (step <= 0) throw new CronParseError(`Invalid step 0 in field "${raw}"`);
    }

    let lo: number, hi: number;
    if (base === '*') {
      lo = range.min;
      hi = range.max;
    } else if (base.includes('-')) {
      const [a, b] = base.split('-').map((n) => parseInt(n, 10));
      if (Number.isNaN(a) || Number.isNaN(b) || a > b) {
        throw new CronParseError(`Invalid range "${base}" in field "${raw}"`);
      }
      lo = a;
      hi = b;
    } else {
      const n = parseInt(base, 10);
      if (Number.isNaN(n)) throw new CronParseError(`Invalid value "${base}" in field "${raw}"`);
      lo = n;
      hi = n;
    }

    if (lo < range.min || hi > range.max) {
      throw new CronParseError(`Value out of range [${range.min}-${range.max}] in field "${raw}"`);
    }

    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** Validates a standard 5-field cron expression. Throws CronParseError with a clear message if invalid. */
export function parseCronExpression(expr: string): Set<number>[] {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(`Expected 5 fields (minute hour day month weekday), got ${fields.length}: "${expr}"`);
  }
  return fields.map((f, i) => parseField(f, FIELD_RANGES[i]));
}

/** True/false — never throws. Use this for a quick validity check. */
export function isValidCronExpression(expr: string): boolean {
  try {
    parseCronExpression(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Computes the next `count` run timestamps after `from` (default: now),
 * in the given IANA timezone's wall-clock time (default: UTC). Searches
 * minute-by-minute up to 2 years ahead before giving up (guards against
 * an expression that can never match, e.g. Feb 30).
 */
export function getNextRunTimes(expr: string, count = 1, from: Date = new Date(), timeZone = 'UTC'): Date[] {
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parseCronExpression(expr);
  const results: Date[] = [];

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });

  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1); // start searching from the next minute

  const maxIterations = 60 * 24 * 366 * 2; // ~2 years of minutes
  let i = 0;
  while (results.length < count && i < maxIterations) {
    const parts = fmt.formatToParts(cursor);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

    const minute = parseInt(get('minute'), 10);
    const hour = parseInt(get('hour'), 10);
    const day = parseInt(get('day'), 10);
    const month = parseInt(get('month'), 10);
    const weekday = weekdayMap[get('weekday')];

    if (
      minutes.has(minute) &&
      hours.has(hour) &&
      daysOfMonth.has(day) &&
      months.has(month) &&
      daysOfWeek.has(weekday)
    ) {
      results.push(new Date(cursor.getTime()));
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    i++;
  }

  return results;
}
