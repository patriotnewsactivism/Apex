/**
 * Apex Core — Hello World Agent Hierarchy
 * 
 * A minimal example showing the CEO/CTO/Specialist hierarchy.
 * Run: npx tsx examples/hello-world.ts
 */

import { BaseAgent, emitApexEvent, apexEventBus } from '@workspace/core';

// Listen to all events
apexEventBus.on('event', (event) => {
  console.log(`[${event.type}] ${event.message || ''}`);
});

// ── Specialist Agent ─────────────────────────────────────────────
class GreeterAgent extends BaseAgent {
  readonly id = 'greeter';
  readonly role = 'Specialist';
  readonly capabilities = ['greeting'];

  async execute(input: { name: string }): Promise<string> {
    emitApexEvent({ type: 'task:started', agentId: this.id, message: `Greeting ${input.name}` });
    return `Hello, ${input.name}! Welcome to Apex.`;
  }
}

// ── CTO Agent (delegates to specialists) ────────────────────────
class CTOAgent extends BaseAgent {
  readonly id = 'cto';
  readonly role = 'CTO';
  readonly capabilities = ['delegate'];
  private greeter = new GreeterAgent();

  async execute(input: { name: string }): Promise<string> {
    emitApexEvent({ type: 'task:delegated', agentId: this.id, message: `Delegating greeting to specialist` });
    return this.greeter.execute(input);
  }
}

// ── CEO Agent (top of hierarchy) ─────────────────────────────────
class CEOAgent extends BaseAgent {
  readonly id = 'ceo';
  readonly role = 'CEO';
  readonly capabilities = ['plan', 'delegate'];
  private cto = new CTOAgent();

  async execute(input: { name: string }): Promise<string> {
    emitApexEvent({ type: 'goal:created', agentId: this.id, message: `Goal: Greet ${input.name}` });
    emitApexEvent({ type: 'task:delegated', agentId: this.id, message: `Delegating to CTO` });
    return this.cto.execute(input);
  }
}

// ── Run the hierarchy ───────────────────────────────────────────
async function main() {
  const ceo = new CEOAgent();
  console.log('Starting Apex Hello World...\n');
  
  const result = await ceo.execute({ name: 'World' });
  console.log(`\nResult: ${result}`);
  console.log('\nHierarchy: CEO → CTO → Specialist (Greeter)');
}

main().catch(console.error);
