import express, { Router } from 'express';

// ─── Voice-to-text for the dashboard's Quick Chat ─────────────────────────────
//
// Push-to-talk: the browser records a short clip (MediaRecorder), POSTs the
// raw audio bytes here, and gets back a transcript to drop into the chat
// input. Uses Deepgram's pre-recorded REST API — simpler and cheaper than a
// realtime socket for a bounded push-to-talk clip, and DEEPGRAM_API_KEY was
// already confirmed live against a real Deepgram project.
//
// This does NOT auto-send the transcript as a message or a goal — transcripts
// can be wrong, and silently turning a garbled transcript into a deployed
// goal would be worse than the problem it solves. The dashboard fills the
// input box and lets Don review/edit before sending, same as if he'd typed it.

const ACCEPTED_TYPES = ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/mpeg', 'application/octet-stream'];

const rawAudioParser = express.raw({ type: ACCEPTED_TYPES, limit: '15mb' });

export function createTranscribeRouter() {
  const router = Router();

  router.post('/', rawAudioParser, async (req, res) => {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'DEEPGRAM_API_KEY is not configured on this deployment.' });
    }
    const contentType = req.headers['content-type'] || 'audio/webm';
    const audio = req.body as Buffer;
    if (!audio || !Buffer.isBuffer(audio) || audio.length === 0) {
      return res.status(400).json({ error: 'No audio data received.' });
    }
    if (audio.length > 15 * 1024 * 1024) {
      return res.status(413).json({ error: 'Audio clip too large.' });
    }

    try {
      const dgRes = await fetch(
        'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=en-US',
        {
          method: 'POST',
          headers: {
            Authorization: `Token ${apiKey}`,
            'Content-Type': contentType,
          },
          body: audio,
        },
      );

      if (!dgRes.ok) {
        const errText = await dgRes.text().catch(() => '');
        console.error(`[transcribe] Deepgram error ${dgRes.status}: ${errText.slice(0, 300)}`);
        return res.status(502).json({ error: `Transcription provider returned ${dgRes.status}.` });
      }

      const data = (await dgRes.json()) as {
        results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
      };
      const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
      return res.json({ transcript });
    } catch (err) {
      console.error('[transcribe] POST / error:', err);
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
