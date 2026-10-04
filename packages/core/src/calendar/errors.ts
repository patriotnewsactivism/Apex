export class CalendarNotConnectedError extends Error {
  readonly code = 'not_connected';
  constructor(message = 'Live calendar is not connected') {
    super(message);
    this.name = 'CalendarNotConnectedError';
  }
}

export class DoNotContactError extends Error {
  readonly code = 'do_not_contact';
  constructor(message = 'Contact opted out') {
    super(message);
    this.name = 'DoNotContactError';
  }
}

export class SlotUnavailableError extends Error {
  readonly code = 'slot_unavailable';
  constructor(message = 'That time is not available') {
    super(message);
    this.name = 'SlotUnavailableError';
  }
}

/** Postgres exclusion_violation, or the in-memory stand-in for the same constraint. */
export class CalendarExclusionError extends Error {
  readonly code = '23P01';
  constructor() {
    super('calendar hold overlaps an active hold');
    this.name = 'CalendarExclusionError';
  }
}

export function isCalendarExclusionError(err: unknown): boolean {
  if (err instanceof CalendarExclusionError) return true;
  const candidate = err as { code?: string; cause?: { code?: string }; message?: string };
  const code = candidate?.code ?? candidate?.cause?.code;
  if (code === '23P01') return true;
  const message = err instanceof Error ? err.message : '';
  return message.includes('calendar_slot_holds_no_overlap') || message.includes('23P01');
}
