// ─── CronParser ───────────────────────────────────────────────────────────────
//
// Standard 5-part cron expression parser (minute hour day-of-month month day-of-week).
// Supports: wildcards (*), ranges (1-5), intervals (*/5), lists (1,3,5),
// and combinations (1-5/2). Clear error messages on invalid expressions.
//
// No external dependencies — pure TypeScript implementation.

export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

const FIELD_RANGES: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 6 },
];

/**
 * Parse a single cron field (e.g. "1-5", "*/10", "1,3,5") into an array of
 * matching values within [min, max].
 */
function parseField(field: string, min: number, max: number, fieldName: string): number[] {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const trimmed = part.trim();

    if (trimmed === '*') {
      // Wildcard: every value
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    // Check for interval: */N or M-N/S
    const slashIndex = trimmed.indexOf('/');
    if (slashIndex !== -1) {
      const rangePart = trimmed.slice(0, slashIndex);
      const stepStr = trimmed.slice(slashIndex + 1);
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) {
        throw new Error(`Invalid step '${stepStr}' in ${fieldName} field '${field}'`);
      }

      let rangeMin = min;
      let rangeMax = max;
      if (rangePart !== '*') {
        const dashIndex = rangePart.indexOf('-');
        if (dashIndex !== -1) {
          rangeMin = parseInt(rangePart.slice(0, dashIndex), 10);
          rangeMax = parseInt(rangePart.slice(dashIndex + 1), 10);
        } else {
          rangeMin = parseInt(rangePart, 10);
          rangeMax = max;
        }
      }

      if (isNaN(rangeMin) || isNaN(rangeMax)) {
        throw new Error(`Invalid range in ${fieldName} field '${field}'`);
      }

      for (let i = rangeMin; i <= rangeMax; i += step) values.add(i);
      continue;
    }

    // Check for range: M-N
    const dashIndex = trimmed.indexOf('-');
    if (dashIndex !== -1) {
      const start = parseInt(trimmed.slice(0, dashIndex), 10);
      const end = parseInt(trimmed.slice(dashIndex + 1), 10);
      if (isNaN(start) || isNaN(end)) {
        throw new Error(`Invalid range '${trimmed}' in ${fieldName} field`);
      }
      if (start < min || end > max || start > end) {
        throw new Error(`Range ${start}-${end} out of bounds [${min}-${max}] in ${fieldName} field`);
      }
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }

    // Simple number
    const num = parseInt(trimmed, 10);
    if (isNaN(num)) {
      throw new Error(`Invalid value '${trimmed}' in ${fieldName} field`);
    }
    if (num < min || num > max) {
      throw new Error(`Value ${num} out of bounds [${min}-${max}] in ${fieldName} field`);
    }
    values.add(num);
  }

  return Array.from(values).sort((a, b) => a - b);
}

export class CronParser {
  /**
   * Parse a standard 5-part cron expression into its component fields.
   * @throws Error if the expression is invalid
   */
  static parse(expression: string): CronFields {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(
        `Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}: '${expression}'`,
      );
    }

    return {
      minutes: parseField(parts[0], FIELD_RANGES[0].min, FIELD_RANGES[0].max, FIELD_RANGES[0].name),
      hours: parseField(parts[1], FIELD_RANGES[1].min, FIELD_RANGES[1].max, FIELD_RANGES[1].name),
      daysOfMonth: parseField(parts[2], FIELD_RANGES[2].min, FIELD_RANGES[2].max, FIELD_RANGES[2].name),
      months: parseField(parts[3], FIELD_RANGES[3].min, FIELD_RANGES[3].max, FIELD_RANGES[3].name),
      daysOfWeek: parseField(parts[4], FIELD_RANGES[4].min, FIELD_RANGES[4].max, FIELD_RANGES[4].name),
    };
  }

  /**
   * Validate a cron expression without throwing. Returns null if valid,
   * or an error message string if invalid.
   */
  static validate(expression: string): string | null {
    try {
      CronParser.parse(expression);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Calculate the next run time after `from` for the given cron expression.
   * Searches forward up to 1 year. Returns null if no match found (should
   * be impossible for any valid expression).
   */
  static nextRun(expression: string, from: Date = new Date()): Date | null {
    const fields = CronParser.parse(expression);
    const maxSearchMs = 366 * 24 * 60 * 60 * 1000; // 1 year
    const deadline = from.getTime() + maxSearchMs;

    // Start from the next minute
    const candidate = new Date(from);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    while (candidate.getTime() < deadline) {
      const month = candidate.getMonth() + 1; // 1-based
      const dayOfMonth = candidate.getDate();
      const dayOfWeek = candidate.getDay(); // 0=Sunday
      const hour = candidate.getHours();
      const minute = candidate.getMinutes();

      // Check month
      if (!fields.months.includes(month)) {
        // Skip to first valid month
        candidate.setMonth(candidate.getMonth() + 1, 1);
        candidate.setHours(0, 0, 0, 0);
        continue;
      }

      // Check day of month AND day of week (both must match)
      if (!fields.daysOfMonth.includes(dayOfMonth) || !fields.daysOfWeek.includes(dayOfWeek)) {
        candidate.setDate(candidate.getDate() + 1);
        candidate.setHours(0, 0, 0, 0);
        continue;
      }

      // Check hour
      if (!fields.hours.includes(hour)) {
        candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
        continue;
      }

      // Check minute
      if (!fields.minutes.includes(minute)) {
        candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
        continue;
      }

      // All fields match
      return candidate;
    }

    return null; // No match within search window
  }
}
