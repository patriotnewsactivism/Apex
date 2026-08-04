// ─── BuildManager ─────────────────────────────────────────────────────────────
//
// Triggers production builds across workspace packages, monitors progress,
// and captures compilation outputs and errors.

import { exec } from 'child_process';
import { promisify } from 'util';
import { db, pipelineRuns } from '@workspace/db';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { ensureCiWorkspace } from './ci-workspace.js';

const execAsync = promisify(exec);

export interface BuildResult {
  runId: string;
  success: boolean;
  durationMs: number;
  output: string;
  error?: string;
}

export class BuildManager {
  private workspaceRoot: string;

  private explicitRoot: boolean;

  constructor(workspaceRoot?: string) {
    this.explicitRoot = workspaceRoot !== undefined;
    this.workspaceRoot = workspaceRoot ?? process.cwd();
  }

  async buildProject(runId?: string): Promise<BuildResult> {
    const activeRunId = runId ?? `build-${crypto.randomUUID().slice(0, 8)}`;
    const startTime = Date.now();

    // Build results are stored against a pipelineRuns row; create one if the
    // caller did not pass an existing run ID.
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
      .catch((err) => console.error('[BuildManager] pipelineRuns insert failed:', err));

    try {
      const cwd = this.explicitRoot ? this.workspaceRoot : await ensureCiWorkspace();
      const { stdout, stderr } = await execAsync('pnpm run build', {
        cwd,
        timeout: 180_000,
      });

      const durationMs = Date.now() - startTime;
      const result: BuildResult = {
        runId: activeRunId,
        success: true,
        durationMs,
        output: stdout + (stderr ? `\n${stderr}` : ''),
      };

      await db
        .update(pipelineRuns)
        .set({
          status: 'success',
          completedAt: new Date(),
          durationMs,
        })
        .where(eq(pipelineRuns.id, activeRunId))
        .catch((err) => console.error('[BuildManager] pipelineRuns success update failed:', err));

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const output = err?.stdout || err?.stderr || errorMsg;

      const result: BuildResult = {
        runId: activeRunId,
        success: false,
        durationMs,
        output: String(output),
        error: errorMsg,
      };

      await db
        .update(pipelineRuns)
        .set({
          status: 'failed',
          completedAt: new Date(),
          durationMs,
          error: errorMsg,
        })
        .where(eq(pipelineRuns.id, activeRunId))
        .catch((err) => console.error('[BuildManager] pipelineRuns failure update failed:', err));

      return result;
    }
  }
}
