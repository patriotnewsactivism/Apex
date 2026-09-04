/**
 * The CI workspace clones this repo and runs a full `pnpm install` — 478MB of
 * node_modules — into /tmp. On Cloud Run /tmp is a tmpfs charged against the
 * container's memory limit, so on the 512MiB the service ran on until
 * 2026-09-04 that install could not fit beside a ~150MB rss, and the first
 * agent to call runTests/runLinter/runBuild killed the whole workforce
 * mid-install. No application log, restart on an unchanged revision, repeat.
 *
 * The guard must refuse there rather than take production down, and must stay
 * out of the way everywhere else.
 */
import assert from 'node:assert/strict';
import { isCiWorkspaceBlocked, ensureCiWorkspace } from '../packages/cicd-automation/src/ci-workspace.js';

const saved = {
  K_SERVICE: process.env.K_SERVICE,
  APEX_ALLOW_IN_CONTAINER_CI: process.env.APEX_ALLOW_IN_CONTAINER_CI,
};

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fn();
}

async function main() {
  withEnv({ K_SERVICE: undefined, APEX_ALLOW_IN_CONTAINER_CI: undefined }, () => {
    assert.equal(isCiWorkspaceBlocked(), false, 'a normal host with a real disk must not be blocked');
  });

  withEnv({ K_SERVICE: 'apex', APEX_ALLOW_IN_CONTAINER_CI: undefined }, () => {
    assert.equal(isCiWorkspaceBlocked(), true, 'Cloud Run sets K_SERVICE and must be blocked');
  });

  // The capability is refused, not amputated: an operator with a real
  // filesystem can still opt in deliberately.
  withEnv({ K_SERVICE: 'apex', APEX_ALLOW_IN_CONTAINER_CI: '1' }, () => {
    assert.equal(isCiWorkspaceBlocked(), false, 'explicit opt-in must override the guard');
  });

  // And the refusal must reach the caller as a useful error rather than a
  // container death. This must reject BEFORE any git/pnpm process is spawned.
  process.env.K_SERVICE = 'apex';
  delete process.env.APEX_ALLOW_IN_CONTAINER_CI;
  await assert.rejects(
    ensureCiWorkspace(),
    /Refusing to build a CI workspace on apex/,
    'ensureCiWorkspace must reject on Cloud Run instead of cloning',
  );

  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  console.log('✅ CI WORKSPACE GUARD PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
