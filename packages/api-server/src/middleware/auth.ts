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
 *
 * APEX_VAPI_SMS_TOKEN is the same idea for a third-party voice platform (Vapi)
 * that needs to trigger an outbound SMS from its own tool-calling — handing a
 * SaaS vendor's stored config the full admin token would give it goal
 * creation, approvals, and every other operator power for the sake of one
 * text message. Accepted for exactly one route: POST /api/sales-ops/sms/send.
 */
const configuredToken = requireEnv('APEX_ADMIN_TOKEN');
const configuredOutcomeIngestToken = process.env.APEX_OUTCOME_INGEST_TOKEN?.trim() || null;
const configuredVapiSmsToken = process.env.APEX_VAPI_SMS_TOKEN?.trim() || null;
const configuredLeadImportToken = process.env.APEX_LEAD_IMPORT_TOKEN?.trim() || null;

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

export function validateVapiSmsToken(authHeader: string | undefined): boolean {
  return constantTimeTokenMatch(bearerToken(authHeader), configuredVapiSmsToken);
}

export function validateLeadImportToken(authHeader: string | undefined): boolean {
  return constantTimeTokenMatch(bearerToken(authHeader), configuredLeadImportToken);
}

function isOutcomeIngestRoute(req: Request): boolean {
  const path = req.originalUrl.split('?')[0];
  return req.method === 'POST' && path === '/api/learning/outcome-ledger/events';
}

function isVapiSmsRoute(req: Request): boolean {
  const path = req.originalUrl.split('?')[0];
  return req.method === 'POST' && path === '/api/sales-ops/sms/send';
}

function isLeadImportRoute(req: Request): boolean {
  const path = req.originalUrl.split('?')[0];
  return req.method === 'POST' && path === '/api/leads/import-enrichment';
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
  if (isVapiSmsRoute(req) && validateVapiSmsToken(req.headers.authorization)) {
    next();
    return;
  }
  if (isLeadImportRoute(req) && validateLeadImportToken(req.headers.authorization)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Invalid token' });
}
