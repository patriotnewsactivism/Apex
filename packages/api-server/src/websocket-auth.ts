import crypto from 'crypto';

const TICKET_TTL_MS = 30_000;
const tickets = new Map<string, number>();

/**
 * Create a short-lived, single-use credential for a browser WebSocket upgrade.
 * The long-lived admin token must never be placed in a URL.
 *
 * Tickets are stored in process memory (same-replica, tests) and also written
 * to Postgres so a second Railway replica can consume a ticket this process
 * issued. Memory is the fast path; the table is the replica path.
 */
export async function issueWebSocketTicket(now = Date.now()): Promise<string> {
  pruneExpiredTickets(now);
  const ticket = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + TICKET_TTL_MS;
  tickets.set(ticket, expiresAt);
  if (process.env.APEX_WEBSOCKET_TICKETS !== 'memory') {
    try {
      const { db, websocketTickets } = await import('@workspace/db');
      await db.insert(websocketTickets).values({
        ticket,
        expiresAt: new Date(expiresAt),
      });
    } catch {
      // First boot before migrate(), or a unit test with no DB. Memory still works.
    }
  }
  return ticket;
}

export async function consumeWebSocketTicket(ticket: string | null, now = Date.now()): Promise<boolean> {
  if (!ticket) return false;
  pruneExpiredTickets(now);
  const memoryExpires = tickets.get(ticket);
  tickets.delete(ticket);
  let persisted: { expiresAt: Date } | undefined;
  if (process.env.APEX_WEBSOCKET_TICKETS !== 'memory') {
    try {
      const { db, websocketTickets } = await import('@workspace/db');
      const { eq } = await import('drizzle-orm');
      const [row] = await db
        .delete(websocketTickets)
        .where(eq(websocketTickets.ticket, ticket))
        .returning({ expiresAt: websocketTickets.expiresAt });
      persisted = row;
    } catch {
      persisted = undefined;
    }
  }
  if (memoryExpires !== undefined) return memoryExpires >= now;
  return Boolean(persisted && persisted.expiresAt.getTime() >= now);
}

function pruneExpiredTickets(now: number): void {
  for (const [ticket, expiresAt] of tickets) {
    if (expiresAt < now) tickets.delete(ticket);
  }
}
