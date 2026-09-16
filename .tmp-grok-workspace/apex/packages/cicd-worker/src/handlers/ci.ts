// ─── CI job handlers (test / lint / build) ─────────────────────────────────
//
// Ported from packages/cicd-automation/src/{test-runner,linter-runner,
// build-manager}.ts. Report shapes (TestRunReport / LintRunReport /
// BuildResult) are kept field-for-field identical to those files so the
// job `result` matches what the OLD tools returned into the conversation.
//
// Behavior difference from the original (deliberate, and the one genuine
// scope change in this whole port): the old runners also wrote rows into
// the Postgres `pipelineRuns` / `testResults` / `lintResults` tables
// (via @workspace/db) as a side effect of every run. That DB is gone in the
// Convex migration, and convex/cicd.ts's contract exposes no mutation for
// this worker to persist into the Convex equivalents of those tables (only
// claimNextJob/reportJobResult) -- so that persistence is simply dropped
// here. The `result` returned to reportJobResult is otherwise the same
// report shape the agent's conversation history always got.
//
// The hardcoded totalTests=9 / totalFiles=150 numbers below are NOT a typo
// introduced by this port -- the original TestRunner/LinterRunner never
// actually parsed per-test/per-file counts out of `pnpm run typecheck`
// output either; they hardcoded these same rough estimates. LinterRunner
// really did just run `pnpm run typecheck` too (not a separate lint step) --
// confirmed by reading linter-runner.ts, not a mistake here.
import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { ensureCiWorkspace } from '../ciWorkspace.js';

const execAsync = promisify(exec);

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

export async function handleTest(): Promise<TestRunReport> {
  const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
  const startTime = Date.now();

  try {
    const cwd = await ensureCiWorkspace();
    const { stdout, stderr } = await execAsync('pnpm run typecheck', { cwd, timeout: 120_000 });
    const durationMs = Date.now() - startTime;
    return {
      runId,
      totalTests: 9, // 9 workspace packages -- matches the old hardcoded estimate
      passed: 9,
      failed: 0,
      skipped: 0,
      durationMs,
      coveragePct: 100,
      output: stdout + (stderr ? `\n${stderr}` : ''),
      success: true,
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    const output = err?.stdout || err?.stderr || errorMsg;
    return {
      runId,
      totalTests: 9,
      passed: 0,
      failed: 9,
      skipped: 0,
      durationMs,
      output: String(output),
      success: false,
    };
  }
}

export interface LintRunReport {
  runId: string;
  totalFiles: number;
  errors: number;
  warnings: number;
  output: string;
  success: boolean;
}

export async function handleLint(): Promise<LintRunReport> {
  const runId = `lint-${crypto.randomUUID().slice(0, 8)}`;

  try {
    const cwd = await ensureCiWorkspace();
    // Yes, lint really does just run typecheck -- see file header comment.
    const { stdout, stderr } = await execAsync('pnpm run typecheck', { cwd, timeout: 120_000 });
    return {
      runId,
      totalFiles: 150,
      errors: 0,
      warnings: 0,
      output: stdout + (stderr ? `\n${stderr}` : ''),
      success: true,
    };
  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const output = err?.stdout || err?.stderr || errorMsg;
    return {
      runId,
      totalFiles: 150,
      errors: 1,
      warnings: 0,
      output: String(output),
      success: false,
    };
  }
}

export interface BuildResult {
  runId: string;
  success: boolean;
  durationMs: number;
  output: string;
  error?: string;
}

export async function handleBuild(): Promise<BuildResult> {
  const runId = `build-${crypto.randomUUID().slice(0, 8)}`;
  const startTime = Date.now();

  try {
    const cwd = await ensureCiWorkspace();
    const { stdout, stderr } = await execAsync('pnpm run build', { cwd, timeout: 180_000 });
    const durationMs = Date.now() - startTime;
    return {
      runId,
      success: true,
      durationMs,
      output: stdout + (stderr ? `\n${stderr}` : ''),
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    const output = err?.stdout || err?.stderr || errorMsg;
    return {
      runId,
      success: false,
      durationMs,
      output: String(output),
      error: errorMsg,
    };
  }
}
