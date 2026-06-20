import { defineConfig } from 'drizzle-kit';

import { join } from 'path';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: `file:${join(process.cwd(), '../../.local/apex.db')}`,
  },
});
