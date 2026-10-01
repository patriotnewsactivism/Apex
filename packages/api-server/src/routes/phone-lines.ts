// Phone lines: live lamps + call playback for the Sales Ops console.
//
//   GET  /lines                      every owned number with busy/idle state, the
//                                    current call on it (if any), and a rollup
//                                    `anyBusy` for the main lamp.
//   GET  /calls/:callId/recording    streams the call audio through Apex. Telnyx
//                                    download links are signed and expire, so a
//                                    fresh one is resolved on every play.
//   GET  /calls/:callId/transcript   transcript text + summary for one call.
//
// Lamp truth comes from line_calls rows: busy = a row with ended_at IS NULL that
// started recently. Rows are opened by markLineBusy() (outbound dial, AI-call
// start hook) and closed by markLineFree() (conversation ended / hangup). A
// sweep closes anything open longer than STALE_AFTER_MS so a missed hangup event
// can never leave a lamp stuck on. Nothing here is guessed: if we never saw a
// call start, the lamp is dark.

import { Router } from 'express';
import { desc, eq, isNull } from 'drizzle-orm';
import { db, lineCalls, callOutcomes } from '@workspace/db';

import { configuredLines, sweepStaleLineCalls } from '@workspace/core';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve a Telnyx recording for a call id, trying the ids we might have stored. */
async function findTelnyxRecordingUrl(callId: string): Promise<{ url: string; type: string } | null> {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return null;
  const bare = callId.replace(/^telnyx-ai:/, '');
  const filters = [
    `filter[call_leg_id]=${encodeURIComponent(bare)}`,
    `filter[call_session_id]=${encodeURIComponent(bare)}`,
    `filter[conversation_id]=${encodeURIComponent(bare)}`,
  ];
  for (const filter of filters) {
    const response = await fetch(`https://api.telnyx.com/v2/recordings?${filter}&page[size]=1`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'apex-phone-lines' },
    });
    if (!response.ok) continue;
    const body = (await response.json()) as {
      data?: Array<{ download_urls?: Record<string, string> }>;
    };
    const urls = body.data?.[0]?.download_urls;
    if (urls) {
      const type = urls.mp3 ? 'mp3' : urls.wav ? 'wav' : Object.keys(urls)[0];
      if (type && urls[type]) return { url: urls[type], type };
    }
  }
  return null;
}

export function createPhoneLinesRouter(): Router {
  const router = Router();

  // GET /lines
  router.get('/lines', async (_req, res) => {
    try {
      await sweepStaleLineCalls();
      const open = await db
        .select()
        .from(lineCalls)
        .where(isNull(lineCalls.endedAt))
        .orderBy(desc(lineCalls.startedAt));

      const lines = configuredLines().map((line) => {
        const current = open.find((c) => c.lineNumber === line.number) ?? null;
        return {
          ...line,
          busy: Boolean(current),
          current: current
            ? {
                direction: current.direction,
                remoteNumber: current.remoteNumber,
                remoteName: current.remoteName,
                callId: current.callId,
                source: current.source,
                startedAt: current.startedAt,
                seconds: Math.max(0, Math.round((Date.now() - current.startedAt.getTime()) / 1000)),
              }
            : null,
        };
      });
      // An open record on a number we do not list still counts: surface it so a
      // new number can never be silently invisible.
      const known = new Set(lines.map((l) => l.number));
      const unlisted = open.filter((c) => !known.has(c.lineNumber));
      res.json({
        lines,
        unlisted: unlisted.map((c) => ({ number: c.lineNumber, startedAt: c.startedAt })),
        anyBusy: open.length > 0,
        busyCount: open.length,
        checkedAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // GET /calls/:callId/transcript
  router.get('/calls/:callId/transcript', async (req, res) => {
    try {
      const [row] = await db
        .select()
        .from(callOutcomes)
        .where(eq(callOutcomes.callId, req.params.callId))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'No call record for that id.' });
        return;
      }
      res.json({
        callId: row.callId,
        customerName: row.customerName,
        customerNumber: row.customerNumber,
        disposition: row.disposition,
        summary: row.summary,
        transcript: row.transcript,
        endedReason: row.endedReason,
        createdAt: row.createdAt,
      });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // GET /calls/:callId/recording -- streamed through Apex (fresh signed link each time)
  router.get('/calls/:callId/recording', async (req, res) => {
    try {
      const found = await findTelnyxRecordingUrl(req.params.callId);
      if (!found) {
        res.status(404).json({
          error:
            'No recording found for this call. Recordings only exist for calls that ran on a Telnyx line with recording enabled.',
        });
        return;
      }
      const headers: Record<string, string> = {};
      if (typeof req.headers.range === 'string') headers.Range = req.headers.range;
      const upstream = await fetch(found.url, { headers });
      if (!upstream.ok && upstream.status !== 206) {
        res.status(502).json({ error: `Recording host returned ${upstream.status}.` });
        return;
      }
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') ?? (found.type === 'mp3' ? 'audio/mpeg' : 'audio/wav'));
      for (const h of ['content-length', 'content-range', 'accept-ranges']) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.setHeader('Cache-Control', 'private, no-store');
      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      req.on('close', () => void reader.cancel().catch(() => undefined));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: errorMessage(err) });
      else res.end();
    }
  });

  return router;
}
