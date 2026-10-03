// Short-lived proof that a request came from an authenticated operator
// dashboard session — not an agent, tool, bot token, voice webhook, or job.
// The admin bearer token alone is not enough: bots that hold APEX_ADMIN_TOKEN
// still fail this check without a ticket issued at login/verify.

import crypto from 'node:crypto';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const tickets = new Map<string, number>();

function hashTicket(ticket: string): string {
  return crypto.createHash('sha256').update(ticket).digest('hex');
}

function sweep(now = Date.now()): void {
  for (const [hash, expiresAt] of tickets) {
    if (expiresAt <= now) tickets.delete(hash);
  }
}

export function issueOperatorSession(): string {
  sweep();
  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(hashTicket(ticket), Date.now() + SESSION_TTL_MS);
  return ticket;
}

export function validateOperatorSession(ticket: string | undefined): boolean {
  if (!ticket) return false;
  sweep();
  const expiresAt = tickets.get(hashTicket(ticket));
  return Boolean(expiresAt && expiresAt > Date.now());
}

export function revokeOperatorSession(ticket: string | undefined): void {
  if (!ticket) return;
  tickets.delete(hashTicket(ticket));
}
