import crypto from 'crypto';

const TICKET_TTL_MS = 30_000;
const tickets = new Map<string, number>();

const stats = {
  issued: 0,
  persistOk: 0,
  persistFailed: 0,
  consumedMemory: 0,
  consumedPostgres: 0,
};

function ticketStoreMode(): 'memory' | 'postgres' {
  return process.env.APEX_WEBSOCKET_TICKETS === 'memory' ? 'memory' : 'postgres';
}

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
  stats.issued += 1;
  if (ticketStoreMode() === 'postgres') {
    try {
      const { db, websocketTickets } = await import('@workspace/db');
      await db.insert(websocketTickets).values({
        ticket,
        expiresAt: new Date(expiresAt),
      });
      stats.persistOk += 1;
    } catch {
      stats.persistFailed += 1;
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
  if (ticketStoreMode() === 'postgres') {
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
  if (memoryExpires !== undefined) {
    stats.consumedMemory += 1;
    return memoryExpires >= now;
  }
  if (persisted && persisted.expiresAt.getTime() >= now) {
    stats.consumedPostgres += 1;
    return true;
  }
  return false;
}

/** Drop the process-local copy so consume() must use Postgres. Used to prove replica-safety on one instance. */
export function forgetLocalWebSocketTicket(ticket: string): void {
  tickets.delete(ticket);
}

export function getWebSocketTicketStats(): {
  mode: 'memory' | 'postgres';
  issued: number;
  persistOk: number;
  persistFailed: number;
  consumedMemory: number;
  consumedPostgres: number;
} {
  return { mode: ticketStoreMode(), ...stats };
}

export async function provePersistedTicketRoundTrip(now = Date.now()): Promise<{
  mode: 'memory' | 'postgres';
  consumedAfterLocalDrop: boolean;
  replayRejected: boolean;
}> {
  const mode = ticketStoreMode();
  const ticket = await issueWebSocketTicket(now);
  forgetLocalWebSocketTicket(ticket);
  const consumedAfterLocalDrop = await consumeWebSocketTicket(ticket, now + 1);
  const replayRejected = !(await consumeWebSocketTicket(ticket, now + 2));
  return { mode, consumedAfterLocalDrop, replayRejected };
}

function pruneExpiredTickets(now: number): void {
  for (const [ticket, expiresAt] of tickets) {
    if (expiresAt < now) tickets.delete(ticket);
  }
}
