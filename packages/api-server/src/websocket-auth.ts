import crypto from 'crypto';

const TICKET_TTL_MS = 30_000;
<<<<<<< ours
<<<<<<< ours
const tickets = new Map<string, number>();

/**
 * Create a short-lived, single-use credential for a browser WebSocket upgrade.
=======
=======
>>>>>>> theirs
const TICKET_VERSION = 'v1';

/**
 * Create a short-lived signed credential for a browser WebSocket upgrade.
 * Tickets are stateless so an HTTP request handled by one Cloud Run instance
 * can be followed by a WebSocket upgrade handled by another instance.
<<<<<<< ours
>>>>>>> theirs
=======
>>>>>>> theirs
 * The long-lived admin token must never be placed in a URL, where browsers,
 * proxies, and error reports can retain it.
 */
export function issueWebSocketTicket(now = Date.now()): string {
<<<<<<< ours
<<<<<<< ours
  pruneExpiredTickets(now);
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(ticket, now + TICKET_TTL_MS);
  return ticket;
}

export function consumeWebSocketTicket(ticket: string | null, now = Date.now()): boolean {
  if (!ticket) return false;
  const expiresAt = tickets.get(ticket);
  tickets.delete(ticket);
  return expiresAt !== undefined && expiresAt >= now;
}

function pruneExpiredTickets(now: number): void {
  for (const [ticket, expiresAt] of tickets) {
    if (expiresAt < now) tickets.delete(ticket);
  }
}

=======
=======
>>>>>>> theirs
  const expiresAt = now + TICKET_TTL_MS;
  const nonce = crypto.randomBytes(18).toString('base64url');
  const payload = `${TICKET_VERSION}.${expiresAt}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

export function validateWebSocketTicket(ticket: string | null, now = Date.now()): boolean {
  if (!ticket) return false;
  const parts = ticket.split('.');
  if (parts.length !== 4) return false;
  const [version, expiresAtText, nonce, suppliedSignature] = parts;
  if (version !== TICKET_VERSION || !nonce || !suppliedSignature) return false;

  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now || expiresAt > now + TICKET_TTL_MS) return false;

  const expectedSignature = sign(`${version}.${expiresAtText}.${nonce}`);
  const supplied = Buffer.from(suppliedSignature, 'base64url');
  const expected = Buffer.from(expectedSignature, 'base64url');
  return suppliedSignature === supplied.toString('base64url')
    && supplied.length === expected.length
    && crypto.timingSafeEqual(supplied, expected);
}

function sign(payload: string): string {
  const signingKey = process.env.APEX_ADMIN_TOKEN;
  if (!signingKey) throw new Error('APEX_ADMIN_TOKEN must be set before issuing WebSocket tickets.');
  return crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
}
<<<<<<< ours
>>>>>>> theirs
=======
>>>>>>> theirs
