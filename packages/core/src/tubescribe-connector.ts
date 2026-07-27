import { z } from 'zod';
import type { ToolDefinition } from './types.js';

// ─── TubeScribe Connector ─────────────────────────────────────────────────────
//
// Gives APEX monitoring authority over the TubeScribe platform — a YouTube
// video analysis + forensic transcription tool for journalists/researchers
// documenting court proceedings and civic matters. APEX can read the analysis
// pipeline status, check Supadata key pool health (purpose-built for APEX),
// and monitor for failures/stuck analyses.
//
// Telemetry: analyses (status pipeline), supadata_key_status (key pool health).
// No command channel (Tubescribe has no manager_briefings equivalent) —
// monitoring only, no write tools.
//
// Env (all in .env — see .env.example):
//   TUBESCRIBE_SUPABASE_URL          e.g. https://wrsrjnqolfytzwbgbkgb.supabase.co
//   TUBESCRIBE_SUPABASE_SERVICE_KEY  service-role key (server-side only)
//   TUBESCRIBE_APP_URL               frontend URL (Vercel)
//   TUBESCRIBE_WORKER_URL            Railway worker URL (optional, for health check)

const SUPABASE_URL = () => process.env.TUBESCRIBE_SUPABASE_URL ?? '';
const SERVICE_KEY = () => process.env.TUBESCRIBE_SUPABASE_SERVICE_KEY ?? '';
const APP_URL = () => process.env.TUBESCRIBE_APP_URL ?? 'https://tubescribe.app';
const WORKER_URL = () => process.env.TUBESCRIBE_WORKER_URL ?? '';

