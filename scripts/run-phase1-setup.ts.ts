import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function runStep(label: string, cmd: string) {
  console.log(`\n========================================`);
  console.log(`[STEP] ${label}`);
  console.log(`Command: ${cmd}`);
  console.log(`========================================`);
  execSync(cmd, { stdio: 'inherit' });
}

async function main() {
  console.log('Starting Phase 1 & 2 automated setup...');

  // 1. Ensure APEX_ENCRYPTION_KEY exists in .env
  const envPath = path.resolve(process.cwd(), '.env');
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  if (!envContent.includes('APEX_ENCRYPTION_KEY')) {
    const newKey = crypto.randomBytes(32).toString('hex');
    fs.appendFileSync(envPath, `\nAPEX_ENCRYPTION_KEY=${newKey}\n`);
    console.log(`[Config] Generated and appended new APEX_ENCRYPTION_KEY to .env`);
  } else {
    console.log(`[Config] APEX_ENCRYPTION_KEY already present in .env`);
  }

  // 2. Database Migrations
  runStep(
    'Migrate Provider Connections',
    'pnpm --filter @workspace/db exec tsx src/migrate-provider-connections.ts'
  );

  runStep(
    'Migrate Remaining Revenue Ops Tables',
    'pnpm --filter @workspace/db exec tsx src/migrate-revenue-ops-tables.ts'
  );

  // 3. Static & Lifecycle Verification
  runStep(
    'Verify Mission Lifecycle',
    'pnpm --filter @workspace/core exec tsx ../../scripts/verify-mission-lifecycle.ts'
  );

  // 4. Typecheck
  runStep('Run Production Typecheck', 'pnpm run typecheck');

  // 5. Dashboard Build
  runStep('Build Packages & Dashboard', 'pnpm run build');

  console.log('\n✓ Phase 1 setup and verification completed successfully.');
}

main().catch((err) => {
  console.error('\n❌ Setup failed:', err);
  process.exit(1);
});