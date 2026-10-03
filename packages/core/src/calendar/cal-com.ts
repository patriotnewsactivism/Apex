import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Cal.com client generalized from packages/api-server/src/routes/cartesia-sales.ts.
 * Public booking links use Cal.com. Agent bookings do not call the Cal.com
 * booking API, because that sends mail on its own and would skip the safeguard.
 */

export interface CalConfig {
  key: string;
  eventTypeId: number;
}

export function readCalConfig(env: NodeJS.ProcessEnv = process.env): CalConfig | null {
  const key = env.APEX_CAL_API_KEY?.trim();
  const eventTypeId = Number(env.APEX_CAL_EVENT_TYPE_ID);
  if (!key || !Number.isSafeInteger(eventTypeId) || eventTypeId <= 0) return null;
  return { key, eventTypeId };
}

export function calWebhookSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.APEX_CAL_WEBHOOK_SECRET?.trim();
  return secret || null;
}

export async function calRequest(path: string, key: string, body?: object, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const response = await fetchImpl(`https://api.cal.com/v2/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      'cal-api-version': '2026-02-25',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(6000),
  });
  const data = await response.json().catch(() => ({})) as { status?: string; data?: unknown };
  if (!response.ok || data.status !== 'success') throw new Error(`Calendar returned ${response.status}`);
  return data.data;
}

export function verifyCalWebhookSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!secret || !header || rawBody.length === 0) return false;
  const provided = header.trim().toLowerCase().replace(/^sha256=/, '');
  if (!/^[0-9a-f]+$/.test(provided) || provided.length % 2 !== 0) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(provided, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export function authorizeCalWebhook(
  secret: string | undefined,
  rawBody: Buffer | undefined,
  header: string | undefined,
): { ok: true } | { ok: false; status: 401 | 503; error: string } {
  if (!secret) return { ok: false, status: 503, error: 'Calendar webhook is not configured' };
  if (!rawBody || !verifyCalWebhookSignature(secret, rawBody, header)) {
    return { ok: false, status: 401, error: 'Invalid signature' };
  }
  return { ok: true };
}

export interface CalWebhookBooking {
  trigger: string;
  uid: string;
  title: string;
  start: Date;
  end: Date;
  attendeeEmail: string | null;
  attendeeName: string | null;
  rescheduleUid: string | null;
}

export function parseCalWebhook(body: unknown): CalWebhookBooking | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const trigger = typeof record.triggerEvent === 'string' ? record.triggerEvent : '';
  const payload = (record.payload && typeof record.payload === 'object' ? record.payload : record) as Record<string, unknown>;
  const uid = typeof payload.uid === 'string' ? payload.uid : '';
  if (!trigger || !uid) return null;
  const startRaw = payload.startTime ?? payload.start;
  const endRaw = payload.endTime ?? payload.end;
  const start = new Date(typeof startRaw === 'string' ? startRaw : '');
  const end = new Date(typeof endRaw === 'string' ? endRaw : '');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
  const first = attendees[0] as { email?: string; name?: string } | undefined;
  const rescheduleUid = typeof payload.rescheduleUid === 'string' ? payload.rescheduleUid : null;
  return {
    trigger,
    uid,
    title: typeof payload.title === 'string' ? payload.title : 'Cal.com booking',
    start,
    end,
    attendeeEmail: typeof first?.email === 'string' ? first.email : null,
    attendeeName: typeof first?.name === 'string' ? first.name : null,
    rescheduleUid,
  };
}
