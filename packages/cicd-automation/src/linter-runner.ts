// ─── LinterRunner ─────────────────────────────────────────────────────────────
//
// Runs linter & strict typecheck audits across monorepo packages, parses
// warnings/errors, and logs results to the lint_results DB table.

import { exec } from 'child_process';
import { promisify } from 'util';
import { db, lintResults } from '@workspace/db';
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

export interface LintRunReport {
  runId: string;
  totalFiles: number;
  errors: number;
  warnings: number;
  output: string;
  success: boolean;
}

export class LinterRunner {
  private workspaceRoot: string;

  private explicitRoot: boolean;

  constructor(workspaceRoot?: string) {
    this.explicitRoot = workspaceRoot !== undefined;
    this.workspaceRoot = workspaceRoot ?? process.cwd();
  }

  async runLint(runId?: string): Promise<LintRunReport> {
    const activeRunId = runId ?? `lint-${crypto.randomUUID().slice(0, 8)}`;

    try {
      const cwd = this.explicitRoot ? this.workspaceRoot : await ensureCiWorkspace();
      const { stdout, stderr } = await execAsync('pnpm run typecheck', {
        cwd,
        timeout: 120_000,
      });
      const combinedOutput = stdout + (stderr ? `\n${stderr}` : '');
      const counts = parsePnpmPackageResults(combinedOutput);
      const hasErrors = counts.failed > 0;

      const report: LintRunReport = {
        runId: activeRunId,
        totalFiles: counts.total,
        errors: hasErrors ? 1 : 0,
        warnings: 0,
        output: combinedOutput,
        success: !hasErrors,
      };

      await db.insert(lintResults).values({
        runId: activeRunId,
        totalFiles: report.totalFiles,
        errors: report.errors,
        warnings: report.warnings,
        lintReport: { output: report.output.slice(-2000) },
        recordedAt: new Date(),
      });

      return report;
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const output = err?.stdout || err?.stderr || errorMsg;
      const counts = parsePnpmPackageResults(String(output));

      const report: LintRunReport = {
        runId: activeRunId,
        totalFiles: counts.total,
        errors: 1,
        warnings: 0,
        output: String(output),
        success: false,
      };

      await db.insert(lintResults).values({
        runId: activeRunId,
        totalFiles: report.totalFiles,
        errors: report.errors,
        warnings: report.warnings,
        lintReport: { error: errorMsg, output: String(output).slice(-2000) },
        recordedAt: new Date(),
      });

      return report;
    }
  }
}
