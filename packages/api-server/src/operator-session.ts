// Operator dashboard sessions are separate from the admin bearer token.
// A bot that presents APEX_ADMIN_TOKEN cannot submit the send code unless it
// also holds a session minted by a password login from the dashboard.

import { createHash, randomBytes } from 'node:crypto';

const TTL_MS = 12 * 60 * 60 * 1000;
const memory = new Map<string, { origin: string; expiresAt: number }>();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueOperatorDashboardSession(origin: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TTL_MS);
  memory.set(tokenHash, { origin, expiresAt: expiresAt.getTime() });
  try {
    const { db, operatorDashboardSessions } = await import('@workspace/db');
    await db.insert(operatorDashboardSessions).values({
      tokenHash,
      origin: origin.slice(0, 200),
      expiresAt,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error('[operator-session] persist failed', error instanceof Error ? error.message : 'unavailable');
  }
  return token;
}

export async function operatorDashboardSessionValid(token: string | undefined | null): Promise<boolean> {
  if (!token || token.length < 32) return false;
  const tokenHash = hashToken(token);
  const cached = memory.get(tokenHash);
  if (cached) return cached.expiresAt > Date.now();
  try {
    const { db, operatorDashboardSessions } = await import('@workspace/db');
    const { eq } = await import('drizzle-orm');
    const [row] = await db.select().from(operatorDashboardSessions).where(eq(operatorDashboardSessions.tokenHash, tokenHash)).limit(1);
    if (!row || row.expiresAt.getTime() <= Date.now()) return false;
    memory.set(tokenHash, { origin: row.origin, expiresAt: row.expiresAt.getTime() });
    return true;
  } catch {
    return false;
  }
}
