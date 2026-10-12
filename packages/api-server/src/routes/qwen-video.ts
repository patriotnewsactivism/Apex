import { Router } from 'express';

/**
 * QwenCloud Wan video-edit task route. Mounted under /api/qwen-video
 * (behind requireAdminAuth).
 *
 *   POST /api/qwen-video/edit            submit a video-edit task -> { task_id }
 *   GET  /api/qwen-video/edit/:taskId    poll -> { status, video_url?, message? }
 *
 * Uses the same QWEN_API_KEY / QWEN_BASE_URL credentials as the
 * qwen-dashscope-byok chat provider, but talks to the native async task API
 * (video generation is not an OpenAI-compatible chat call). The native base
 * URL is derived from QWEN_BASE_URL by stripping the /compatible-mode/v1
 * suffix; override with QWEN_VIDEO_BASE_URL if it ever diverges.
 */

const DEFAULT_MODEL = 'wan2.7-videoedit';

function nativeBaseUrl(): string {
  const override = process.env.QWEN_VIDEO_BASE_URL?.trim();
  if (override) return override.replace(/\/$/, '');
  const base =
    process.env.QWEN_BASE_URL?.trim() ||
    'https://maas.qwencloudapi.com/compatible-mode/v1';
  return base.replace(/\/compatible-mode\/v1\/?$/, '') + '/api/v1';
}

function apiKey(): string {
  return (
    process.env.QWEN_API_KEY?.trim() ||
    process.env.QWEN_API_KEY_2?.trim() ||
    ''
  );
}

export function createQwenVideoRouter(): Router {
  const router = Router();

  router.post('/edit', async (req, res) => {
    const key = apiKey();
    if (!key) {
      res.status(503).json({ error: 'QWEN_API_KEY is not configured' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const model =
      typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : DEFAULT_MODEL;
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const negativePrompt =
      typeof body.negative_prompt === 'string' ? body.negative_prompt : undefined;
    const videoUrl = typeof body.video_url === 'string' ? body.video_url : '';
    const refImages = Array.isArray(body.reference_images)
      ? body.reference_images.filter((u): u is string => typeof u === 'string')
      : [];

    if (!videoUrl) {
      res.status(400).json({ error: 'video_url is required' });
      return;
    }

    const media: Array<{ type: string; url: string }> = [
      { type: 'video', url: videoUrl },
    ];
    for (const url of refImages) media.push({ type: 'reference_image', url });

    const parameters: Record<string, unknown> = {};
    if (typeof body.resolution === 'string') parameters.resolution = body.resolution;
    if (typeof body.ratio === 'string') parameters.ratio = body.ratio;
    if (typeof body.duration === 'number') parameters.duration = body.duration;
    if (typeof body.audio_setting === 'string') parameters.audio_setting = body.audio_setting;
    if (typeof body.prompt_extend === 'boolean') parameters.prompt_extend = body.prompt_extend;
    if (typeof body.watermark === 'boolean') parameters.watermark = body.watermark;

    const input: Record<string, unknown> = { media };
    if (prompt) input.prompt = prompt;
    if (negativePrompt) input.negative_prompt = negativePrompt;

    try {
      const resp = await fetch(
        `${nativeBaseUrl()}/services/aigc/video-generation/video-synthesis`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            'X-DashScope-Async': 'enable',
          },
          body: JSON.stringify({ model, input, parameters }),
        },
      );
      const data = (await resp.json()) as {
        output?: { task_id?: string; task_status?: string };
        message?: string;
        code?: string;
      };
      if (!resp.ok) {
        res
          .status(resp.status)
          .json({ error: data?.message || data?.code || 'video task submission failed' });
        return;
      }
      res.json({
        task_id: data?.output?.task_id ?? null,
        status: data?.output?.task_status ?? null,
      });
    } catch (error) {
      res
        .status(502)
        .json({ error: error instanceof Error ? error.message : 'video task submission failed' });
    }
  });

  router.get('/edit/:taskId', async (req, res) => {
    const key = apiKey();
    if (!key) {
      res.status(503).json({ error: 'QWEN_API_KEY is not configured' });
      return;
    }
    const taskId = String(req.params.taskId ?? '');
    if (!/^[0-9a-f-]{36}$/.test(taskId)) {
      res.status(400).json({ error: 'invalid task id' });
      return;
    }
    try {
      const resp = await fetch(`${nativeBaseUrl()}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const data = (await resp.json()) as {
        output?: {
          task_status?: string;
          video_url?: string;
          message?: string;
        };
        message?: string;
        code?: string;
      };
      if (!resp.ok) {
        res
          .status(resp.status)
          .json({ error: data?.message || data?.code || 'task lookup failed' });
        return;
      }
      const out = data?.output ?? {};
      res.json({
        task_id: taskId,
        status: out.task_status ?? null,
        video_url: out.video_url ?? null,
        message: out.message ?? null,
      });
    } catch (error) {
      res
        .status(502)
        .json({ error: error instanceof Error ? error.message : 'task lookup failed' });
    }
  });

  return router;
}
