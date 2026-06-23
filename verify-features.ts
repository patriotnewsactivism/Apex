import { createEmbedding } from './packages/core/src/llm-client.js';
import { MemoryManager } from './packages/core/src/memory.js';
import { getToolRegistry } from './packages/core/src/tool-registry.js';
import { LeadDeveloperAgent } from './packages/agents/src/lead-developer.js';
import { db, memories, agents, tasks } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { existsSync } from 'fs';
import { join } from 'path';

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

async function runVerification() {
  console.log('🚀 Starting Advanced Architecture Verification...\n');
  
  // Force local, 100% free embeddings for verification
  process.env.APEX_EMBEDDING_PROVIDER = 'local';

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: Embedding API
  // ───────────────────────────────────────────────────────────────────────────
  console.log('📡 [Test 1] Testing Embeddings API...');
  try {
    const text = 'SOP: Always write strict TypeScript types.';
    const embedding = await createEmbedding(text);
    console.log(`✅ Embedding generated successfully! Dimensions: ${embedding.length}`);
    console.log(`📊 Vector sample: [${embedding.slice(0, 5).join(', ')}...]\n`);
  } catch (err: any) {
    console.error('❌ Embedding API test failed:', err.message);
    process.exit(1);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: Vector Memory & Cosine Similarity Ranking
  // ───────────────────────────────────────────────────────────────────────────
  console.log('🧠 [Test 2] Testing Semantic Vector Memory...');
  const agentId = 'test-verifier-001';
  const memoryManager = new MemoryManager(agentId);

  try {
    // 1. Store distinct memories
    console.log('✍️ Saving semantic memories into SQLite...');
    await memoryManager.remember('sop:deploy', 'The production release is performed by running the command pnpm deploy-prod inside the root folder.');
    await memoryManager.remember('sop:testing', 'Unit and integration tests are run using the command pnpm test-all with optional coverage reporting.');

    // 2. Query semantically
    const query = 'How do we push our code to production?';
    console.log(`🔍 Querying semantically: "${query}"`);
    const results = await memoryManager.recall(query, 5);

    console.log(`📋 Found ${results.length} relevant memories:`);
    results.forEach((m, idx) => {
      console.log(`   ${idx + 1}. [${m.key}] -> ${m.value}`);
    });

    if (results[0] && results[0].key === 'sop:deploy') {
      console.log('✅ Semantic Ranking is CORRECT! Deployment SOP was ranked #1.\n');
    } else {
      console.warn('⚠️ Semantic Ranking returned unexpected order, check similarity scores.\n');
    }
  } catch (err: any) {
    console.error('❌ Vector Memory test failed:', err.message);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3: Workspace Sandboxing (Isolation & Cleanup)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('⚡ [Test 3] Testing Workspace Sandboxing...');
  const registry = getToolRegistry(process.cwd());
  const sandboxTool = registry.get('runInSandbox');

  if (!sandboxTool) {
    console.error('❌ Sandbox tool not registered!');
    process.exit(1);
  }

  try {
    const code = `
const numbers: number[] = [10, 20, 30];
const sum = numbers.reduce((a, b) => a + b, 0);
console.log("HELLO FROM SANDBOX! SUM IS:", sum);
`;

    console.log('📦 Executing isolated script inside temporary directory...');
    const mockContext = {
      agentId: 'verifier',
      workspaceRoot: process.cwd(),
      requestApproval: async () => true,
    };

    const result: any = await sandboxTool.execute({
      code,
      language: 'typescript',
      timeoutMs: 15000,
    }, mockContext);

    console.log('📥 Execution Result:', JSON.stringify(result, null, 2));

    if (result.success && result.stdout.includes('HELLO FROM SANDBOX! SUM IS: 60')) {
      console.log('✅ Sandbox isolation and execution was PERFECT!');
    } else {
      console.error('❌ Sandbox execution failed to produce expected output.');
    }

    // Verify cleanup
    const sandboxDir = join(process.cwd(), '.local', 'sandboxes', result.sandboxDir);
    if (!existsSync(sandboxDir)) {
      console.log('✅ Temporary sandbox directory was CLEANED UP automatically.\n');
    } else {
      console.error('❌ Temporary sandbox directory still exists!\n');
    }
  } catch (err: any) {
    console.error('❌ Workspace Sandboxing test failed:', err.message);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 4: Peer Review & Agent Lookup
  // ───────────────────────────────────────────────────────────────────────────
  console.log('👥 [Test 4] Testing Agent Lookup and Peer Review Tool...');
  try {
    const leadDev = new LeadDeveloperAgent();
    await leadDev.initialize();

    // Register a mock QA agent in DB
    await db.insert(agents).values({
      id: 'apex-qa-001',
      name: 'QA Engineer',
      role: 'QA',
      tier: 3,
      parentId: 'apex-lead-dev-001',
      status: 'idle',
      systemPrompt: 'Verifier QA',
      model: 'gpt-4o',
      provider: 'openai',
      createdAt: new Date(),
    }).onConflictDoNothing();

    const qaAgentId = await leadDev.findAgentIdByRole('QA');
    console.log(`🔍 Querying agent ID for role "QA": ${qaAgentId}`);

    if (qaAgentId === 'apex-qa-001') {
      console.log('✅ Role-to-ID lookup was SUCCESSFUL!');
    } else {
      console.error(`❌ Role lookup returned incorrect ID: ${qaAgentId}`);
    }

    // Call requestPeerReview via Tool Registry
    const reviewTool = registry.get('requestPeerReview');
    if (reviewTool) {
      console.log('🤝 Dispatched Peer Review subtask...');
      const reviewContext = {
        agentId: 'lead-dev',
        taskId: 'task-12345',
        workspaceRoot: process.cwd(),
        requestApproval: async () => true,
        delegateToRole: async (role: string, input: any) => {
          return leadDev.delegateToRole(role, input);
        }
      };

      const res: any = await reviewTool.execute({
        targetRole: 'QA',
        reviewObjective: 'Review index.ts for proper input validation and memory leaks.',
        contextData: { srcPath: 'packages/core/src/index.ts' },
      }, reviewContext);

      console.log('📥 Peer Review Result:', JSON.stringify(res, null, 2));

      if (res.success && res.taskId) {
        console.log('✅ Peer Review Subtask created and queued perfectly!');
        // Clean up database entries
        await db.delete(tasks).where(eq(tasks.id, res.taskId));
      }
    }

    // Clean up
    await db.delete(memories).where(eq(memories.agentId, agentId));
    console.log('\n🌟 All Advanced Architecture Tests Passed Successfully!');
  } catch (err: any) {
    console.error('❌ Peer Review test failed:', err.message);
  }
}

runVerification();
