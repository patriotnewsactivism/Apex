import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '../../.env') }); // Load from monorepo root
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

const PORT = parseInt(process.env.PORT ?? '5000', 10);

async function main() {
  console.log('🚀 APEX starting up...');

  // ── 1. Initialize Database ─────────────────────────────────────────────────
  await migrate();
  console.log('✅ Database initialized');

  // ── 2. Boot Agent Workforce ────────────────────────────────────────────────
  const approvalRequired = process.env.APEX_APPROVAL_MODE !== 'off';
  const workforce = createWorkforce({ approvalRequired });
  await initializeWorkforce(workforce);
  console.log(`✅ Workforce initialized (${workforce.size} agents)`);

  // Get CEO reference for goal submission
  const ceo = workforce.get('apex-ceo-001') as ApexCEO;

  // ── 3. Start Express ───────────────────────────────────────────────────────
  const app = express();
  const server = createServer(app);

  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', agents: workforce.size, timestamp: Date.now() });
  });

  // API Routes
  app.use('/api/goals', createGoalsRouter(ceo));
  app.use('/api/tasks', createTasksRouter());
  app.use('/api/agents', createAgentsRouter(workforce));
  app.use('/api/logs', createLogsRouter());
  app.use('/api/approvals', createApprovalsRouter());
  app.use('/api/memory', createMemoryRouter());
  app.use('/api/tools', createToolsRouter());

  // ── 4. WebSocket ──────────────────────────────────────────────────────────
  setupWebSocket(server);

  // ── 5. Start Server ───────────────────────────────────────────────────────
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ APEX API server running on http://0.0.0.0:${PORT}`);
    console.log(`✅ WebSocket ready at ws://0.0.0.0:${PORT}/ws`);
  });

  // ── 6. Start Autonomous Loops (non-blocking) ──────────────────────────────
  console.log('🤖 Starting autonomous agent loops...');
  for (const agent of workforce.values()) {
    agent.start().catch((err: Error) => {
      console.error(`Agent ${agent.id} crashed:`, err.message);
    });
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────────
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
