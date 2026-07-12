import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, relative, dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from './types.js';
import { buildMyBotConfigured, createBuildMyBotTools } from './buildmybot-connector.js';

const execAsync = promisify(exec);

// ─── Tool Registry ────────────────────────────────────────────────────────────

class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>) {
    this.tools.set(tool.name, tool as ToolDefinition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getLLMToolSchemas(allowedTools?: string[]) {
    const tools = allowedTools
      ? Array.from(this.tools.values()).filter((t) => allowedTools.includes(t.name))
      : Array.from(this.tools.values());

    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: (t.schema as z.ZodObject<z.ZodRawShape>).shape
        ? zodToJsonSchema(t.schema as z.ZodObject<z.ZodRawShape>)
        : { type: 'object', properties: {} },
    }));
  }

  async execute(name: string, rawArgs: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `Unknown tool: ${name}` };
    }

    // Parse and validate input
    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      return { success: false, error: `Invalid args for ${name}: ${parsed.error.message}` };
    }

    // Approval gate
    if (tool.requiresApproval) {
      const approved = await context.requestApproval(
        name,
        rawArgs,
        `Agent requests to execute tool: ${name}`,
      );
      if (!approved) {
        return { success: false, error: 'Action rejected by user' };
      }
    }

    try {
      const result = await tool.execute(parsed.data, context);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ─── JSON Schema helper (minimal Zod → JSON Schema) ──────────────────────────

function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, val] of Object.entries(shape)) {
    const zodVal = val as z.ZodTypeAny;
    properties[key] = zodTypeToJson(zodVal);
    if (!(zodVal instanceof z.ZodOptional)) {
      required.push(key);
    }
  }

  return { type: 'object', properties, required };
}

function zodTypeToJson(t: z.ZodTypeAny): Record<string, unknown> {
  if (t instanceof z.ZodString) return { type: 'string', description: t.description };
  if (t instanceof z.ZodNumber) return { type: 'number' };
  if (t instanceof z.ZodBoolean) return { type: 'boolean' };
  if (t instanceof z.ZodArray) return { type: 'array', items: zodTypeToJson(t.element) };
  if (t instanceof z.ZodOptional) return zodTypeToJson(t.unwrap());
  if (t instanceof z.ZodEnum) return { type: 'string', enum: t.options };
  if (t instanceof z.ZodObject) return zodToJsonSchema(t);
  return { type: 'string' };
}

// ─── Built-in Tool Definitions ────────────────────────────────────────────────

