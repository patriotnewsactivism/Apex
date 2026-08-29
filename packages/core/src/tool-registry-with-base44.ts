import {
  base44SuperagentConfigured,
  createBase44SuperagentTools,
} from './base44-superagent.js';
import { getToolRegistry as getCoreToolRegistry } from './tool-registry.js';

export * from './tool-registry.js';

let base44Registered = false;

/**
 * Extends the normal APEX tool registry with the optional Base44 Superagent
 * connector. The credential remains server-side and the tools are exposed only
 * when BASE44_SUPERAGENT_API_KEY is configured.
 */
export function getToolRegistry(workspaceRoot?: string) {
  const registry = getCoreToolRegistry(workspaceRoot);
  if (!base44Registered && base44SuperagentConfigured()) {
    for (const tool of createBase44SuperagentTools()) {
      registry.register(tool);
    }
    base44Registered = true;
  }
  return registry;
}
