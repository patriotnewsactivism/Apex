/** Pure regression checks for the Lightsail health/provenance gate. No AWS or
 * network calls: safe to run on every pull request. */
import {
  MAX_HEALTH_BODY_CHARS,
  immutableImageRef,
  retainHealthResponseBody,
} from '../packages/cicd-automation/src/lightsail-deployer.js';

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

check('fixture proves the old 500-character truncation boundary', expandedHealth.length > 500);
const retained = retainHealthResponseBody(expandedHealth);
check('complete health JSON is retained for provenance parsing', retained === expandedHealth);
let runningSha: unknown;
try {
  runningSha = (JSON.parse(retained) as { build?: { sha?: unknown } }).build?.sha;
} catch (error) {
  console.error(error);
}
check('expanded health response preserves the expected live commit', runningSha === expectedSha);
check(
  'mutable latest image is rewritten to the immutable short SHA tag',
  immutableImageRef('535203103662.dkr.ecr.us-east-1.amazonaws.com/apex:latest', expectedSha) ===
    '535203103662.dkr.ecr.us-east-1.amazonaws.com/apex:289c8ce52d2d',
);
check(
  'digest image is rewritten to the immutable short SHA tag',
  immutableImageRef(
    '535203103662.dkr.ecr.us-east-1.amazonaws.com/apex@sha256:' + 'a'.repeat(64),
    expectedSha,
  ) === '535203103662.dkr.ecr.us-east-1.amazonaws.com/apex:289c8ce52d2d',
);
check(
  'untagged image receives the immutable short SHA tag',
  immutableImageRef('example/apex', expectedSha) === 'example/apex:289c8ce52d2d',
);

let invalidShaRejected = false;
try {
  immutableImageRef('example/apex:latest', 'not-a-sha');
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

console.log(
  failures === 0
    ? '✅ ALL DEPLOY PROVENANCE GUARDS PASSED'
    : `❌ ${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
