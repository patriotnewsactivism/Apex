import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

/**
 * Locks down every /api/* route behind a bearer token.
 *
 * APEX_ADMIN_TOKEN is the operator/control-plane credential. Portfolio apps
 * may additionally receive APEX_OUTCOME_INGEST_TOKEN, but that credential is
 * accepted for exactly one append-only route: POST /api/learning/outcome-ledger/events.
 * It cannot read the ledger, approve actions, create goals, invoke tools, or
 * otherwise inherit APEX admin authority.
 */
const configuredToken = requireEnv('APEX_ADMIN_TOKEN');
const configuredOutcomeIngestToken = process.env.APEX_OUTCOME_INGEST_TOKEN?.trim() || null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set — no hardcoded fallback is used for admin credentials.`);
  }
  return value;
}

function constantTimeTokenMatch(candidate: string | undefined, configured: string | null): boolean {
  if (!candidate || !configured || candidate.length !== configured.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(configured));
  } catch {
    return false;
  }
}

function bearerToken(authHeader: string | undefined): string | undefined {
  const [scheme, token] = (authHeader || '').split(' ');
  return scheme === 'Bearer' && token ? token : undefined;
}

export function validateAdminToken(authHeader: string | undefined): boolean {
  return constantTimeTokenMatch(bearerToken(authHeader), configuredToken);
}

export function validateOutcomeIngestToken(authHeader: string | undefined): boolean {
  return constantTimeTokenMatch(bearerToken(authHeader), configuredOutcomeIngestToken);
}

function isOutcomeIngestRoute(req: Request): boolean {
  const path = req.originalUrl.split('?')[0];
  return req.method === 'POST' && path === '/api/learning/outcome-ledger/events';
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  if (validateAdminToken(req.headers.authorization)) {
    next();
    return;
  }
  if (isOutcomeIngestRoute(req) && validateOutcomeIngestToken(req.headers.authorization)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Invalid token' });
}