export function tubeScribeConfigured(): boolean {
  const url = SUPABASE_URL();
  const key = SERVICE_KEY();
  if (!url || !key) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Thin Supabase REST helper (PostgREST). Throws on non-2xx. */
async function sbFetch(
  table: string,
  query: string,
  init?: RequestInit,
): Promise<any> {
  const baseUrl = SUPABASE_URL();
  if (!baseUrl.startsWith('https://')) {
    throw new Error(
      `TUBESCRIBE_SUPABASE_URL must be an https:// project URL. ` +
      `Got: "${baseUrl.slice(0, 30)}…". Env vars may be swapped.`,
    );
  }
  const url = `${baseUrl}/rest/v1/${table}${query ? `?${query}` : ''}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: SERVICE_KEY(),
      Authorization: `Bearer ${SERVICE_KEY()}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TubeScribe Supabase ${res.status} on ${table}: ${body.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export function createTubeScribeTools(): ToolDefinition[] {
  return [
    // ── Read: pipeline status snapshot ─────────────────────────────────────
    {
      name: 'tubescribe_status',
      description:
        "Get TubeScribe pipeline status: analysis counts by status (pending/extracting/transcribing/processing/complete/failed), recent failures, and Supadata key pool health. Read this to monitor the Tubescribe platform health.",
      schema: z.object({}),
      requiresApproval: false,
      async execute() {
        const today = new Date().toISOString().slice(0, 10);

        const [pending, extracting, transcribing, processing, complete, failed, keyStatus] = await Promise.all([
          sbFetch('analyses', 'status=eq.pending&select=id&limit=500').catch(() => []),
          sbFetch('analyses', 'status=eq.extracting&select=id&limit=500').catch(() => []),
          sbFetch('analyses', 'status=eq.transcribing&select=id&limit=500').catch(() => []),
          sbFetch('analyses', 'status=eq.processing&select=id&limit=500').catch(() => []),
          sbFetch('analyses', 'status=eq.complete&select=id&limit=500').catch(() => []),
          sbFetch('analyses', `status=eq.failed&created_at=gte.${today}&select=id,youtube_url,error_message&order=created_at.desc&limit=10`).catch(() => []),
          sbFetch('supadata_key_status', 'order=last_used_at.desc&limit=10').catch(() => []),
        ]);

        return {
          date: today,
          counts: {
            pending: (pending ?? []).length,
            extracting: (extracting ?? []).length,
            transcribing: (transcribing ?? []).length,
            processing: (processing ?? []).length,
            complete: (complete ?? []).length,
            failed: (failed ?? []).length,
          },
          recent_failures: failed ?? [],
          supadata_keys: (keyStatus ?? []).map((k: any) => ({
            fingerprint: k.key_fingerprint,
            status: k.status,
            exhausted_until: k.exhausted_until,
            last_used: k.last_used_at,
            exhausted_count: k.exhausted_count,
            remaining_credits: k.remaining_credits,
          })),
        };
      },
    },

    // ── Read: recent analyses ───────────────────────────────────────────────
    {
      name: 'tubescribe_recent_analyses',
      description:
        'List recent TubeScribe analyses with status, YouTube URL, and summary. Use to monitor what videos are being processed and spot stuck/failed ones.',
      schema: z.object({
        limit: z.number().optional().describe('Max rows (default 20)'),
        status: z.string().optional().describe('Filter by status: pending/extracting/transcribing/processing/complete/failed'),
      }),
      requiresApproval: false,
      async execute({ limit, status }) {
        const filter = status ? `&status=eq.${status}` : '';
        const rows = await sbFetch(
          'analyses',
          `order=created_at.desc&limit=${limit ?? 20}${filter}` +
            '&select=id,youtube_url,status,summary,error_message,created_at,user_id',
        );
        return rows ?? [];
      },
    },

    // ── Read: Supadata key pool health ─────────────────────────────────────
    {
      name: 'tubescribe_supadata_keys',
      description:
        'Check the Supadata API key pool health for TubeScribe. Shows each key fingerprint, status (active/exhausted/recovering), remaining credits, and exhaustion count. This table was purpose-built for APEX portfolio monitoring.',
      schema: z.object({}),
      requiresApproval: false,
      async execute() {
        const rows = await sbFetch(
          'supadata_key_status',
          'order=last_used_at.desc&limit=20',
        );
        return rows ?? [];
      },
    },

    // ── Read: live key-pool snapshot from the worker (probes /me) ─────────
    {
      name: 'tubescribe_supadata_live',
      description:
        'Live (real-time) Supadata key-pool health straight from the TubeScribe worker: probes Supadata GET /me per key for current remaining credits plus the worker\u2019s in-memory exhausted state. More current than tubescribe_supadata_keys (which reads the table, updated only on state changes). Use when you need right-now quota numbers \u2014 e.g. before a bulk-analyze run, or to confirm a parked key has recovered.',
      schema: z.object({}),
      requiresApproval: false,
      async execute() {
        const workerUrl = WORKER_URL();
        if (!workerUrl) {
          return { ok: false, error: 'TUBESCRIBE_WORKER_URL is not configured' };
        }
        const url = `${workerUrl}/supadata-status`;
        const started = Date.now();
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
          const ms = Date.now() - started;
          const text = await res.text();
          let parsed: any = null;
          try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
          return {
            ok: res.ok,
            httpStatus: res.status,
            latencyMs: ms,
            url,
            ...(parsed ?? { body: text.slice(0, 300) }),
          };
        } catch (err: any) {
          return {
            ok: false,
            httpStatus: 0,
            latencyMs: Date.now() - started,
            url,
            error: err?.message ?? String(err),
          };
        }
      },
    },

    // ── Read: live health check against the worker ──────────────────────────
    {
      name: 'tubescribe_health_check',
      description:
        'Live HTTP health check against the TubeScribe worker (Railway). Reports real HTTP status and latency. Also checks the frontend URL if configured.',
      schema: z.object({}),
      requiresApproval: false,
      async execute() {
        const results: any = { worker: null, frontend: null };

        // Worker health check
        const workerUrl = WORKER_URL();
        if (workerUrl) {
          const started = Date.now();
          try {
            const res = await fetch(`${workerUrl}/`, { signal: AbortSignal.timeout(10_000) });
            const ms = Date.now() - started;
            const text = await res.text();
            let parsed: any = null;
            try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
            results.worker = {
              healthy: res.ok,
              httpStatus: res.status,
              latencyMs: ms,
              url: workerUrl,
              body: parsed ?? text.slice(0, 300),
            };
          } catch (err: any) {
            results.worker = {
              healthy: false,
              httpStatus: 0,
              latencyMs: Date.now() - started,
              url: workerUrl,
              error: err?.message ?? String(err),
            };
          }
        }

        // Frontend health check
        const appUrl = APP_URL();
        if (appUrl) {
          const started = Date.now();
          try {
            const res = await fetch(appUrl, { signal: AbortSignal.timeout(10_000), method: 'HEAD' });
            results.frontend = {
              healthy: res.ok,
              httpStatus: res.status,
              latencyMs: Date.now() - started,
              url: appUrl,
            };
          } catch (err: any) {
            results.frontend = {
              healthy: false,
              httpStatus: 0,
              latencyMs: Date.now() - started,
              url: appUrl,
              error: err?.message ?? String(err),
            };
          }
        }

        return results;
      },
    },

    // ── Read: forensic custody log ──────────────────────────────────────────
    {
      name: 'tubescribe_custody_log',
      description:
        'Read the TubeScribe forensic custody log — append-only audit trail of analysis hash verification and chain-of-custody events. Use when investigating integrity questions.',
      schema: z.object({
        analysisId: z.string().optional().describe('Filter to a specific analysis'),
        limit: z.number().optional().describe('Max rows (default 20)'),
      }),
      requiresApproval: false,
      async execute({ analysisId, limit }) {
        const filter = analysisId ? `&analysis_id=eq.${analysisId}` : '';
        const rows = await sbFetch(
          'custody_log',
          `order=created_at.desc&limit=${limit ?? 20}${filter}`,
        );
        return rows ?? [];
      },
    },
  ];
}
