import {
  base44SuperagentConfigured,
  createBase44SuperagentTools,
} from './base44-superagent.js';
import { getToolRegistry as getCoreToolRegistry } from './tool-registry.js';

export * from './tool-registry.js';

let base44Registered = false;

function ensureBase44Registered(workspaceRoot?: string) {
  const registry = getCoreToolRegistry(workspaceRoot);
  if (!base44Registered && base44SuperagentConfigured()) {
    for (const tool of createBase44SuperagentTools()) {
      registry.register(tool);
    }
    base44Registered = true;
  }
  return registry;
}

// APEX agents import BaseAgent from @workspace/core, while BaseAgent itself
// reaches the singleton registry through ./tool-registry.js. Register eagerly
// when the public core barrel is evaluated so those autonomous agents see the
// same Base44 tool even though BaseAgent holds the original registry reference.
ensureBase44Registered();

/**
 * Extends the normal APEX tool registry with the optional Base44 Superagent
 * connector. The credential remains server-side and the tool is exposed only
 * when BASE44_SUPERAGENT_API_KEY is configured.
 */
export function getToolRegistry(workspaceRoot?: string) {
  return ensureBase44Registered(workspaceRoot);
}
