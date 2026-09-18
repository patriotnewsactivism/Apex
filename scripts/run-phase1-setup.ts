import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runStep(label: string, cmd: string) {
  console.log(`\n========================================`);
  console.log(`[STEP] ${label}`);
  console.log(`Command: ${cmd}`);
  console.log(`========================================`);
  execSync(cmd, { stdio: 'inherit', cwd: repoRoot });
}

async function main() {
  console.log('Starting Phase 1 & 2 automated setup...');
  console.log(`[Config] Repo root: ${repoRoot}`);

  const envPath = path.join(repoRoot, '.env');
  const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  if (!envContent.includes('APEX_ENCRYPTION_KEY')) {
    const newKey = crypto.randomBytes(32).toString('hex');
    fs.appendFileSync(envPath, `\nAPEX_ENCRYPTION_KEY=${newKey}\n`);
    console.log(`[Config] Generated and appended new APEX_ENCRYPTION_KEY to .env`);
  } else {
    console.log(`[Config] APEX_ENCRYPTION_KEY already present in .env`);
  }

  runStep(
    'Migrate Provider Connections',
    'pnpm --filter @workspace/db exec tsx src/migrate-provider-connections.ts'
  );

  runStep(
    'Migrate Remaining Revenue Ops Tables',
    'pnpm --filter @workspace/db exec tsx src/migrate-revenue-ops-tables.ts'
  );

  runStep(
    'Verify Mission Lifecycle',
    'pnpm --filter @workspace/core exec tsx ../../scripts/verify-mission-lifecycle.ts'
  );

  runStep('Run Production Typecheck', 'pnpm run typecheck');

  runStep('Build Packages & Dashboard', 'pnpm -w run build');

  console.log('\n✓ Phase 1 setup and verification completed successfully.');
}

main().catch((err) => {
  console.error('\n❌ Setup failed:', err);
  process.exit(1);
});
