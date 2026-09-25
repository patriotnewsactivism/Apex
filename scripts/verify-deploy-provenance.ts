/** Pure regression checks for the Railway production provenance gate.
 * No Railway or network calls: safe on every CI run. */
import fs from 'node:fs';
import path from 'node:path';
import { checkRetiredHostingInstructions } from './verify-retired-hosting-instructions.js';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures++;
  console.error(`  ❌ ${label}`, detail ?? '');
}

const root = process.env.GITHUB_WORKSPACE ?? process.cwd();

console.log('\n── Railway production provenance ──');

check(
  'obsolete Cloud Run deployment workflow is absent',
  !fs.existsSync(path.join(root, '.github/workflows/deploy.yml')),
);
check(
  'obsolete Cloud Run scaling workflow is absent',
  !fs.existsSync(path.join(root, '.github/workflows/scale-cloud-run.yml')),
);

const railwayToml = fs.readFileSync(path.join(root, 'railway.toml'), 'utf8');
check(
  'Railway builds the repository Dockerfile rather than a detected buildpack',
  /builder\s*=\s*"DOCKERFILE"/.test(railwayToml) &&
    /dockerfilePath\s*=\s*"Dockerfile"/.test(railwayToml),
);
check(
  'Railway gates releases on the production /health endpoint',
  /healthcheckPath\s*=\s*"\/health"/.test(railwayToml),
);


const deploymentToolSource = fs.readFileSync(
  path.join(root, 'packages/core/src/tool-registry.ts'),
  'utf8',
);
const deploymentManagerSource = fs.readFileSync(
  path.join(root, 'packages/cicd-automation/src/deployment-manager.ts'),
  'utf8',
);
const cloudRunDeployerSource = fs.readFileSync(
  path.join(root, 'packages/cicd-automation/src/cloud-run-deployer.ts'),
  'utf8',
);
check(
  'agent-facing deploy tool names Railway as current and Cloud Run as migration-back only',
  /APEX production normally runs on Railway/.test(deploymentToolSource) &&
    /retired Cloud Run service/.test(deploymentToolSource) &&
    /does not roll back current Railway production/.test(deploymentToolSource),
);
check(
  'legacy deployment manager is explicitly migration-back, not ordinary production',
  /APEX production itself runs on Railway/.test(deploymentManagerSource) &&
    /Cloud Run migration-back path/.test(deploymentManagerSource),
);
check(
  'Cloud Run deployer source labels itself as the retired migration-back path',
  /APEX production runs on Railway/.test(cloudRunDeployerSource) &&
    /migration-back\/rollback path/.test(cloudRunDeployerSource),
);

const runtimeHealth = fs.readFileSync(
  path.join(root, 'packages/core/src/runtime-health.ts'),
  'utf8',
);
check(
  'the running commit is recoverable from /health on Railway',
  /process\.env\.APEX_BUILD_SHA \|\| process\.env\.RAILWAY_GIT_COMMIT_SHA \|\| 'unknown'/.test(
    runtimeHealth,
  ),
);
check(
  'an explicit build SHA still outranks the Railway inferred SHA',
  runtimeHealth.indexOf('APEX_BUILD_SHA') < runtimeHealth.indexOf('RAILWAY_GIT_COMMIT_SHA'),
);

console.log('\n── Runtime image ABI ──');

const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const stageBases = [...dockerfile.matchAll(/^FROM\s+(\S+)\s+AS\s+(\S+)/gm)].map((m) => ({
  image: m[1],
  stage: m[2],
}));
const builderBase = stageBases.find((entry) => entry.stage === 'builder')?.image;
const runtimeBase = stageBases.find((entry) => entry.stage === 'runtime')?.image;
check(
  'the runtime stage shares the builder base image so native modules keep their libc',
  Boolean(builderBase) && builderBase === runtimeBase,
  { builderBase, runtimeBase },
);
const usesAlpineBase = /alpine/i.test(runtimeBase ?? '');
check(
  'the Dockerfile package manager matches its base distro',
  usesAlpineBase ? !/\bapt-get\b/.test(dockerfile) : !/\bapk\s+add\b/.test(dockerfile),
  { runtimeBase, usesApk: /\bapk\s+add\b/.test(dockerfile), usesApt: /\bapt-get\b/.test(dockerfile) },
);

console.log('\n── GitHub CI release gate ──');

const ciWorkflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
check(
  'production-checks exists as the Railway Wait-for-CI release gate',
  /^\s*production-checks:\s*$/m.test(ciWorkflow),
);
check(
  'schema drift guard runs before production typecheck',
  ciWorkflow.includes('Verify schema changes include migrations') &&
    ciWorkflow.indexOf('Verify schema changes include migrations') <
      ciWorkflow.indexOf('Typecheck production runtime'),
);
check(
  'CI builds the production runtime image',
  /docker\/build-push-action/.test(ciWorkflow) && /^\s+target:\s*runtime\s*$/m.test(ciWorkflow),
);
check(
  'the built image is smoke-tested for libc, onnxruntime, sharp and chromium',
  /ld-linux-x86-64\.so\.2/.test(ciWorkflow) &&
    /libonnxruntime\.so/.test(ciWorkflow) &&
    /sharp-.*\.node/.test(ciWorkflow) &&
    /chromium/.test(ciWorkflow),
);

console.log('\n── Vercel dashboard provenance ──');

const vercelConfig = JSON.parse(
  fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'),
) as {
  buildCommand?: unknown;
  installCommand?: unknown;
  outputDirectory?: unknown;
  framework?: unknown;
};
const vercelBuild =
  typeof vercelConfig.buildCommand === 'string' ? vercelConfig.buildCommand : '';
check(
  'Vercel builds only @workspace/dashboard, not the backend',
  vercelBuild.includes('@workspace/dashboard') &&
    vercelBuild.includes('run build') &&
    !vercelBuild.includes('typecheck:production') &&
    !/^\s*pnpm(?:\s+run)?\s+build\s*$/.test(vercelBuild),
  { buildCommand: vercelConfig.buildCommand },
);
check(
  'Vercel output is the dashboard dist',
  vercelConfig.outputDirectory === 'packages/dashboard/dist',
  { outputDirectory: vercelConfig.outputDirectory },
);
check(
  'Vercel install is frozen to the committed lockfile',
  typeof vercelConfig.installCommand === 'string' &&
    vercelConfig.installCommand.includes('pnpm install') &&
    vercelConfig.installCommand.includes('--frozen-lockfile'),
  { installCommand: vercelConfig.installCommand },
);
check('Vercel framework is Vite', vercelConfig.framework === 'vite', {
  framework: vercelConfig.framework,
});

failures += checkRetiredHostingInstructions();

console.log(
  failures === 0
    ? '✅ ALL RAILWAY DEPLOY PROVENANCE GUARDS PASSED'
    : `❌ ${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
