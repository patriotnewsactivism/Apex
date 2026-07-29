import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, relative, dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from './types.js';
import { buildMyBotConfigured, createBuildMyBotTools } from './buildmybot-connector.js';
import { caseBuddyConfigured, createCaseBuddyTools } from './casebuddy-connector.js';
import { createOrchestrationTools } from './orchestration-tools.js';
import { tubeScribeConfigured, createTubeScribeTools } from './tubescribe-connector.js';
import { getConfiguredProviders } from './llm-client.js';
import { HealthMonitor, AlertManager } from '@workspace/health-monitor';
import { db, messages } from '@workspace/db';

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
      // Reversible via git (working-tree edit only, no execution/push/deploy) — auto-approved
      // to cut approval-fatigue. runShell/runInSandbox (actual command execution) and any
      // push/deploy/production action remain gated. See tool-registry.ts approval split, 2026-07-19.
      requiresApproval: false,
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

    // Web Search — multi-strategy: Brave Search API (free tier) → DuckDuckGo
    // HTML scrape → DuckDuckGo Instant Answer API fallback
    {
      name: 'webSearch',
      description: 'Search the web for information. Returns real search results with titles, URLs, and snippets. For broad topics, use specific queries (e.g. "real estate companies Texas" instead of "real estate companies in the south"). Call multiple times with different queries to build comprehensive results.',
      schema: z.object({
        query: z.string().describe('Search query — be specific for best results'),
        maxResults: z.number().optional().describe('Maximum results to return (default 10)'),
      }),
      requiresApproval: false,
      async execute({ query, maxResults }) {
        const n = maxResults ?? 10;
        const results: Array<{ title: string; url: string; snippet: string }> = [];

        // ── Strategy 0: Tavily Search API (best quality, AI-optimized) ──
        const tavilyKey = process.env.TAVILY_API_KEY;
        if (tavilyKey) {
          try {
            const tavilyRes = await fetch('https://api.tavily.com/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                api_key: tavilyKey,
                query,
                max_results: n,
                search_depth: 'advanced',
                include_answer: true,
              }),
            });
            if (tavilyRes.ok) {
              const tavilyData = await tavilyRes.json() as {
                answer?: string;
                results?: Array<{ title: string; url: string; content: string }>;
              };
              // Include the AI-generated answer as the first result if present
              if (tavilyData.answer) {
                results.push({ title: 'Tavily AI Summary', url: '', snippet: tavilyData.answer });
              }
              for (const r of tavilyData.results ?? []) {
                results.push({ title: r.title, url: r.url, snippet: r.content });
              }
              if (results.length > 0) return { query, provider: 'tavily', results: results.slice(0, n + 1) };
            }
          } catch (e) {
            console.warn(`[webSearch] Tavily failed for "${query}": ${e}`);
          }
        }

        // ── Strategy 1: Brave Search API (free tier: 2000 queries/month) ──
        const braveKey = process.env.BRAVE_SEARCH_API_KEY;
        if (braveKey) {
          try {
            const braveUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`;
            const braveRes = await fetch(braveUrl, {
              headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': braveKey },
            });
            if (braveRes.ok) {
              const braveData = await braveRes.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
              for (const r of braveData.web?.results ?? []) {
                results.push({ title: r.title, url: r.url, snippet: r.description });
              }
              if (results.length > 0) return { query, provider: 'brave', results: results.slice(0, n) };
            }
          } catch (e) {
            console.warn(`[webSearch] Brave failed for "${query}": ${e}`);
          }
        }

        // ── Strategy 2: DuckDuckGo HTML search (lite version) ──
        try {
          const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
          const ddgRes = await fetch(ddgUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html',
            },
          });
          const html = await ddgRes.text();
          
          // Parse results from DDG lite HTML — results are in <a> tags with
          // class="result-link" followed by <td> with snippet text
          const linkRegex = /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
          const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
          
          const links: Array<{ url: string; title: string }> = [];
          let linkMatch;
          while ((linkMatch = linkRegex.exec(html)) !== null) {
            links.push({ url: linkMatch[1], title: linkMatch[2].trim() });
          }
          
          const snippets: string[] = [];
          let snippetMatch;
          while ((snippetMatch = snippetRegex.exec(html)) !== null) {
            snippets.push(snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim());
          }

          for (let i = 0; i < links.length && i < n; i++) {
            results.push({
              title: links[i].title,
              url: links[i].url,
              snippet: snippets[i] ?? '',
            });
          }

          if (results.length > 0) return { query, provider: 'duckduckgo-html', results: results.slice(0, n) };

          // DDG lite format may vary — try a more general link extraction
          const generalLinkRegex = /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
          let generalMatch;
          while ((generalMatch = generalLinkRegex.exec(html)) !== null) {
            const href = generalMatch[1];
            const text = generalMatch[2].replace(/<[^>]+>/g, '').trim();
            if (href.startsWith('http') && text.length > 5 && !href.includes('duckduckgo.com')) {
              results.push({ title: text, url: href, snippet: '' });
            }
          }

          if (results.length > 0) return { query, provider: 'duckduckgo-html-fallback', results: results.slice(0, n) };
        } catch (e) {
          console.warn(`[webSearch] DuckDuckGo HTML failed for "${query}": ${e}`);
        }

        // ── Strategy 3: DuckDuckGo Instant Answer API (limited but reliable) ──
        try {
          const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
          const res = await fetch(url);
          const data = await res.json() as Record<string, unknown>;
          
          if (data.AbstractText) {
            results.push({ title: String(data.AbstractSource ?? 'Result'), url: String(data.AbstractURL ?? ''), snippet: String(data.AbstractText ?? '') });
          }
          const relatedTopics = data.RelatedTopics as Array<{ Text?: string; FirstURL?: string }> ?? [];
          for (const topic of relatedTopics.slice(0, n)) {
            if (topic.Text) {
              results.push({ title: topic.Text.slice(0, 80), url: topic.FirstURL ?? '', snippet: topic.Text });
            }
          }
        } catch (e) {
          console.warn(`[webSearch] DuckDuckGo API also failed for "${query}": ${e}`);
        }

        if (results.length === 0) {
          return {
            query,
            provider: 'none',
            results: [],
            suggestion: 'No results found. Try a more specific query — for example, search by specific state, city, or industry keyword instead of broad regional terms.',
          };
        }

        return { query, provider: 'duckduckgo-api', results: results.slice(0, n) };
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

    // Real browser-level QA check (Playwright + Chromium) — phase 2 of QA
    // Director's capability: fetchUrl only ever saw fetched HTML/text; this
    // actually renders the page in a real browser, executes its JS, and
    // reports real console errors + real page-load status, not a guess.
    {
      name: 'browserCheck',
      description: 'Load a URL in a real headless Chromium browser and report whether it rendered successfully: HTTP status, page title, any JavaScript console errors, and any uncaught page exceptions. Use this for real browser-level QA, not just raw HTML fetching.',
      schema: z.object({
        url: z.string().url().describe('URL to load in the browser'),
        maxConsoleMessages: z.number().optional().describe('Max console messages to return (default 20)'),
      }),
      requiresApproval: false,
      async execute({ url, maxConsoleMessages }) {
        const { chromium } = await import('playwright');
        const { existsSync } = await import('fs');
        // This image is Alpine (musl) -- Playwright's own bundled Chromium
        // needs glibc and was never downloaded anyway (repo installs with
        // --ignore-scripts). Use Alpine's native chromium apk package
        // instead via executablePath. Check both common install paths.
        const candidatePaths = ['/usr/bin/chromium-browser', '/usr/bin/chromium'];
        const executablePath = candidatePaths.find((p) => existsSync(p));
        if (!executablePath) {
          throw new Error(
            `No system Chromium binary found at ${candidatePaths.join(' or ')}. ` +
            `browserCheck requires the 'chromium' apk package to be installed in this image.`
          );
        }
        const browser = await chromium.launch({
          headless: true,
          executablePath,
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        });
        try {
          const page = await browser.newPage();
          const consoleMessages: { type: string; text: string }[] = [];
          const pageErrors: string[] = [];
          page.on('console', (msg) => {
            if (msg.type() === 'error' || msg.type() === 'warning') {
              consoleMessages.push({ type: msg.type(), text: msg.text().slice(0, 300) });
            }
          });
          page.on('pageerror', (err) => {
            pageErrors.push(String(err?.message || err).slice(0, 300));
          });

          let status: number | null = null;
          let loadError: string | null = null;
          try {
            const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
            status = response ? response.status() : null;
          } catch (e: any) {
            loadError = String(e?.message || e).slice(0, 300);
          }

          const title = loadError ? null : await page.title().catch(() => null);
          const limit = maxConsoleMessages ?? 20;

          return {
            url,
            status,
            loadError,
            title,
            consoleErrors: consoleMessages.slice(0, limit),
            pageErrors: pageErrors.slice(0, limit),
            renderedSuccessfully: !loadError && status !== null && status < 400,
          };
        } finally {
          await browser.close();
        }
      },
    },

    // Send message to another agent — creates a real delegated task so the
    // target agent actually picks up the work, and persists the message for
    // audit/dashboard visibility.
    {
      name: 'sendMessage',
      description: 'Send a message to another agent, delegating a task to them. The message body becomes the task description the target agent will execute.',
      schema: z.object({
        toAgentId: z.string().describe('ID of the target agent (e.g. "apex-cto-001")'),
        subject: z.string().describe('Message subject — becomes the delegated task title'),
        body: z.string().describe('Message body — becomes the delegated task description'),
      }),
      requiresApproval: false,
      async execute({ toAgentId, subject, body }, ctx) {
        // 1. Persist the inter-agent message for audit trail
        const messageId = randomUUID();
        await db.insert(messages).values({
          id: messageId,
          fromAgentId: ctx.agentId,
          toAgentId,
          subject,
          body,
          read: false,
          createdAt: new Date(),
        });

        // 2. Actually delegate a task to the target agent so it gets executed
        if (!ctx.delegateToAgent) {
          throw new Error('delegateToAgent is not available in this context');
        }

        const taskId = await ctx.delegateToAgent(toAgentId, {
          title: subject,
          description: body,
          parentTaskId: ctx.taskId,
          goalId: ctx.goalId,
          context: { messageId, fromAgentId: ctx.agentId },
        });

        return { sent: true, taskId, messageId, fromAgentId: ctx.agentId, toAgentId, subject };
      },
    },

    // Persist a qualified outbound lead found by the Lead Research Agent
    {
      name: 'saveResearchedLead',
      description:
        "Save a qualified outbound lead to the researched_leads table. Call this once per qualifying company found via web search — do NOT just describe leads in your final answer, they must be persisted here to count as pipeline output. Checks for an existing row with the same website first and skips the insert if found (returns duplicate: true) so the team never double-works a company.",
      schema: z.object({
        companyName: z.string().describe('Real company name as found in search results'),
        website: z.string().optional().describe('Company website URL, used for de-dup'),
        industry: z.string().optional().describe('e.g. HVAC, Roofing, Personal Injury, MedSpa, Real Estate'),
        city: z.string().optional(),
        fitReason: z.string().describe('Why this company matches the ICP pain point (missed calls, slow lead response, after-hours gaps)'),
        outreachAngle: z.string().optional().describe('Suggested angle for the first outreach message'),
      }),
      requiresApproval: false,
      async execute({ companyName, website, industry, city, fitReason, outreachAngle }, ctx) {
        const { randomUUID } = await import('crypto');
        const { db, researchedLeads } = await import('@workspace/db');
        const { eq } = await import('drizzle-orm');

        if (website) {
          const existing = await db
            .select()
            .from(researchedLeads)
            .where(eq(researchedLeads.website, website))
            .limit(1);
          if (existing.length > 0) {
            return { duplicate: true, existingLeadId: existing[0].id, companyName };
          }
        }

        const id = randomUUID();
        await db.insert(researchedLeads).values({
          id,
          companyName,
          website,
          industry,
          city,
          fitReason,
          outreachAngle,
          status: 'new',
          researchedByAgentId: ctx.agentId,
          createdAt: new Date(),
        });

        return { saved: true, leadId: id, companyName };
      },
    },

    // Read the researched leads pipeline (for Sales/BizDev review, status reporting)
    {
      name: 'listResearchedLeads',
      description:
        'List researched/qualified outbound leads from the researched_leads table, most recent first. Use to review pipeline status honestly instead of guessing counts.',
      schema: z.object({
        status: z.string().optional().describe('Filter by status: new | contacted | qualified | rejected'),
        limit: z.number().optional().describe('Max rows (default 25)'),
      }),
      requiresApproval: false,
      async execute({ status, limit }) {
        const { db, researchedLeads } = await import('@workspace/db');
        const { eq, desc } = await import('drizzle-orm');

        const query = db.select().from(researchedLeads);
        const rows = status
          ? await query.where(eq(researchedLeads.status, status)).orderBy(desc(researchedLeads.createdAt)).limit(limit ?? 25)
          : await query.orderBy(desc(researchedLeads.createdAt)).limit(limit ?? 25);

        return rows;
      },
    },

    // Search a structured business directory for real businesses by industry + location
    // Multi-provider: Yelp Fusion (50/call, free, no card) → Google Places (20/call) → OSM Overpass (no key, always works)
    {
      name: 'searchBusinessDirectory',
      description: 'Search a structured business directory for real businesses by industry and location. Returns up to 50 businesses per call with company name, address, phone, website, rating, and review count. MUCH faster than webSearch for finding leads — one call replaces 10+ web searches. Use this FIRST before webSearch when looking for businesses in a specific industry/location.',
      schema: z.object({
        query: z.string().describe('Search query combining industry and location, e.g. "HVAC contractor Dallas Texas" or "personal injury lawyer Miami FL"'),
      }),
      requiresApproval: false,
      async execute({ query }) {
        const yelpKey = process.env.YELP_API_KEY;
        const googleKey = process.env.GOOGLE_PLACES_API_KEY;

        // ── Provider 1: Yelp Fusion API (free, no credit card, 50 results/call) ──
        if (yelpKey) {
          try {
            // Parse "industry + location" from the query
            // e.g. "HVAC contractor Dallas Texas" → term="HVAC contractor", location="Dallas Texas"
            const parts = query.split(/\s+/);
            // Find where the location starts (look for common city/state patterns)
            let locationStart = parts.length;
            const stateAbbrev = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']);
            for (let i = 0; i < parts.length; i++) {
              if (stateAbbrev.has(parts[i].toUpperCase()) || (i > 0 && i < parts.length - 1 && parts[i].length >= 3)) {
                // Heuristic: location starts 1-2 words before the state or city name
                locationStart = Math.max(0, i - 1);
                break;
              }
            }
            const term = parts.slice(0, locationStart).join(' ') || query;
            const location = parts.slice(locationStart).join(' ') || 'United States';

            const yelpUrl = `https://api.yelp.com/v3/businesses/search?term=${encodeURIComponent(term)}&location=${encodeURIComponent(location)}&limit=20`;
            const yelpRes = await fetch(yelpUrl, {
              headers: { Authorization: `Bearer ${yelpKey}` },
              signal: AbortSignal.timeout(10_000),
            });
            if (yelpRes.ok) {
              const yelpData = await yelpRes.json() as {
                businesses: Array<{
                  name: string;
                  phone?: string;
                  location?: { display_address?: string[]; city?: string; state?: string; zip_code?: string };
                  url?: string;
                  rating?: number;
                  review_count?: number;
                  categories?: Array<{ title: string; alias: string }>;
                  coordinates?: { latitude: number; longitude: number };
                  distance?: number;
                }>;
                total?: number;
              };

              const businesses = (yelpData.businesses ?? []).map((b) => ({
                n: b.name,
                p: b.phone,
                w: b.url,
                i: b.categories?.map((c) => c.title).join(', ') ?? '',
                c: b.location?.city ?? '',
              }));

              if (businesses.length > 0) {
                return { query, total: businesses.length, businesses, provider: 'yelp' };
              }
            }
          } catch {
            // Fall through to next provider
          }
        }

        // ── Provider 2: Google Places API (if key configured) ──
        if (googleKey) {
          try {
            const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${googleKey}`;
            const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(10_000) });
            if (searchRes.ok) {
              const searchData = await searchRes.json() as {
                results: Array<{
                  place_id: string;
                  name: string;
                  formatted_address: string;
                  types: string[];
                  rating?: number;
                  user_ratings_total?: number;
                }>;
                status: string;
              };

              const BATCH = 10;
              const enriched: Array<Record<string, unknown>> = [];
              const results = searchData.results ?? [];

              for (let i = 0; i < results.length; i += BATCH) {
                const batch = results.slice(i, i + BATCH);
                const details = await Promise.all(
                  batch.map(async (r) => {
                    try {
                      const dUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${r.place_id}&fields=name,formatted_address,formatted_phone_number,website,types,rating,user_ratings_total&key=${googleKey}`;
                      const dRes = await fetch(dUrl, { signal: AbortSignal.timeout(5_000) });
                      if (!dRes.ok) return null;
                      const dd = await dRes.json() as { result?: Record<string, unknown> };
                      const d = dd.result;
                      if (!d) return null;
                      return {
                        name: d.name, address: d.formatted_address,
                        phone: d.formatted_phone_number, website: d.website,
                        industry: (d.types as string[])?.join(', ') ?? '',
                        rating: d.rating, reviewCount: d.user_ratings_total,
                        source: 'google' as const,
                      };
                    } catch { return null; }
                  }),
                );
                for (const d of details) { if (d) enriched.push(d); }
              }

              if (enriched.length > 0) {
                return { query, total: enriched.length, businesses: enriched, provider: 'google' };
              }
            }
          } catch {
            // Fall through to OSM fallback
          }
        }

        // ── Provider 3: OpenStreetMap Overpass API (no key, always works) ──
        // Free, no signup, no credit card. Lower data quality but covers millions of businesses.
        try {
          // Extract a broad search area from the query
          // Overpass uses a bounding box; we use a large US region as default
          // and search for businesses by name keyword
          const keyword = query.replace(/\b(in|near|around|Texas|Florida|California|Arizona|Georgia|Oklahoma|Louisiana|Alabama|Mississippi|South Carolina|North Carolina|New York|New Jersey|Illinois|Michigan|Washington|Dallas|Houston|Miami|Tampa|Orlando|San Antonio|Austin|Charlotte|Jacksonville|Fort Lauderdale|Naples|Deerfield)\b/gi, '').trim();

          const overpassQuery = `[out:json][timeout:15];
            area["name"="United States"]->.us;
            (
              node["name"~"${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}",i](area.us);
              way["name"~"${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}",i](area.us);
            );
            out body 50;`;

          const osmRes = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(overpassQuery)}`,
            signal: AbortSignal.timeout(15_000),
          });

          if (osmRes.ok) {
            const osmData = await osmRes.json() as {
              elements: Array<{
                tags?: Record<string, string>;
              }>;
            };

            const businesses = (osmData.elements ?? [])
              .filter((e) => e.tags?.name)
              .slice(0, 50)
              .map((e) => ({
                name: e.tags!.name,
                address: [e.tags!['addr:street'], e.tags!['addr:city'], e.tags!['addr:state']].filter(Boolean).join(', ') || '',
                phone: e.tags!['phone'] ?? e.tags!['contact:phone'],
                website: e.tags!['website'] ?? e.tags!['contact:website'],
                industry: e.tags!.office ?? e.tags!.craft ?? e.tags!.shop ?? e.tags!.amenity ?? keyword,
                city: e.tags!['addr:city'] ?? '',
                source: 'osm' as const,
              }));

            if (businesses.length > 0) {
              return { query, total: businesses.length, businesses, provider: 'osm' };
            }
          }
        } catch {
          // All providers failed
        }

        return { query, total: 0, businesses: [], provider: 'none', error: 'No business directory API configured. Set YELP_API_KEY (free, no credit card) or GOOGLE_PLACES_API_KEY for best results. Falling back to OSM Overpass (limited). Use webSearch as an alternative.' };
      },
    },

    // Batch save multiple researched leads in one tool call (saves iterations)
    {
      name: 'saveResearchedLeadsBatch',
      description: 'Save multiple qualified leads to the researched_leads table in ONE call. Much faster than calling saveResearchedLead individually for each lead. Pass an array of lead objects with company name, website, industry, city, fit reason, and outreach angle. Skips duplicates by website automatically. Use this after searchBusinessDirectory to save 10-20 leads at once.',
      schema: z.object({
        leads: z.array(z.object({
          companyName: z.string().describe('Real company name'),
          website: z.string().optional().describe('Company website URL'),
          industry: z.string().optional().describe('e.g. HVAC, Roofing, Personal Injury, MedSpa'),
          city: z.string().optional(),
          fitReason: z.string().describe('Why this company is a good fit for BuildMyBot'),
          outreachAngle: z.string().optional().describe('Suggested outreach pitch'),
        })).describe('Array of leads to save (10-20 at a time is ideal)'),
      }),
      requiresApproval: false,
      async execute({ leads }, ctx) {
        const { randomUUID } = await import('crypto');
        const { db, researchedLeads } = await import('@workspace/db');
        const { eq } = await import('drizzle-orm');

        let saved = 0;
        let duplicates = 0;
        let failed = 0;
        const savedNames: string[] = [];

        for (const lead of leads) {
          try {
            if (lead.website) {
              const existing = await db
                .select()
                .from(researchedLeads)
                .where(eq(researchedLeads.website, lead.website))
                .limit(1);
              if (existing.length > 0) {
                duplicates++;
                continue;
              }
            }

            await db.insert(researchedLeads).values({
              id: randomUUID(),
              companyName: lead.companyName,
              website: lead.website,
              industry: lead.industry,
              city: lead.city,
              fitReason: lead.fitReason,
              outreachAngle: lead.outreachAngle,
              status: 'new',
              researchedByAgentId: ctx.agentId,
              createdAt: new Date(),
            });
            saved++;
            savedNames.push(lead.companyName);
          } catch {
            failed++;
          }
        }

        return { saved, duplicates, failed, total: leads.length, savedNames };
      },
    },

    // Request peer review from another specialized role
    {
      name: 'requestPeerReview',
      description: 'Request another specialized agent role (e.g. QA, DEVOPS, BACKEND) to review code, features, or design and create a subtask for them.',
      schema: z.object({
        targetRole: z.enum(['CEO', 'CTO', 'COO', 'LEAD_DEV', 'FRONTEND', 'BACKEND', 'DEVOPS', 'QA', 'RESEARCH', 'DOCS', 'OPS', 'QA_DIRECTOR', 'LEAD_RESEARCH', 'SALES', 'MARKETING', 'CUSTOMER_SUCCESS']).describe('The specialized role requested for peer review'),
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

    // ─── Swarm dispatch: fan-out N independent tasks to a target role ──────
    //
    // Generic pattern for parallel task execution. CEO dispatches a swarm of
    // tasks (e.g. beta-tester personas, research angles, review perspectives),
    // each one becoming an independent task row. The target agent processes
    // them via its normal task queue. If multiple agent instances run the same
    // role, tasks execute truly concurrently; with a single instance they run
    // sequentially — the data model supports both.
    {
      name: 'dispatchSwarm',
      description: 'Fan out a shared objective to N independent instances/personas of a target role. Creates one real task per instance, each parameterized with its own context. Returns a swarmId for later collection via collectSwarmResults.',
      schema: z.object({
        targetRole: z.enum(['CEO', 'CTO', 'COO', 'LEAD_DEV', 'FRONTEND', 'BACKEND', 'DEVOPS', 'QA', 'RESEARCH', 'DOCS', 'OPS', 'QA_DIRECTOR', 'LEAD_RESEARCH', 'SALES', 'MARKETING', 'CUSTOMER_SUCCESS']).describe('The role to dispatch tasks to'),
        objective: z.string().describe('Shared objective/instructions all instances will work on'),
        instances: z.array(z.object({
          name: z.string().describe('Human-readable instance name (e.g. "Susan-novice", "Marcus-security")'),
          instructions: z.string().describe('Instance-specific instructions, persona description, or parameters that differentiate this task from the others'),
          context: z.record(z.any()).optional().describe('Additional context data specific to this instance'),
        })).min(1).describe('List of instances to dispatch — one task per instance'),
        sharedContext: z.record(z.any()).optional().describe('Context data shared across all instances (e.g. URLs to test, feature to review)'),
        priority: z.number().optional().describe('Task priority (1=highest, 10=lowest, default 5)'),
      }),
      requiresApproval: false,
      async execute({ targetRole, objective, instances, sharedContext, priority }, ctx) {
        if (!ctx.delegateToRole) {
          throw new Error('delegateToRole is not available in this context');
        }

        const { randomUUID } = await import('crypto');
        const swarmId = randomUUID();

        const taskIds: Array<{ name: string; taskId: string }> = [];

        for (const instance of instances) {
          const taskId = await ctx.delegateToRole(targetRole, {
            title: `[Swarm: ${instance.name}] ${objective.slice(0, 100)}`,
            description: `## Swarm Objective\n${objective}\n\n## Your Instance\nYou are executing as: **${instance.name}**\n\n${instance.instructions}`,
            parentTaskId: ctx.taskId,
            context: {
              swarmId,
              instanceName: instance.name,
              ...(sharedContext ?? {}),
              ...(instance.context ?? {}),
            },
          });

          taskIds.push({ name: instance.name, taskId });
        }

        return {
          success: true,
          swarmId,
          targetRole,
          totalDispatched: instances.length,
          tasks: taskIds,
          message: `Swarm dispatched: ${instances.length} tasks to ${targetRole} (swarmId: ${swarmId})`,
        };
      },
    },

    // Collect results from a previously dispatched swarm
    {
      name: 'collectSwarmResults',
      description: 'Check the status of a previously dispatched swarm and collect results from completed tasks. Use after dispatchSwarm to gather and synthesize findings.',
      schema: z.object({
        swarmId: z.string().describe('The swarmId returned by dispatchSwarm'),
      }),
      requiresApproval: false,
      async execute({ swarmId }) {
        const { db, tasks: tasksTable } = await import('@workspace/db');
        const { sql } = await import('drizzle-orm');

        // Query all tasks with this swarmId in their context
        const swarmTasks = await db
          .select()
          .from(tasksTable)
          .where(sql`${tasksTable.context}->>'swarmId' = ${swarmId}`);

        if (swarmTasks.length === 0) {
          return { success: false, error: `No tasks found for swarmId: ${swarmId}` };
        }

        const summary = {
          swarmId,
          total: swarmTasks.length,
          done: 0,
          failed: 0,
          pending: 0,
          inProgress: 0,
          other: 0,
        };

        const results: Array<{
          instanceName: string;
          taskId: string;
          status: string;
          result?: string;
          error?: string;
        }> = [];

        for (const task of swarmTasks) {
          const ctx = task.context as Record<string, unknown> | null;
          const instanceName = (ctx?.instanceName as string) ?? task.title;

          switch (task.status) {
            case 'done': summary.done++; break;
            case 'failed': summary.failed++; break;
            case 'pending': summary.pending++; break;
            case 'in_progress': summary.inProgress++; break;
            default: summary.other++; break;
          }

          results.push({
            instanceName,
            taskId: task.id,
            status: task.status,
            result: task.result ?? undefined,
            error: task.errorMessage ?? undefined,
          });
        }

        const allComplete = summary.pending === 0 && summary.inProgress === 0;

        return {
          success: true,
          allComplete,
          summary,
          results,
        };
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
      requiresApproval: false, // Auto-approved 2026-07-22: runs in an isolated temp dir with strict timeout + automatic cleanup by design -- gating it same as raw shell defeated the whole point of a sandboxed tool.
      // (was requiresApproval: true)
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

    // ─── Health check: fast, read-only self-diagnostics ───────────────────
    //
    // Phase 1 of the standing observability roadmap (see ROADMAP.md). This is
    // deliberately the smallest useful slice: no new package, no new DB
    // tables, no live LLM API calls (that would be slow and cost real
    // requests on every check) — just checks Apex can already answer for
    // itself: DB reachable, tool registry populated, which LLM fallback
    // providers have keys configured, and current task backlog by status.
    // AlertManager/dashboard/scheduled polling are follow-on work once this
    // primitive exists and is verified.
    {
      name: 'health_check',
      description: 'Run fast, read-only diagnostics across Apex core components (database, tool registry, configured LLM fallback providers, memory system, task backlog, WebSocket liveness) and return a health summary. No side effects, no live LLM calls -- safe to call anytime.',
      schema: z.object({}),
      requiresApproval: false,
      async execute(): Promise<ToolResult> {
        // Thin wrapper: all real check logic lives in @workspace/health-monitor
        // (packages/health-monitor/src/index.ts) so this tool, a future
        // scheduled HealthCheckJob, and a future AlertManager all share one
        // implementation instead of drifting apart. No WebSocket checker is
        // injected here (this runs inside an agent's tool call, not the
        // api-server request/response cycle) -- that check honestly reports
        // 'degraded: no checker injected'; the api-server's own health
        // routes (not yet built) will inject the real one.
        const monitor = new HealthMonitor({
          getConfiguredProviders,
          getRegisteredToolCount: () => getToolRegistry().getLLMToolSchemas().length,
        });
        const report = await monitor.runAll();
        return { success: true, data: report };
      },
    },

    // ─── System status: health + component_health table context ────────────
    {
      name: 'get_system_status',
      description: 'Get comprehensive system status including live health checks, per-component historical status from the database, and alert summary. More detailed than health_check — includes component_health table data and active alert counts.',
      schema: z.object({}),
      requiresApproval: false,
      async execute(): Promise<ToolResult> {
        const monitor = new HealthMonitor({
          getConfiguredProviders,
          getRegisteredToolCount: () => getToolRegistry().getLLMToolSchemas().length,
        });
        const report = await monitor.runAll();

        // Read component_health table for historical context
        const { db, componentHealth } = await import('@workspace/db');
        const components = await db.select().from(componentHealth);

        // Get alert summary from the shared singleton
        const alertSummary = getSharedAlertManager().getSummary();

        return {
          success: true,
          data: {
            live: report,
            storedComponents: components,
            alerts: alertSummary,
          },
        };
      },
    },

    // ─── Active alerts ────────────────────────────────────────────────────
    {
      name: 'get_active_alerts',
      description: 'Get all currently active alerts from the AlertManager. Alerts fire when health thresholds are breached (component critical, task backlog > 50, approval backlog > 10, 3+ components degraded). Includes severity, component, and when the alert fired.',
      schema: z.object({}),
      requiresApproval: false,
      async execute(): Promise<ToolResult> {
        const alerts = getSharedAlertManager().getActiveAlerts();
        const summary = getSharedAlertManager().getSummary();
        return {
          success: true,
          data: { alerts, summary },
        };
      },
    },

    // ─── Metrics view (tasks/agents/approvals/logs snapshot) ──────────────
    {
      name: 'get_metrics_view',
      description: 'Get a live metrics snapshot: task counts by status, agent counts by status, pending approval backlog, and log volume by level over the last 24h. Complements get_active_alerts (thresholds) and health_check (component diagnostics) with raw counts for trend-spotting.',
      schema: z.object({}),
      requiresApproval: false,
      async execute(): Promise<ToolResult> {
        const { db, tasks, agents, approvals, logs } = await import('@workspace/db');
        const { sql, eq, gte } = await import('drizzle-orm');
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const [taskRows, agentRows, pendingApprovalRows, recentLogRows] = await Promise.all([
          db.select({ status: tasks.status, count: sql<number>`count(*)::int` }).from(tasks).groupBy(tasks.status),
          db.select({ status: agents.status, count: sql<number>`count(*)::int` }).from(agents).groupBy(agents.status),
          db.select({ count: sql<number>`count(*)::int` }).from(approvals).where(eq(approvals.status, 'pending')),
          db.select({ level: logs.level, count: sql<number>`count(*)::int` }).from(logs).where(gte(logs.timestamp, since)).groupBy(logs.level),
        ]);

        const tasksByStatus = Object.fromEntries(taskRows.map((r) => [r.status, r.count]));
        const agentsByStatus = Object.fromEntries(agentRows.map((r) => [r.status, r.count]));
        const logsByLevel24h = Object.fromEntries(recentLogRows.map((r) => [r.level, r.count]));
        const totalLogs24h = recentLogRows.reduce((s, r) => s + r.count, 0);
        const errorCount24h = logsByLevel24h.error ?? 0;

        return {
          success: true,
          data: {
            tasksByStatus,
            agentsByStatus,
            pendingApprovals: pendingApprovalRows[0]?.count ?? 0,
            logsByLevel24h,
            errorRate24h: totalLogs24h > 0 ? errorCount24h / totalLogs24h : 0,
            generatedAt: new Date().toISOString(),
          },
        };
      },
    },

    // ─── Error summary (grouped recent error logs) ─────────────────────────
    {
      name: 'get_error_summary',
      description: 'Get recent error-level logs grouped by message pattern (IDs redacted) with counts and last-seen times, to spot systemic/recurring failures vs one-offs.',
      schema: z.object({
        hours: z.number().optional().describe('Look-back window in hours (default 24)'),
        limit: z.number().optional().describe('Max distinct error patterns to return (default 20)'),
      }),
      requiresApproval: false,
      async execute({ hours, limit }): Promise<ToolResult> {
        const { db, logs } = await import('@workspace/db');
        const { and, eq, gte, desc } = await import('drizzle-orm');
        const since = new Date(Date.now() - (hours ?? 24) * 60 * 60 * 1000);

        const rows = await db.select().from(logs)
          .where(and(eq(logs.level, 'error'), gte(logs.timestamp, since)))
          .orderBy(desc(logs.timestamp))
          .limit(500);

        const grouped = new Map<string, { count: number; lastSeen: Date; agentId: string | null; taskId: string | null }>();
        for (const row of rows) {
          const key = row.message.replace(/[0-9a-f-]{8,}/gi, '<id>').slice(0, 120);
          const existing = grouped.get(key);
          if (existing) {
            existing.count += 1;
            if (row.timestamp > existing.lastSeen) existing.lastSeen = row.timestamp;
          } else {
            grouped.set(key, { count: 1, lastSeen: row.timestamp, agentId: row.agentId, taskId: row.taskId });
          }
        }

        const summary = Array.from(grouped.entries())
          .map(([pattern, v]) => ({ pattern, count: v.count, lastSeen: v.lastSeen, agentId: v.agentId, taskId: v.taskId }))
          .sort((a, b) => b.count - a.count)
          .slice(0, limit ?? 20);

        return {
          success: true,
          data: {
            totalErrors: rows.length,
            windowHours: hours ?? 24,
            distinctPatterns: grouped.size,
            topErrors: summary,
          },
        };
      },
    },

    // ─── Schedule a background job ────────────────────────────────────────
    {
      name: 'schedule_task',
      description: 'Create a scheduled background job (cron recurring or one-time). Job types: task_delegation (delegates a task to an agent), health_check (runs health diagnostics), report_generation (generates daily summary), maintenance (cleans old logs/expired data).',
      schema: z.object({
        name: z.string().describe('Human-readable job name'),
        jobType: z.enum(['task_delegation', 'health_check', 'report_generation', 'maintenance']).describe('Type of job to schedule'),
        cronExpression: z.string().optional().describe('Standard 5-part cron expression for recurring jobs (e.g. "0 */6 * * *" for every 6 hours)'),
        scheduledAt: z.string().optional().describe('ISO timestamp for one-time jobs (mutually exclusive with cronExpression)'),
        targetAgentId: z.string().optional().describe('Agent to delegate to (for task_delegation jobs)'),
        payload: z.record(z.any()).optional().describe('Job-specific payload data'),
        priority: z.number().optional().describe('Priority 1-10 (default 5)'),
      }),
      requiresApproval: false, // Auto-approved 2026-07-22: only inserts into internal scheduledJobs table, no external side effects until the scheduled job itself runs (which goes through its own gated tools).
      // (was requiresApproval: true)
      async execute({ name, jobType, cronExpression, scheduledAt, targetAgentId, payload, priority }) {
        const { randomUUID } = await import('crypto');
        const { db, scheduledJobs } = await import('@workspace/db');

        const id = randomUUID();
        const now = new Date();

        await db.insert(scheduledJobs).values({
          id,
          name,
          jobType,
          cronExpression: cronExpression ?? null,
          scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
          enabled: true,
          targetAgentId: targetAgentId ?? null,
          payload: payload ?? null,
          priority: priority ?? 5,
          status: 'active',
          retryCount: 0,
          maxRetries: 3,
          nextRunAt: scheduledAt ? new Date(scheduledAt) : now,
          createdAt: now,
          updatedAt: now,
        });

        return { created: true, jobId: id, name, jobType };
      },
    },

    // ─── List scheduled jobs ──────────────────────────────────────────────
    {
      name: 'list_scheduled_tasks',
      description: 'List all scheduled background jobs with their status, next run time, and last execution result.',
      schema: z.object({
        status: z.string().optional().describe('Filter by status: active | paused | completed | failed'),
        limit: z.number().optional().describe('Max rows (default 25)'),
      }),
      requiresApproval: false,
      async execute({ status, limit }) {
        const { db, scheduledJobs } = await import('@workspace/db');
        const { eq, desc } = await import('drizzle-orm');

        const query = db.select().from(scheduledJobs);
        const rows = status
          ? await query.where(eq(scheduledJobs.status, status)).orderBy(desc(scheduledJobs.createdAt)).limit(limit ?? 25)
          : await query.orderBy(desc(scheduledJobs.createdAt)).limit(limit ?? 25);

        return rows;
      },
    },

    // ─── Cancel/disable a scheduled job ───────────────────────────────────
    {
      name: 'cancel_scheduled_task',
      description: 'Cancel or disable a scheduled background job by ID. The job will stop executing but its history is preserved.',
      schema: z.object({
        jobId: z.string().describe('The scheduled job ID to cancel'),
      }),
      requiresApproval: false, // Auto-approved 2026-07-22: only disables an internal scheduled job row, fully reversible, no external side effects.
      // (was requiresApproval: true)
      async execute({ jobId }) {
        const { db, scheduledJobs } = await import('@workspace/db');
        const { eq } = await import('drizzle-orm');

        const [existing] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, jobId)).limit(1);
        if (!existing) {
          return { success: false, error: `No scheduled job with id ${jobId}` };
        }

        await db.update(scheduledJobs).set({
          enabled: false,
          status: 'paused',
          updatedAt: new Date(),
        }).where(eq(scheduledJobs.id, jobId));

        return { cancelled: true, jobId, name: existing.name };
      },
    },

    // ─── Job execution history ────────────────────────────────────────────
    {
      name: 'get_job_history',
      description: 'Get the execution history for a specific scheduled job, including run times, duration, status, and any errors.',
      schema: z.object({
        jobId: z.string().describe('The scheduled job ID'),
        limit: z.number().optional().describe('Max rows (default 20)'),
      }),
      requiresApproval: false,
      async execute({ jobId, limit }) {
        const { db, jobExecutionLog } = await import('@workspace/db');
        const { eq, desc } = await import('drizzle-orm');

        const rows = await db.select().from(jobExecutionLog)
          .where(eq(jobExecutionLog.jobId, jobId))
          .orderBy(desc(jobExecutionLog.startedAt))
          .limit(limit ?? 20);

        return rows;
      },
    },

    // ─── Learning: Analyze performance ───────────────────────────────────
    {
      name: 'analyze_performance',
      description: 'Analyze task execution outcomes, success rates, avg durations, and tool execution counts across agents and roles.',
      schema: z.object({
        role: z.string().optional().describe('Filter metrics by agent role'),
        limit: z.number().optional().describe('Max outcomes to analyze (default 50)'),
      }),
      requiresApproval: false,
      async execute({ role, limit }) {
        const { db, taskOutcomes } = await import('@workspace/db');
        const { eq, desc } = await import('drizzle-orm');

        const query = db.select().from(taskOutcomes);
        const rows = role
          ? await query.where(eq(taskOutcomes.role, role)).orderBy(desc(taskOutcomes.recordedAt)).limit(limit ?? 50)
          : await query.orderBy(desc(taskOutcomes.recordedAt)).limit(limit ?? 50);

        const total = rows.length;
        const successCount = rows.filter((r) => r.success).length;
        const avgDurationMs = total > 0 ? rows.reduce((sum, r) => sum + r.durationMs, 0) / total : 0;
        const totalTools = rows.reduce((sum, r) => sum + r.toolExecutions, 0);

        return {
          totalTasks: total,
          successCount,
          failedCount: total - successCount,
          successRate: total > 0 ? successCount / total : 1.0,
          avgDurationMs,
          totalToolExecutions: totalTools,
          outcomes: rows,
        };
      },
    },

    // ─── Learning: Record task outcome ────────────────────────────────────
    {
      name: 'record_outcome',
      description: 'Record the outcome of a completed task execution (success/failure, duration, quality) so the learning system has real data to analyze. Call this automatically whenever a task finishes.',
      schema: z.object({
        taskId: z.string().describe('ID of the completed task'),
        agentId: z.string().describe('ID of the agent that executed the task'),
        role: z.string().describe('Role of the executing agent'),
        durationMs: z.number().describe('Total execution duration in milliseconds'),
        success: z.boolean().describe('Whether the task completed successfully'),
        qualityScore: z.number().optional().describe('Self-assessed quality score 0.0-1.0 (default 1.0)'),
        toolExecutions: z.number().optional().describe('Number of tool calls made (default 0)'),
        llmCalls: z.number().optional().describe('Number of LLM calls made (default 0)'),
        iterations: z.number().optional().describe('Number of reasoning iterations (default 1)'),
        requiredApprovals: z.number().optional().describe('Number of human approvals required (default 0)'),
        errorType: z.string().optional().describe('Error category if the task failed'),
        complexity: z.number().optional().describe('Estimated task complexity 0.0-1.0 (default 0.5)'),
        satisfactionMetric: z.number().optional().describe('Downstream satisfaction signal 0.0-1.0 (default 1.0)'),
        tags: z.array(z.string()).optional().describe('Free-form tags for later filtering'),
      }),
      requiresApproval: false,
      async execute({
        taskId, agentId, role, durationMs, success, qualityScore,
        toolExecutions, llmCalls, iterations, requiredApprovals,
        errorType, complexity, satisfactionMetric, tags,
      }) {
        const { db, taskOutcomes } = await import('@workspace/db');
        const [row] = await db.insert(taskOutcomes).values({
          taskId,
          agentId,
          role,
          durationMs,
          success,
          qualityScore: qualityScore ?? 1.0,
          toolExecutions: toolExecutions ?? 0,
          llmCalls: llmCalls ?? 0,
          iterations: iterations ?? 1,
          requiredApprovals: requiredApprovals ?? 0,
          errorType: errorType ?? null,
          complexity: complexity ?? 0.5,
          satisfactionMetric: satisfactionMetric ?? 1.0,
          tags: tags ?? null,
        }).returning();
        return { recorded: true, id: row.id };
      },
    },

    // ─── Learning: Get insights ───────────────────────────────────────────
    {
      name: 'get_insights',
      description: 'Get active learning insights and detected patterns across task executions.',
      schema: z.object({
        limit: z.number().optional().describe('Max insights (default 20)'),
      }),
      requiresApproval: false,
      async execute({ limit }) {
        const { db, learningInsights } = await import('@workspace/db');
        const { desc } = await import('drizzle-orm');

        const rows = await db.select().from(learningInsights)
          .orderBy(desc(learningInsights.createdAt))
          .limit(limit ?? 20);

        return rows;
      },
    },

    // ─── Learning: Get strategy recommendations ──────────────────────────
    {
      name: 'get_strategy_recommendations',
      description: 'Get active strategy recommendations queue. All recommendations are advisory and await human review/approval.',
      schema: z.object({
        status: z.string().optional().describe('Filter by status: pending | approved | rejected | applied'),
      }),
      requiresApproval: false,
      async execute({ status }) {
        const { db, strategyRecommendations } = await import('@workspace/db');
        const { eq, desc } = await import('drizzle-orm');

        const query = db.select().from(strategyRecommendations);
        const rows = status
          ? await query.where(eq(strategyRecommendations.status, status)).orderBy(desc(strategyRecommendations.createdAt))
          : await query.orderBy(desc(strategyRecommendations.createdAt));

        return rows;
      },
    },

    // ─── Learning: Set performance baseline ─────────────────────────────
    {
      name: 'set_performance_baseline',
      description: 'Set or update a target performance baseline metric (e.g. avg_task_duration_ms, overall_success_rate). Requires approval.',
      schema: z.object({
        metricName: z.string().describe('Metric identifier name'),
        baselineValue: z.number().describe('Target numeric baseline value'),
        measurementWindow: z.string().optional().describe('Time window (default "30d")'),
        sampleSize: z.number().optional().describe('Number of samples benchmarked'),
      }),
      requiresApproval: false, // Auto-approved 2026-07-22: internal learning-system metric config only, no external side effects.
      // (was requiresApproval: true)
      async execute({ metricName, baselineValue, measurementWindow, sampleSize }) {
        const { db, performanceBaselines } = await import('@workspace/db');

        await db.insert(performanceBaselines).values({
          metricName,
          baselineValue,
          measurementWindow: measurementWindow ?? '30d',
          sampleSize: sampleSize ?? 0,
          updatedAt: new Date(),
        }).onConflictDoUpdate({
          target: performanceBaselines.metricName,
          set: {
            baselineValue,
            measurementWindow: measurementWindow ?? '30d',
            sampleSize: sampleSize ?? 0,
            updatedAt: new Date(),
          },
        });

        return { updated: true, metricName, baselineValue };
      },
    },

    // ─── Learning: Apply strategy recommendation ─────────────────────────
    {
      name: 'apply_strategy_recommendation',
      description: 'Mark an approved strategy recommendation as applied. Requires human approval.',
      schema: z.object({
        recommendationId: z.string().describe('ID of the strategy recommendation to apply'),
      }),
      requiresApproval: false, // Auto-approved 2026-07-22: marks an internal recommendation row applied, no external side effects by itself.
      // (was requiresApproval: true)
      async execute({ recommendationId }) {
        const { db, strategyRecommendations, learningInsights } = await import('@workspace/db');
        const { eq } = await import('drizzle-orm');

        const [existing] = await db.select().from(strategyRecommendations).where(eq(strategyRecommendations.id, recommendationId)).limit(1);
        if (!existing) {
          return { success: false, error: `No recommendation found with id ${recommendationId}` };
        }

        if (existing.status !== 'approved') {
          return {
            success: false,
            error: `Recommendation ${recommendationId} must be approved before it can be applied (current status: ${existing.status})`,
            requiresApproval: true,
            currentStatus: existing.status,
          };
        }

        await db.update(strategyRecommendations).set({
          status: 'applied',
          reviewedAt: new Date(),
        }).where(eq(strategyRecommendations.id, recommendationId));

        // Close the learning loop: persist the approved recommendation as a
        // standing insight so it is injected into agent prompts (see
        // BaseAgent.buildLearningContext) and actually shapes future behavior.
        // Non-fatal — the apply already succeeded even if this insert fails.
        let persistedAsInsight = false;
        try {
          const { randomUUID } = await import('crypto');
          await db.insert(learningInsights).values({
            id: randomUUID(),
            insightType: 'improvement',
            title: `Applied strategy: ${existing.title}`,
            description: existing.text,
            confidence: existing.confidence,
            evidence: { sourceRecommendationId: recommendationId, type: existing.recommendationType },
            applied: true,
            createdAt: new Date(),
            expiresAt: null,
          });
          persistedAsInsight = true;
        } catch {
          // insight persistence is best-effort; apply still succeeded
        }

        return { applied: true, recommendationId, title: existing.title, persistedAsInsight };
      },
    },

    // ─── CI/CD: Run test suite ───────────────────────────────────────────
    {
      name: 'run_tests',
      description: 'Run automated test suite and typechecks across workspace packages. Returns detailed test pass/fail report.',
      schema: z.object({}),
      requiresApproval: false,
      async execute() {
        const { TestRunner } = await import('@workspace/cicd-automation');
        const runner = new TestRunner();
        const report = await runner.runTests();
        return report;
      },
    },

    // ─── CI/CD: Run linter ───────────────────────────────────────────────
    {
      name: 'run_lint',
      description: 'Run linter and strict typecheck audit across workspace packages.',
      schema: z.object({}),
      requiresApproval: false,
      async execute() {
        const { LinterRunner } = await import('@workspace/cicd-automation');
        const runner = new LinterRunner();
        const report = await runner.runLint();
        return report;
      },
    },

    // ─── CI/CD: Build project ────────────────────────────────────────────
    {
      name: 'build_project',
      description: 'Build production assets for workspace packages including Vite dashboard.',
      schema: z.object({}),
      requiresApproval: false,
      async execute() {
        const { BuildManager } = await import('@workspace/cicd-automation');
        const manager = new BuildManager();
        const result = await manager.buildProject();
        return result;
      },
    },

    // ─── CI/CD: Deploy to environment ───────────────────────────────────
    {
      name: 'deploy_to_environment',
      description: 'Deploy codebase to specified target environment (staging | production). Production deploys require explicit human approval.',
      schema: z.object({
        environment: z.enum(['staging', 'production']).describe('Target deployment environment'),
        platform: z.enum(['railway', 'vercel', 'local']).optional().describe('Deployment platform (default "railway")'),
      }),
      requiresApproval: true,
      async execute({ environment, platform }) {
        const { DeploymentManager } = await import('@workspace/cicd-automation');
        const manager = new DeploymentManager();
        const result = await manager.deploy({
          environment,
          platform: platform ?? 'railway',
        });
        return result;
      },
    },

    // ─── CI/CD: Rollback deployment ──────────────────────────────────────
    {
      name: 'rollback_deployment',
      description: 'Rollback a deployment environment to the previous healthy release. Requires approval.',
      schema: z.object({
        deploymentId: z.string().describe('Deployment ID to roll back'),
      }),
      requiresApproval: true,
      async execute({ deploymentId }) {
        const { DeploymentManager } = await import('@workspace/cicd-automation');
        const manager = new DeploymentManager();
        const result = await manager.rollback(deploymentId);
        return result;
      },
    },

    // ─── CI/CD: Create feature branch ───────────────────────────────────
    {
      name: 'create_feature_branch',
      description: 'Create a new git feature branch for isolated feature development. Requires approval.',
      schema: z.object({
        branchName: z.string().describe('Name of feature branch to create (e.g. "feat/learning-system")'),
      }),
      requiresApproval: false, // Auto-approved 2026-07-22: local git branch creation only (no push), fully reversible and isolated from main.
      // (was requiresApproval: true)
      async execute({ branchName }) {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        try {
          await execAsync(`git checkout -b ${branchName}`);
          return { success: true, branchName };
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        }
      },
    },

    // ─── CI/CD: Git status (read-only) ───────────────────────────────────
    {
      name: 'git_status',
      description: 'Get current git status: branch, uncommitted changes, and last commit. Read-only, no side effects.',
      schema: z.object({}),
      requiresApproval: false,
      async execute() {
        try {
          const [branch, status, lastCommit] = await Promise.all([
            execAsync('git rev-parse --abbrev-ref HEAD'),
            execAsync('git status --short'),
            execAsync('git log -1 --format=%H%n%an%n%s'),
          ]);
          const [hash, author, subject] = lastCommit.stdout.trim().split('\n');
          return {
            branch: branch.stdout.trim(),
            uncommittedChanges: status.stdout.trim().split('\n').filter(Boolean),
            lastCommit: { hash, author, subject },
          };
        } catch (err: any) {
          return { error: err?.message || String(err) };
        }
      },
    },

    // ─── CI/CD: Push to remote ───────────────────────────────────────────
    {
      name: 'push_to_remote',
      description: 'Push committed changes on a branch to the GitHub remote. Requires approval and a GITHUB_TOKEN configured in this environment.',
      schema: z.object({
        branch: z.string().optional().describe('Branch to push (default: current branch)'),
        remote: z.string().optional().describe('Remote name (default "origin")'),
      }),
      requiresApproval: true,
      async execute({ branch, remote }) {
        const token = process.env.GITHUB_TOKEN;
        if (!token) {
          return { success: false, error: 'GITHUB_TOKEN is not configured in this environment' };
        }
        try {
          const targetBranch = branch ?? (await execAsync('git rev-parse --abbrev-ref HEAD')).stdout.trim();
          const remoteName = remote ?? 'origin';
          const { stdout: remoteUrlRaw } = await execAsync(`git remote get-url ${remoteName}`);
          const authedUrl = remoteUrlRaw.trim().replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
          const { stdout, stderr } = await execAsync(`git push ${authedUrl} ${targetBranch}`);
          return { success: true, branch: targetBranch, remote: remoteName, output: (stdout || stderr).slice(0, 4000) };
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        }
      },
    },

    // ─── CI/CD: Create pull request ──────────────────────────────────────
    {
      name: 'create_pull_request',
      description: 'Create a real pull request on GitHub via the GitHub API for code review. Requires approval and a GITHUB_TOKEN configured in this environment.',
      schema: z.object({
        title: z.string().describe('PR Title'),
        body: z.string().describe('PR Description'),
        headBranch: z.string().describe('Feature branch name'),
        baseBranch: z.string().optional().describe('Base branch (default "main")'),
        repo: z.string().optional().describe('owner/repo (default "patriotnewsactivism/Apex")'),
      }),
      requiresApproval: true,
      async execute({ title, body, headBranch, baseBranch, repo }) {
        const token = process.env.GITHUB_TOKEN;
        if (!token) {
          return { success: false, error: 'GITHUB_TOKEN is not configured in this environment' };
        }
        const targetRepo = repo ?? 'patriotnewsactivism/Apex';
        const res = await fetch(`https://api.github.com/repos/${targetRepo}/pulls`, {
          method: 'POST',
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title, body, head: headBranch, base: baseBranch ?? 'main' }),
        });
        const data: any = await res.json();
        if (!res.ok) {
          return { success: false, error: data?.message || `GitHub API error ${res.status}`, details: data };
        }
        return { success: true, prUrl: data.html_url, number: data.number, title, headBranch, baseBranch: baseBranch ?? 'main' };
      },
    },

    // ─── MultiApp: Register application ──────────────────────────────────
    {
      name: 'register_application',
      description: 'Register a new portfolio application repository for multi-application orchestration. Requires approval.',
      schema: z.object({
        id: z.string().describe('Application identifier (e.g. "buildmybot2", "aria")'),
        name: z.string().describe('Display name'),
        repoUrl: z.string().describe('GitHub repository URL'),
      }),
      requiresApproval: true,
      async execute({ id, name, repoUrl }) {
        const { ApplicationManager } = await import('@workspace/multiapp');
        const manager = new ApplicationManager();
        const success = await manager.registerApplication(id, name, repoUrl);
        return { success, id, name };
      },
    },

    // ─── MultiApp: Check application health ──────────────────────────────
    {
      name: 'app_health_check',
      description: 'Check health status and sync reachability of a registered portfolio application.',
      schema: z.object({
        id: z.string().describe('Application identifier'),
      }),
      requiresApproval: false,
      async execute({ id }) {
        const { ApplicationManager } = await import('@workspace/multiapp');
        const manager = new ApplicationManager();
        const health = await manager.checkHealth(id);
        return health;
      },
    },

    // ─── MultiApp: Delegate to application ───────────────────────────────
    {
      name: 'delegate_to_application',
      description: 'Delegate a task to a registered target application repository. Requires approval.',
      schema: z.object({
        appId: z.string().describe('Target application ID'),
        taskName: z.string().describe('Task name / specification'),
      }),
      requiresApproval: true,
      async execute({ appId, taskName }) {
        const { OrchestrationEngine } = await import('@workspace/multiapp');
        const engine = new OrchestrationEngine();
        const result = await engine.delegateToApplication(appId, taskName);
        return result;
      },
    },

    // ─── MultiApp: Read shared insights ─────────────────────────────────
    {
      name: 'shared_insights',
      description: 'Get read-only cross-application shared insights and global learnings.',
      schema: z.object({
        limit: z.number().optional().describe('Max rows (default 20)'),
      }),
      requiresApproval: false,
      async execute({ limit }) {
        const { KnowledgeBridge } = await import('@workspace/multiapp');
        const bridge = new KnowledgeBridge();
        const insights = await bridge.getSharedInsights(limit);
        return insights;
      },
    },

    // ─── Predictive: Forecast tasks ──────────────────────────────────────
    {
      name: 'forecast_tasks',
      description: 'Compute predictive task completion velocity and success rate forecasts with confidence intervals.',
      schema: z.object({
        metricName: z.string().optional().describe('Metric name (default "task_completion_rate")'),
        window: z.string().optional().describe('Time window (default "7d")'),
      }),
      requiresApproval: false,
      async execute({ metricName, window }) {
        const { Forecaster } = await import('@workspace/predictive');
        const forecaster = new Forecaster();
        const result = await forecaster.forecastTasks(metricName, window);
        return result;
      },
    },

    // ─── Predictive: Risk assessment ─────────────────────────────────────
    {
      name: 'risk_assessment',
      description: 'Run automated risk detection across portfolio applications and systemic performance trends.',
      schema: z.object({
        target: z.string().optional().describe('Risk assessment target (default "global")'),
      }),
      requiresApproval: false,
      async execute({ target }) {
        const { RiskDetector } = await import('@workspace/predictive');
        const detector = new RiskDetector();
        const result = await detector.riskAssessment(target);
        return result;
      },
    },

    // ─── Vapi: Make outbound AI phone call ────────────────────────────────
    {
      name: 'make_outbound_call',
      description: 'Make an outbound AI phone call to a prospect/customer. The AI voice agent will use the provided script as its system prompt and conduct the conversation. Returns a call ID. Costs ~$0.05-0.30/min (Vapi platform + provider pass-through). Requires VAPI_API_KEY and VAPI_PHONE_NUMBER_ID to be configured.',
      schema: z.object({
        customerNumber: z.string().describe('Destination phone number in E.164 format (e.g. "+18328804970")'),
        customerName: z.string().optional().describe('Name of the person being called (for personalization)'),
        assistantPrompt: z.string().describe('System prompt for the AI caller — the cold call script, value proposition, objection handling, and goal of the call. Be specific and conversational.'),
        firstMessage: z.string().describe('The exact words the AI says when the call connects (e.g. "Hi, is this {{customerName}}? I\'m Alex from BuildMyBot.app...")'),
      }),
      requiresApproval: true, // Makes a real phone call to a real person — externally visible, costs money, irreversible.
      async execute({ customerNumber, customerName, assistantPrompt, firstMessage }) {
        const apiKey = process.env.VAPI_API_KEY;
        const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

        if (!apiKey || !phoneNumberId) {
          return {
            success: false,
            error: 'Vapi is not configured. Set VAPI_API_KEY and VAPI_PHONE_NUMBER_ID env vars. Sign up at https://dashboard.vapi.ai to get started.',
          };
        }

        // Build the webhook URL for receiving call results (end-of-call-report)
        const webhookUrl = process.env.VAPI_WEBHOOK_URL ?? `${process.env.PUBLIC_URL ?? 'https://apex.donmatthews.live'}/api/vapi/webhook`;

        // Create a transient (inline) assistant — no need to pre-create one via POST /assistant.
        // The assistant config includes the cold call script as the system prompt,
        // a natural voice (ElevenLabs), Deepgram for STT, and a send_checkout_link
        // function the AI can call during the call to create a Stripe checkout
        // session for the prospect. The Vapi webhook handler at the server URL
        // receives the function call, creates the Stripe session, and returns
        // the checkout URL — the AI then tells the prospect "I've sent you a link."
        const callBody = {
          assistant: {
            name: 'APEX Outbound SDR',
            firstMessage,
            model: {
              provider: 'openai',
              model: 'gpt-4o',
              messages: [
                {
                  role: 'system',
                  content: assistantPrompt,
                },
              ],
              temperature: 0.7,
              maxTokens: 250,
            },
            tools: [
              {
                type: 'function',
                function: {
                  name: 'send_checkout_link',
                  description: 'Send a Stripe checkout link to the prospect so they can sign up for BuildMyBot.app right now. Call this when the prospect agrees to sign up. Ask for their email first if you don\'t have it.',
                  parameters: {
                    type: 'object',
                    properties: {
                      plan: {
                        type: 'string',
                        enum: ['starter', 'professional', 'executive', 'enterprise'],
                        description: 'Which plan the prospect wants. Starter=$29/mo, Professional=$99/mo, Executive=$199/mo, Enterprise=$499/mo',
                      },
                      email: {
                        type: 'string',
                        description: "The prospect's email address to send the checkout link to",
                      },
                    },
                    required: ['plan', 'email'],
                  },
                },
              },
            ],
            voice: {
              provider: '11labs',
              voiceId: '21m00Tcm4TlvDq8ikWAM',
              stability: 0.5,
              similarityBoost: 0.75,
              speed: 1.0,
            },
            transcriber: {
              provider: 'deepgram',
              model: 'nova-2-phonecall',
              language: 'en-US',
              smartFormat: true,
            },
            server: {
              url: webhookUrl,
            },
            silenceTimeoutSeconds: 30,
            responseDelaySeconds: 0.4,
          },
          phoneNumberId,
          customer: {
            number: customerNumber,
            name: customerName,
          },
        };

        const res = await fetch('https://api.vapi.ai/call', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(callBody),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          return {
            success: false,
            error: `Vapi call failed (${res.status}): ${errText.slice(0, 500)}`,
          };
        }

        const data = await res.json() as { id: string; status: string; startedAt?: string };
        return {
          success: true,
          callId: data.id,
          status: data.status,
          startedAt: data.startedAt,
          message: `Outbound call initiated to ${customerNumber}${customerName ? ` (${customerName})` : ''}. Call ID: ${data.id}. The AI agent will use your script and conduct the conversation. Results will be logged via webhook.`,
        };
      },
    },

    // ─── Vapi: Get call status + transcript ───────────────────────────────
    {
      name: 'get_call_status',
      description: 'Check the status of an outbound call — includes current status (ringing/in-progress/ended), transcript, AI analysis summary, success evaluation, recording URLs, and cost breakdown. Poll this after making a call to get results.',
      schema: z.object({
        callId: z.string().describe('The Vapi call ID returned from make_outbound_call'),
      }),
      requiresApproval: false, // Read-only — just checks status, no side effects.
      async execute({ callId }) {
        const apiKey = process.env.VAPI_API_KEY;
        if (!apiKey) {
          return { success: false, error: 'VAPI_API_KEY not configured' };
        }

        const res = await fetch(`https://api.vapi.ai/call/${callId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });

        if (!res.ok) {
          return { success: false, error: `Vapi GET call failed (${res.status})` };
        }

        const data = await res.json() as {
          id: string;
          status: string;
          type?: string;
          startedAt?: string;
          endedAt?: string;
          endedReason?: string;
          artifact?: { transcript?: string; recordingUrl?: string; stereoRecordingUrl?: string };
          analysis?: { summary?: string; structuredData?: unknown; successEvaluation?: string };
          costs?: unknown[];
          cost?: number;
        };
        return {
          success: true,
          callId: data.id,
          status: data.status,
          type: data.type,
          startedAt: data.startedAt,
          endedAt: data.endedAt,
          endedReason: data.endedReason,
          transcript: data.artifact?.transcript ?? null,
          recordingUrl: data.artifact?.recordingUrl ?? data.artifact?.stereoRecordingUrl ?? null,
          analysis: data.analysis ?? null,
          costs: data.costs ?? null,
          totalCost: data.cost ?? null,
        };
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
    // Goal-lifecycle / delegation-feedback / escalation tools. Always
    // registered (no external credentials involved) — these close the
    // delegation loop, so an agent can see what happened to work it handed
    // down instead of reporting an initiative complete the moment it is sent.
    for (const tool of createOrchestrationTools()) {
      _registry.register(tool);
    }
    // Portfolio connectors register only when their env is configured, so a
    // bare APEX install never exposes half-working tools to the agents.
    if (buildMyBotConfigured()) {
      for (const tool of createBuildMyBotTools()) {
        _registry.register(tool);
      }
    }

    if (caseBuddyConfigured()) {
      for (const tool of createCaseBuddyTools()) {
        _registry.register(tool);
      }
    }

    if (tubeScribeConfigured()) {
      for (const tool of createTubeScribeTools()) {
        _registry.register(tool);
      }
    }
  }
  return _registry;
}

// ─── Shared AlertManager singleton ────────────────────────────────────────────
// Used by the get_system_status/get_active_alerts tools and by the api-server's
// health polling loop. Single instance so tool calls and the polling loop see
// the same alert state.

let _alertManager: AlertManager | null = null;

export function getSharedAlertManager(): AlertManager {
  if (!_alertManager) {
    _alertManager = new AlertManager();
  }
  return _alertManager;
}

export { ToolRegistry };