export function createBuiltinTools(workspaceRoot: string): ToolDefinition[] {
  return [
    // Read File
    {
      name: 'readFile',
      description: 'Read the contents of a file. Path is relative to the workspace root.',
      schema: z.object({
        path: z.string().describe('File path relative to workspace root'),
        startLine: z.number().optional().describe('Start line (1-indexed)'),
        endLine: z.number().optional().describe('End line (1-indexed)'),
      }),
      requiresApproval: false,
      async execute({ path, startLine, endLine }) {
        const abs = resolve(workspaceRoot, path);
        if (!abs.startsWith(workspaceRoot)) throw new Error('Path outside workspace');
        const content = await readFile(abs, 'utf8');
        if (startLine !== undefined || endLine !== undefined) {
          const lines = content.split('\n');
          const sl = (startLine ?? 1) - 1;
          const el = endLine ?? lines.length;
          return lines.slice(sl, el).join('\n');
        }
        return content;
      },
    },

    // Write File
    {
      name: 'writeFile',
      description: 'Write content to a file. Creates parent directories if needed. Path is relative to workspace root.',
      schema: z.object({
        path: z.string().describe('File path relative to workspace root'),
        content: z.string().describe('File content to write'),
        append: z.boolean().optional().describe('Append instead of overwrite'),
      }),
      requiresApproval: true,
      async execute({ path, content, append }, ctx) {
        const abs = resolve(workspaceRoot, path);
        if (!abs.startsWith(workspaceRoot)) throw new Error('Path outside workspace');
        await mkdir(dirname(abs), { recursive: true });
        if (append && existsSync(abs)) {
          const existing = await readFile(abs, 'utf8');
          await writeFile(abs, existing + content, 'utf8');
        } else {
          await writeFile(abs, content, 'utf8');
        }
        return { path: relative(workspaceRoot, abs), written: true };
      },
    },

    // List Directory
    {
      name: 'listDir',
      description: 'List files and directories at the given path. Path is relative to workspace root.',
      schema: z.object({
        path: z.string().describe('Directory path relative to workspace root').optional(),
      }),
      requiresApproval: false,
      async execute({ path: p }) {
        const abs = resolve(workspaceRoot, p ?? '.');
        if (!abs.startsWith(workspaceRoot)) throw new Error('Path outside workspace');
        const entries = await readdir(abs, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
      },
    },

    // Run Shell Command (approval required)
    {
      name: 'runShell',
      description: 'Execute a shell command in the workspace directory. Use with caution.',
      schema: z.object({
        command: z.string().describe('Shell command to run'),
        cwd: z.string().optional().describe('Working directory relative to workspace root'),
        timeoutMs: z.number().optional().describe('Timeout in milliseconds (default 30000)'),
      }),
      requiresApproval: true,
      async execute({ command, cwd, timeoutMs }) {
        const execCwd = cwd ? resolve(workspaceRoot, cwd) : workspaceRoot;
        const { stdout, stderr } = await execAsync(command, {
          cwd: execCwd,
          timeout: timeoutMs ?? 30000,
        });
        return { stdout: stdout.slice(0, 10000), stderr: stderr.slice(0, 2000) };
      },
    },

    // Web Search
    {
      name: 'webSearch',
      description: 'Search the web for information. Returns a summary of results.',
      schema: z.object({
        query: z.string().describe('Search query'),
        maxResults: z.number().optional().describe('Maximum results to return (default 5)'),
      }),
      requiresApproval: false,
      async execute({ query, maxResults }) {
        const n = maxResults ?? 5;
        // Use DuckDuckGo Instant Answer API (no key needed)
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
        const res = await fetch(url);
        const data = await res.json() as Record<string, unknown>;
        const results: Array<{ title: string; url: string; snippet: string }> = [];
        
        if (data.AbstractText) {
          results.push({ title: String(data.AbstractSource ?? 'Result'), url: String(data.AbstractURL ?? ''), snippet: String(data.AbstractText ?? '') });
        }
        const relatedTopics = data.RelatedTopics as Array<{ Text?: string; FirstURL?: string }> ?? [];
        for (const topic of relatedTopics.slice(0, n - 1)) {
          if (topic.Text) {
            results.push({ title: topic.Text.slice(0, 80), url: topic.FirstURL ?? '', snippet: topic.Text });
          }
        }

        return { query, results: results.slice(0, n) };
      },
    },

    // Fetch URL
    {
      name: 'fetchUrl',
      description: 'Fetch the content of a URL and return its text.',
      schema: z.object({
        url: z.string().url().describe('URL to fetch'),
        maxChars: z.number().optional().describe('Max characters to return (default 8000)'),
      }),
      requiresApproval: false,
      async execute({ url, maxChars }) {
        const res = await fetch(url, { headers: { 'User-Agent': 'APEX-Agent/1.0' } });
        const text = await res.text();
        // Strip HTML tags
        const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return { url, content: plain.slice(0, maxChars ?? 8000), status: res.status };
      },
    },

    // Send message to another agent
    {
      name: 'sendMessage',
      description: 'Send a message to another agent for coordination.',
      schema: z.object({
        toAgentId: z.string().describe('ID of the target agent'),
        subject: z.string().describe('Message subject'),
        body: z.string().describe('Message body'),
      }),
      requiresApproval: false,
      async execute({ toAgentId, subject, body }, ctx) {
        // Messages are persisted by the agent's dispatch mechanism
        return { sent: true, fromAgentId: ctx.agentId, toAgentId, subject };
      },
    },

    // Request peer review from another specialized role
    {
      name: 'requestPeerReview',
      description: 'Request another specialized agent role (e.g. QA, DEVOPS, BACKEND) to review code, features, or design and create a subtask for them.',
      schema: z.object({
        targetRole: z.enum(['CEO', 'CTO', 'COO', 'LEAD_DEV', 'FRONTEND', 'BACKEND', 'DEVOPS', 'QA', 'RESEARCH', 'DOCS', 'OPS']).describe('The specialized role requested for peer review'),
        reviewObjective: z.string().describe('Clear objective and instructions explaining what they should review'),
        contextData: z.record(z.any()).optional().describe('Any context variables, directories, or files that the reviewer should know about'),
      }),
      requiresApproval: false,
      async execute({ targetRole, reviewObjective, contextData }, ctx) {
        if (!ctx.delegateToRole) {
          throw new Error('delegateToRole is not supported in this context');
        }
        const taskId = await ctx.delegateToRole(targetRole, {
          title: `Peer Review Request`,
          description: reviewObjective,
          parentTaskId: ctx.taskId,
          context: contextData,
        });
        return { success: true, taskId, targetRole, message: `Review request dispatched to ${targetRole}` };
      },
    },

    // Run Code in Sandbox
    {
      name: 'runInSandbox',
      description: 'Execute TypeScript, JavaScript, Python, or Shell code in an isolated temporary sandbox directory with a strict timeout and automatic cleanup.',
      schema: z.object({
        code: z.string().describe('The code or script content to execute'),
        language: z.enum(['typescript', 'javascript', 'python', 'shell']).describe('The programming language or script type'),
        timeoutMs: z.number().optional().describe('Strict timeout in milliseconds (default: 10000)'),
      }),
      requiresApproval: true,
      async execute({ code, language, timeoutMs }) {
        const { randomUUID } = await import('crypto');
        const uuid = randomUUID();
        const sandboxDir = resolve(workspaceRoot, '.local', 'sandboxes', uuid);
        await mkdir(sandboxDir, { recursive: true });

        let fileName = 'script';
        let command = '';

        if (language === 'typescript') {
          fileName = 'index.ts';
          command = 'npx tsx index.ts';
        } else if (language === 'javascript') {
          fileName = 'index.js';
          command = 'node index.js';
        } else if (language === 'python') {
          fileName = 'index.py';
          command = 'python index.py';
        } else if (language === 'shell') {
          fileName = process.platform === 'win32' ? 'index.bat' : 'index.sh';
          command = process.platform === 'win32' ? 'index.bat' : 'bash index.sh';
        }

        const filePath = join(sandboxDir, fileName);
        await writeFile(filePath, code, 'utf8');

        try {
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);

          const { stdout, stderr } = await execAsync(command, {
            cwd: sandboxDir,
            timeout: timeoutMs ?? 10000,
          });

          return {
            success: true,
            stdout: stdout.slice(0, 5000),
            stderr: stderr.slice(0, 5000),
            exitCode: 0,
            sandboxDir: uuid,
          };
        } catch (err: any) {
          return {
            success: false,
            stdout: err.stdout?.slice(0, 5000) ?? '',
            stderr: err.stderr?.slice(0, 5000) ?? err.message,
            exitCode: err.code ?? 1,
            sandboxDir: uuid,
          };
        } finally {
          try {
            await rm(sandboxDir, { recursive: true, force: true });
          } catch (cleanErr) {
            console.error('Failed to clean up sandbox directory:', cleanErr);
          }
        }
      },
    },
  ];
}

// ─── Singleton registry ───────────────────────────────────────────────────────

let _registry: ToolRegistry | null = null;

export function getToolRegistry(workspaceRoot?: string): ToolRegistry {
  if (!_registry) {
    _registry = new ToolRegistry();
    const root = workspaceRoot ?? process.cwd();
    for (const tool of createBuiltinTools(root)) {
     _registry.register(tool);
    }
    // Portfolio connectors register only when their env is configured, so a
    // bare APEX install never exposes half-working tools to the agents.
    if (buildMyBotConfigured()) {
      for (const tool of createBuildMyBotTools()) {
        _registry.register(tool);
      }
    }
  }
  return _registry;
}

export { ToolRegistry };
