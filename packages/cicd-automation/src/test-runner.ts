// ─── TestRunner ──────────────────────────────────────────────────────────────
//
// Executes tests / typechecks for workspace packages, parses test outputs,
// and records execution metrics in the test_results database table.

import { exec } from 'child_process';
import { promisify } from 'util';
import { db, testResults, pipelineRuns } from '@workspace/db';
import crypto from 'crypto';
import { ensureCiWorkspace } from './ci-workspace.js';

const execAsync = promisify(exec);

function parsePnpmPackageResults(output: string): { total: number; passed: number; failed: number } {
  const lines = output.split('\n');
  const total: string[] = [];
  const failed: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(\S+)\s+typecheck:\s*(Done|Failed)$/);
    if (m) {
      total.push(m[1]);
      if (m[2] === 'Failed') failed.push(m[1]);
    }
  }
  return { total: total.length, passed: total.length - failed.length, failed: failed.length };
}

export interface TestRunReport {
  runId: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  coveragePct?: number;
  output: string;
  success: boolean;
}

export class TestRunner {
  private workspaceRoot: string;

  private explicitRoot: boolean;

  constructor(workspaceRoot?: string) {
    this.explicitRoot = workspaceRoot !== undefined;
    this.workspaceRoot = workspaceRoot ?? process.cwd();
  }

  /** Run test/typecheck suite asynchronously and log results. */
  async runTests(runId?: string): Promise<TestRunReport> {
    const activeRunId = runId ?? `run-${crypto.randomUUID().slice(0, 8)}`;
    const startTime = Date.now();

    // Create pipeline run record if not already present
    await db
      .insert(pipelineRuns)
      .values({
        id: activeRunId,
        repo: 'Apex',
        branch: 'main',
        status: 'running',
        triggerType: 'manual',
        startedAt: new Date(),
      })
      .onConflictDoNothing()
      .catch((err) => console.error('[TestRunner] pipelineRuns insert failed:', err));

    try {
      // Run against an isolated CI checkout (with devDependencies installed)
      // rather than this live process's own prod-only node_modules -- see
      // ci-workspace.ts for why. An explicit constructor override (used in
      // tests) is respected as-is.
      const cwd = this.explicitRoot ? this.workspaceRoot : await ensureCiWorkspace();
      // Execute strict typecheck as primary quality gate
      const { stdout, stderr } = await execAsync('pnpm run typecheck', {
        cwd,
        timeout: 120_000,
      });
      const combinedOutput = stdout + (stderr ? `\n${stderr}` : '');
      const counts = parsePnpmPackageResults(combinedOutput);

      const durationMs = Date.now() - startTime;
      const report: TestRunReport = {
        runId: activeRunId,
        totalTests: counts.total,
        passed: counts.passed,
        failed: counts.failed,
        skipped: 0,
        durationMs,
        output: combinedOutput,
        success: counts.failed === 0,
      };

      await db.insert(testResults).values({
        runId: activeRunId,
        totalTests: report.totalTests,
        passed: report.passed,
        failed: report.failed,
        skipped: report.skipped,
        durationMs,
        testReport: { output: report.output.slice(-2000) },
        recordedAt: new Date(),
      });

      await db
        .update(pipelineRuns)
        .set({
          status: 'success',
          completedAt: new Date(),
          durationMs,
        })
        .where(eq(pipelineRuns.id, activeRunId))
        .catch((err) => console.error('[TestRunner] pipelineRuns success update failed:', err));

      return report;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const output = err?.stdout || err?.stderr || errorMsg;
      const counts = parsePnpmPackageResults(String(output));

      const report: TestRunReport = {
        runId: activeRunId,
        totalTests: counts.total,
        passed: counts.passed,
        failed: counts.failed,
        skipped: 0,
        durationMs,
        output: String(output),
        success: false,
      };

      await db.insert(testResults).values({
        runId: activeRunId,
        totalTests: report.totalTests,
        passed: report.passed,
        failed: report.failed,
        skipped: report.skipped,
        durationMs,
        testReport: { error: errorMsg, output: String(output).slice(-2000) },
        recordedAt: new Date(),
      });

      await db
        .update(pipelineRuns)
        .set({
          status: 'failed',
          completedAt: new Date(),
          durationMs,
          error: errorMsg,
        })
        .where(eq(pipelineRuns.id, activeRunId))
        .catch((err) => console.error('[TestRunner] pipelineRuns failure update failed:', err));

      return report;
    }
  }
}

import { eq } from 'drizzle-orm';
