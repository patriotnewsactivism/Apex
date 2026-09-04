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

// On Cloud Run the container has no disk. `/tmp` is a tmpfs, and every byte
// written to it is charged against the service's memory limit — while being
// completely invisible to process.memoryUsage(), which reports only the Node
// heap. A full install of this monorepo is 478MB of node_modules. Against the
// 512MiB the service ran on until 2026-09-04 (rss alone was ~150MB, leaving
// ~360MB) it could not fit, so the first agent to call runTests/runLinter/
// runBuild took the whole container out mid-install: killed by the kernel, no
// application log, restart on an unchanged revision, and the next agent to try
// did it again. That is what produced the 7-12 minute restart cycle on
// 2026-09-04, and why raising the limit to 1Gi stretched the interval to ~45
// minutes instead of ending it — 487MB fits in 874MB of headroom, until agents
// are busy enough that it doesn't.
//
// So refuse, loudly, instead of taking the workforce down. These tools never
// actually worked here: every invocation ended in an OOM kill rather than a
// test result. CI belongs somewhere with a real filesystem — the repo's own
// GitHub Actions workflows, or packages/cicd-worker, which has its own
// workspace implementation and is unaffected by this guard.
const IN_CONTAINER_CI_OPT_IN = 'APEX_ALLOW_IN_CONTAINER_CI';

/** True where building the workspace would eat the container's memory limit.
 *  Cloud Run always sets K_SERVICE for the running service. Exported so the
 *  guard can be verified without triggering a real clone. */
export function isCiWorkspaceBlocked(): boolean {
  if (process.env[IN_CONTAINER_CI_OPT_IN] === '1') return false;
  return Boolean(process.env.K_SERVICE);
}

let syncPromise: Promise<string> | null = null;

async function doSync(): Promise<string> {
  if (isCiWorkspaceBlocked()) {
    throw new Error(
      `Refusing to build a CI workspace on ${process.env.K_SERVICE}: /tmp is RAM-backed here, ` +
        'and a full install of this monorepo (478MB) is charged against the container memory limit, ' +
        'which kills the whole agent workforce mid-install. Run tests, lint and builds in GitHub ' +
        `Actions or on the standalone cicd-worker instead. Set ${IN_CONTAINER_CI_OPT_IN}=1 only on a ` +
        'host with a real filesystem and memory to spare.',
    );
  }

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
