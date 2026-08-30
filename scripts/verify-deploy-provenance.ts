/** Pure regression checks for the Cloud Run health/provenance gate.
 * No Google Cloud or network calls: safe on every CI run. */
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_HEALTH_BODY_CHARS,
  immutableImageRef,
  retainHealthResponseBody,
} from '../packages/cicd-automation/src/cloud-run-deployer.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures++;
  console.error(`  ❌ ${label}`, detail ?? '');
}

const expectedSha = '289c8ce52d2d3dd17fa3e46373a825cb92938b62';
const expandedHealth = JSON.stringify({
  status: 'ok',
  agents: 13,
  agentStatusCounts: { idle: 13 },
  build: { sha: expectedSha },
  taskQueue: { verdict: 'ok', padding: 'x'.repeat(1_000) },
  llmCapacity: { state: 'available', pacingEnabled: true },
});

check('fixture exceeds the historical 500-character truncation boundary', expandedHealth.length > 500);
const retained = retainHealthResponseBody(expandedHealth);
check('complete health JSON is retained for provenance parsing', retained === expandedHealth);
let runningSha: unknown;
try {
  runningSha = (JSON.parse(retained) as { build?: { sha?: unknown } }).build?.sha;
} catch (error) {
  console.error(error);
}
check('expanded health response preserves the expected live commit', runningSha === expectedSha);

const artifactImage = 'us-central1-docker.pkg.dev/apex-project/apex/apex:latest';
const immutableArtifactImage = 'us-central1-docker.pkg.dev/apex-project/apex/apex:289c8ce52d2d';
check(
  'mutable Artifact Registry tag is rewritten to immutable short SHA',
  immutableImageRef(artifactImage, expectedSha) === immutableArtifactImage,
);
check(
  'Artifact Registry digest is rewritten to immutable short SHA',
  immutableImageRef(
    'us-central1-docker.pkg.dev/apex-project/apex/apex@sha256:' + 'a'.repeat(64),
    expectedSha,
  ) === immutableArtifactImage,
);
check(
  'untagged registry image receives immutable short SHA',
  immutableImageRef('us-central1-docker.pkg.dev/apex-project/apex/apex', expectedSha) === immutableArtifactImage,
);

let invalidShaRejected = false;
try {
  immutableImageRef(artifactImage, 'not-a-sha');
} catch {
  invalidShaRejected = true;
}
check('invalid immutable image SHA is rejected', invalidShaRejected);

let oversizedRejected = false;
try {
  retainHealthResponseBody('x'.repeat(MAX_HEALTH_BODY_CHARS + 1));
} catch {
  oversizedRejected = true;
}
check('unexpectedly large health bodies remain bounded', oversizedRejected);

console.log('\n── GitHub production release ordering ──');
const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
const deployWorkflow = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
check('Cloud Run deploy is triggered from completed CI rather than direct main push',
  deployWorkflow.includes('workflow_run:') &&
  deployWorkflow.includes('workflows: ["CI"]') &&
  deployWorkflow.includes('types: [completed]') &&
  !/\n\s*push:\s*\n\s*branches:\s*\[main\]/.test(deployWorkflow));
check('only successful CI is eligible to enter the deploy gate',
  deployWorkflow.includes("github.event.workflow_run.conclusion == 'success'"));
check('deployment uses the exact CI head SHA as its immutable candidate',
  deployWorkflow.includes('DEPLOY_SHA: ${{ github.event.workflow_run.head_sha }}') &&
  deployWorkflow.includes('APEX_BUILD_SHA="$DEPLOY_SHA"'));
check('stale CI completions cannot overwrite newer main',
  deployWorkflow.includes('git rev-parse origin/main') &&
  deployWorkflow.includes('Skipping stale deploy candidate') &&
  deployWorkflow.includes('Deployment candidate became stale before Cloud Run update'));
check('superseded deployment runs are cancelled rather than queued',
  deployWorkflow.includes('group: deploy-main') && deployWorkflow.includes('cancel-in-progress: true'));
check('production deployment requires explicit APEX_DEPLOY_ENABLED consent',
  deployWorkflow.includes('APEX_DEPLOY_ENABLED') && deployWorkflow.includes('production|all'));
check('health verification compares production to DEPLOY_SHA, not workflow metadata SHA',
  deployWorkflow.includes("expected=os.environ.get('DEPLOY_SHA')"));

console.log(
  failures === 0
    ? '✅ ALL CLOUD RUN DEPLOY PROVENANCE GUARDS PASSED'
    : `❌ ${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
