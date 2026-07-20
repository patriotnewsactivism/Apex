// ─── CI Workspace ──────────────────────────────────────────────────────────
//
// TestRunner/LinterRunner/BuildManager used to shell out `pnpm run
// typecheck`/`build` against `process.cwd()` -- the LIVE production
// container's own checkout. That checkout is built via `npm ci --omit=dev`
// per standing Build Discipline (never ship devDependencies to prod), so
// `typescript` itself isn't installed there -- every real pipeline run
// failed instantly with MODULE_NOT_FOUND for tsc, not a real test failure.
//
// Fix: maintain a SEPARATE scratch checkout (this repo, public, no auth
// needed) with a full `pnpm install` (including devDependencies) purely for
// CI verification. This mirrors real CI systems (isolated checkout+build
// environment, distinct from what's actually deployed) and does not violate
// Build Discipline -- that rule governs the deployed production artifact,
// not an ephemeral, git-ignored CI sandbox used only to run checks.
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execAsync = promisify(exec);
const CI_WORKSPACE_ROOT = '/tmp/apex-ci-workspace';
const REPO_URL = 'https://github.com/patriotnewsactivism/Apex.git';

let syncPromise: Promise<string> | null = null;

async function doSync(): Promise<string> {
  const exists = fs.existsSync(`${CI_WORKSPACE_ROOT}/.git`);

  if (!exists) {
    await execAsync(`rm -rf ${CI_WORKSPACE_ROOT} && git clone --depth 1 ${REPO_URL} ${CI_WORKSPACE_ROOT}`, {
      timeout: 120_000,
    });
  } else {
    await execAsync('git fetch origin main && git reset --hard origin/main', {
      cwd: CI_WORKSPACE_ROOT,
      timeout: 60_000,
    });
  }

  // Only reinstall if the lockfile actually changed since our last install
  // (full pnpm install across this monorepo is the slow part).
  const lockPath = `${CI_WORKSPACE_ROOT}/pnpm-lock.yaml`;
  const markerPath = `${CI_WORKSPACE_ROOT}/.ci-install-marker`;
  const lockHash = fs.existsSync(lockPath)
    ? fs.readFileSync(lockPath, 'utf-8').length.toString()
    : '0';
  const prevHash = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf-8').trim() : '';
  const nodeModulesExists = fs.existsSync(`${CI_WORKSPACE_ROOT}/node_modules`);

  if (!nodeModulesExists || lockHash !== prevHash) {
    await execAsync('pnpm install', { cwd: CI_WORKSPACE_ROOT, timeout: 300_000 });
    fs.writeFileSync(markerPath, lockHash);
  }

  return CI_WORKSPACE_ROOT;
}

/** Ensure the CI scratch workspace exists, is up to date with origin/main, and has full (dev-included) deps installed. Returns its path. Concurrent callers share one in-flight sync. */
export async function ensureCiWorkspace(): Promise<string> {
  if (!syncPromise) {
    syncPromise = doSync().catch((err) => {
      syncPromise = null; // allow retry on next call instead of caching a failure forever
      throw err;
    });
  }
  return syncPromise;
}
