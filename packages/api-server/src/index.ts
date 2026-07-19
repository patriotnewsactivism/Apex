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
import { createProjectsRouter } from './routes/projects.js';
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

  // APEX_APPROVAL_MODE controls the GLOBAL override only:
  //   'strict' -> force approvalRequired=true on every agent (lockdown mode)
  //   'off'    -> force approvalRequired=false on every agent (fully autonomous, use with care)
  //   unset/anything else -> DON'T override -- each agent uses its own
  //     class-level default (see packages/agents/src/*.ts). This is the
  //     sane default: dev-branch agents (Frontend/Backend/DevOps/QA) that
  //     write code/run shell/deploy stay gated per Don's standing
  //     "no unilateral irreversible actions" rule, while CEO/CTO/COO and
  //     the business agents (Lead Research/Sales/Customer Success) that
  //     only do safe read/research/save-data actions run autonomously,
  //     as they were originally designed to. Marketing stays gated
  //     (drafts before publish).
  //
  // Fixed 2026-07-18: this used to unconditionally force EVERY agent to
  // approvalRequired=true whenever APEX_APPROVAL_MODE wasn't literally
  // 'off', silently overriding business agents' own approvalRequired:false
  // and inflating Don's manual-approval click volume for actions that were
  // never meant to need a human in the loop.
  const mode = process.env.APEX_APPROVAL_MODE;
  const approvalRequired = mode === 'strict' ? true : mode === 'off' ? false : undefined;
  const workforce = createWorkforce({ approvalRequired });
  await initializeWorkforce(workforce);
  console.log(`✅ Workforce initialized (${workforce.size} agents)`);
  console.log(`   Approval mode: ${mode === 'strict' ? 'STRICT (all agents gated)' : mode === 'off' ? 'FULLY AUTONOMOUS (no gating)' : 'PER-ROLE DEFAULT (dev/infra gated, business/orchestration autonomous)'}`);

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
  app.use('/api/projects', createProjectsRouter());
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
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(join(dashboardDist, 'index.html'));
    });
    console.log('✅ Dashboard static files served from:', dashboardDist);
  } else {
    console.log('ℹ️  No dashboard build found — API-only mode');
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ APEX running on http://0.0.0.0:${PORT}`);
    console.log(`✅ WebSocket ready at ws://0.0.0.0:${PORT}/ws`);
    console.log(`🤖 Approval mode: ${mode === 'strict' ? 'HUMAN APPROVAL REQUIRED (strict)' : mode === 'off' ? 'FULLY AUTONOMOUS' : 'PER-ROLE DEFAULT'}`);
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
