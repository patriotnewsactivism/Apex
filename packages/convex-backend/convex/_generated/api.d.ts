/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentConfigs from "../agentConfigs.js";
import type * as agentLoop from "../agentLoop.js";
import type * as agents from "../agents.js";
import type * as approvals from "../approvals.js";
import type * as bootstrap from "../bootstrap.js";
import type * as cicd from "../cicd.js";
import type * as crons from "../crons.js";
import type * as goals from "../goals.js";
import type * as health from "../health.js";
import type * as jobHandlers from "../jobHandlers.js";
import type * as learning from "../learning.js";
import type * as llm from "../llm.js";
import type * as llmConfig from "../llmConfig.js";
import type * as logs from "../logs.js";
import type * as memories from "../memories.js";
import type * as messages from "../messages.js";
import type * as projects from "../projects.js";
import type * as scheduledJobs from "../scheduledJobs.js";
import type * as taskRuns from "../taskRuns.js";
import type * as tasks from "../tasks.js";
import type * as toolRegistry from "../toolRegistry.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentConfigs: typeof agentConfigs;
  agentLoop: typeof agentLoop;
  agents: typeof agents;
  approvals: typeof approvals;
  bootstrap: typeof bootstrap;
  cicd: typeof cicd;
  crons: typeof crons;
  goals: typeof goals;
  health: typeof health;
  jobHandlers: typeof jobHandlers;
  learning: typeof learning;
  llm: typeof llm;
  llmConfig: typeof llmConfig;
  logs: typeof logs;
  memories: typeof memories;
  messages: typeof messages;
  projects: typeof projects;
  scheduledJobs: typeof scheduledJobs;
  taskRuns: typeof taskRuns;
  tasks: typeof tasks;
  toolRegistry: typeof toolRegistry;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
