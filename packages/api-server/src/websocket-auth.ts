import crypto from 'crypto';

const TICKET_TTL_MS = 30_000;
const tickets = new Map<string, number>();

/**
 * Create a short-lived, single-use credential for a browser WebSocket upgrade.
 * The long-lived admin token must never be placed in a URL, where browsers,
 * proxies, and error reports can retain it.
 */
export function issueWebSocketTicket(now = Date.now()): string {
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

