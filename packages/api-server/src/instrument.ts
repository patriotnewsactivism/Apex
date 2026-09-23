import { config } from 'dotenv';
import { resolve } from 'path';
import * as Sentry from '@sentry/node';

// ESM evaluates this module before index.ts's body, so dotenv has to run here
// for a .env SENTRY_DSN to be visible at init. Railway injects the variable
// into the process environment and does not need the file.
config({ path: resolve(process.cwd(), '.env') });

const dsn = process.env.SENTRY_DSN?.trim() ?? '';

// Missing or empty DSN is a no-op so local and CI boots still start.
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
  });
}
