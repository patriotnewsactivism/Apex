import { Router } from 'express';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  auditEvents,
  consentRecords,
  contactOutreachGates,
  db,
} from '@workspace/db';
import { getBuildInfo, paidLLMFallbackEnabled } from '@workspace/core';

type CountRow = { key: string; count: number };

function countMap(rows: CountRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.count) || 0]));
}

function canonicalRuntimeSnapshot() {
  const build = getBuildInfo();
  const repoRoot = process.env.APEX_CANONICAL_REPO_ROOT?.trim() || process.cwd();
  const artifactRoot =
    process.env.APEX_ARTIFACT_DIR?.trim() ||
    (process.env.APEX_ARTIFACT_BUCKET?.trim()
      ? `gcs://${process.env.APEX_ARTIFACT_BUCKET.trim()}`
      : null);

  return {
    repoRoot,
    buildSha: build.sha,
    sourceBranch: process.env.APEX_SOURCE_BRANCH?.trim() || 'main',
    runtimeEntrypoint: process.argv[1] || 'unknown',
    artifactRoot,
    databaseConfigured: Boolean(process.env.DATABASE_URL?.trim()),
    environmentName:
      process.env.RAILWAY_ENVIRONMENT_NAME ||
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.NODE_ENV ||
      'development',
  };
}

/**
 * Authenticated governance telemetry for Verify & Scale.
 *
 * This exposes operational facts only. No bearer tokens, connection strings,
 * API keys, prompts, or provider payloads leave the server.
 */
export function createGovernanceRouter(): Router {
  const router = Router();

  router.get('/status', async (_req, res) => {
    try {
      const runtime = canonicalRuntimeSnapshot();
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const [provenanceRows, gateRows, consentRows] = await Promise.all([
        db
          .select({
            action: auditEvents.action,
            actorId: auditEvents.actorId,
            entityId: auditEvents.entityId,
            metadata: auditEvents.metadata,
            createdAt: auditEvents.createdAt,
          })
          .from(auditEvents)
          .where(and(
            inArray(auditEvents.action, [
              'runtime.provenance_verified',
              'runtime.provenance_failed',
            ]),
            sql`${auditEvents.createdAt} >= ${since}`,
          ))
          .orderBy(desc(auditEvents.createdAt))
          .limit(100),
        db
          .select({
            key: contactOutreachGates.gate,
            count: sql<number>`count(*)::int`,
          })
          .from(contactOutreachGates)
          .where(eq(contactOutreachGates.organizationId, 'apex'))
          .groupBy(contactOutreachGates.gate),
        db
          .select({
            key: consentRecords.status,
            count: sql<number>`count(*)::int`,
          })
          .from(consentRecords)
          .where(eq(consentRecords.organizationId, 'apex'))
          .groupBy(consentRecords.status),
      ]);

      const provenance = {
        verified24h: provenanceRows.filter((row) => row.action === 'runtime.provenance_verified').length,
        failed24h: provenanceRows.filter((row) => row.action === 'runtime.provenance_failed').length,
        latest: provenanceRows[0]
          ? {
              action: provenanceRows[0].action,
              agentId: provenanceRows[0].actorId,
              taskId: provenanceRows[0].entityId,
              at: provenanceRows[0].createdAt.toISOString(),
              reasons: Array.isArray(provenanceRows[0].metadata?.reasons)
                ? provenanceRows[0].metadata.reasons
                    .filter((value): value is string => typeof value === 'string')
                    .slice(0, 8)
                : [],
            }
          : null,
      };

      const outreachGates = countMap(gateRows);
      const consent = countMap(consentRows);

      const runtimeReady = Boolean(
        runtime.buildSha &&
        runtime.buildSha !== 'unknown' &&
        runtime.artifactRoot &&
        runtime.databaseConfigured,
      );
      const provenanceReady = provenance.failed24h === 0;
      const implementationGate = runtimeReady && provenanceReady ? 'ready' : 'blocked';

      res.json({
        loop: [
          'observe',
          'hypothesize',
          'verify',
          'implement',
          'monitor',
          'learn',
          'scale',
        ],
        implementationGate,
        runtime,
        provenance,
        outbound: {
          mode: 'fail_closed',
          evaluator: 'revenue_ops_compliance',
          channels: ['phone', 'sms', 'email'],
          requiresConsent: true,
          requiresAllowedGate: true,
          gateCounts: {
            allowed: outreachGates.allowed ?? 0,
            pending: outreachGates.pending ?? 0,
            denied: outreachGates.denied ?? 0,
          },
          consentCounts: {
            granted: consent.granted ?? 0,
            unknown: consent.unknown ?? 0,
            denied: consent.denied ?? 0,
            revoked: consent.revoked ?? 0,
          },
          scalingRule:
            'Only recipients with a consent-linked contact and an explicitly allowed channel gate can reach a live provider.',
        },
        configuration: {
          paidFallbackEnabled: paidLLMFallbackEnabled(),
          paidFallbackFlag: 'APEX_PAID_FALLBACK_ENABLED',
          legacyPaidFallbackPresent: Object.hasOwn(process.env, 'APEX_PAID_FALLBACK'),
          canonicalRepoRootConfigured: Boolean(process.env.APEX_CANONICAL_REPO_ROOT?.trim()),
          sourceBranchConfigured: Boolean(process.env.APEX_SOURCE_BRANCH?.trim()),
          artifactRootConfigured: Boolean(runtime.artifactRoot),
          databaseConfigured: runtime.databaseConfigured,
        },
        invariants: [
          {
            id: 'same_revision',
            ok: runtimeReady && provenanceReady,
            text: 'Code, test, data and artifact operations must resolve to the canonical deployed revision and storage boundary before autonomous writes.',
          },
          {
            id: 'outbound_fail_closed',
            ok: true,
            text: 'Missing, ambiguous or denied consent blocks phone, SMS and email before the provider call.',
          },
          {
            id: 'independent_verification',
            ok: true,
            text: 'A tool/API success is not treated as proof of outcome without an independent state check when the workflow exposes one.',
          },
          {
            id: 'evidence_over_brief',
            ok: true,
            text: 'Agents may correct a false premise and escalate rather than execute instructions contradicted by live evidence.',
          },
        ],
        observedAt: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Governance status query failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
