import { config } from 'dotenv';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

config({ path: resolve(process.cwd(), '../../.env') });

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { migrate } from '@workspace/db';
import { createWorkforce, initializeWorkforce, ApexCEO } from '@workspace/agents';
import { setupWebSocket } from './websocket.js';
import { createGoalsRouter } from './routes/goals.js';
import { createTasksRouter } from './routes/tasks.js';
import { createAgentsRouter } from './routes/agents.js';
import { createLogsRouter } from './routes/logs.js';
import { createApprovalsRouter } from './routes/approvals.js';
import { createMemoryRouter } from './routes/memory.js';
import { createToolsRouter } from './routes/tools.js';
import { createAuthRouter } from './routes/auth.js';
import { requireAdminAuth } from './middleware/auth.js';

const PORT = parseInt(process.env.PORT ?? '5000', 10);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  console.log('🚀 APEX starting up...');

  await migrate();
  console.log('✅ Database initialized');

  const approvalRequired = process.env.APEX_APPROVAL_MODE !== 'off';
  const workforce = createWorkforce({ approvalRequired });
  await initializeWorkforce(workforce);
  console.log(`✅ Workforce initialized (${workforce.size} agents)`);

  const ceo = workforce.get('apex-ceo-001') as ApexCEO;

  const app = express();
  const server = createServer(app);

  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', agents: workforce.size, timestamp: Date.now() });
  });

  // Login is the front door — not behind requireAdminAuth.
  app.use('/api/auth', createAuthRouter());

  // Everything else under /api is locked down behind a bearer token.
  app.use('/api', requireAdminAuth);

  // API Routes
  app.use('/api/goals', createGoalsRouter(ceo));
  app.use('/api/tasks', createTasksRouter());
  app.use('/api/agents', createAgentsRouter(workforce));
  app.use('/api/logs', createLogsRouter());
  app.use('/api/approvals', createApprovalsRouter());
  app.use('/api/memory', createMemoryRouter());
  app.use('/api/tools', createToolsRouter());

  // WebSocket
  setupWebSocket(server);

  // Serve dashboard static files if built
  const dashboardDist = resolve(__dirname, '../../dashboard/dist');
  if (existsSync(dashboardDist)) {
    app.use(express.static(dashboardDist));
    app.get('*', (_req, res) => {
      res.sendFile(join(dashboardDist, 'index.html'));
    });
    console.log('✅ Dashboard static files served from:', dashboardDist);
  } else {
    console.log('ℹ️  No dashboard build found — API-only mode');
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ APEX running on http://0.0.0.0:${PORT}`);
    console.log(`✅ WebSocket ready at ws://0.0.0.0:${PORT}/ws`);
    console.log(`🤖 Approval mode: ${approvalRequired ? 'HUMAN APPROVAL REQUIRED' : 'FULLY AUTONOMOUS'}`);
  });

  console.log('🤖 Starting autonomous agent loops...');
  for (const agent of workforce.values()) {
    agent.start().catch((err: Error) => {
      console.error(`Agent ${agent.id} crashed:`, err.message);
    });
  }

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received. Shutting down APEX...`);
    for (const agent of workforce.values()) {
      agent.stop();
    }
    server.close(() => {
      console.log('✅ APEX shut down gracefully');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: Error) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
