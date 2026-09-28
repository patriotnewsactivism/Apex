import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '@workspace/db';
import { sql } from 'drizzle-orm';
import {
  CARTESIA_API_VERSION,
  createLLMClient,
  getDefaultLLMConfig,
  resolveCartesiaSalesVoiceId,
} from '@workspace/core';
import type { LLMMessage } from '@workspace/core';

type WebinarSessionRow = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  host_name: string;
  mode: string;
  status: string;
  autonomous: boolean;
  current_segment: number;
  segment_started_at: Date | string | null;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  cta_label: string;
  cta_url: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type QuestionRow = {
  id: string;
  question: string;
  answer: string | null;
  status: string;
  created_at: Date | string;
  answered_at: Date | string | null;
};

function rows<T>(value: unknown): T[] {
  return Array.from(value as Iterable<T>);
}

export type WebinarSegment = {
  id: string;
  title: string;
  kicker: string;
  durationSeconds: number;
  bullets: string[];
  narration: string;
  demoCue?: string;
};

export const DEFAULT_WEBINAR_SEGMENTS: WebinarSegment[] = [
  {
    id: 'welcome',
    title: 'The AI Workforce Is Already Here',
    kicker: 'Welcome',
    durationSeconds: 80,
    bullets: [
      'APEX finds, researches, and works opportunities',
      'BuildMyBot handles customer conversations around the clock',
      'Today you will see how the two systems fit together',
    ],
    narration:
      "Welcome. I'm the AI co-host for this session. Today is not a slideshow about artificial intelligence. It is a walkthrough of an AI workforce built around two connected systems. APEX is the operating layer that can research prospects, organize campaigns, coordinate outreach, and manage revenue work. BuildMyBot is the customer-facing layer that can answer conversations, qualify opportunities, follow up, and help move people toward the next step. Matthew can jump in at any point, but this room is designed so the AI can also carry the presentation on its own.",
  },
  {
    id: 'problem',
    title: 'The Revenue Leak Most Businesses Cannot See',
    kicker: 'Problem',
    durationSeconds: 95,
    bullets: [
      'Missed calls become missed jobs',
      'Slow follow-up lets competitors answer first',
      'Lead lists are useless when nobody researches and works them',
    ],
    narration:
      "Most businesses do not have a lead problem in isolation. They have a response and execution problem. Calls arrive after hours. Website visitors disappear before anyone follows up. Old leads sit in a spreadsheet. Salespeople spend time hunting for contact information instead of talking to qualified buyers. The idea behind APEX and BuildMyBot is to compress that entire chain: discover an opportunity, understand it, start the right conversation, remember what happened, and keep the next action moving.",
  },
  {
    id: 'buildmybot',
    title: 'BuildMyBot: The Front Line',
    kicker: 'Customer experience',
    durationSeconds: 105,
    bullets: [
      'Phone, web chat, SMS, qualification, scheduling',
      'Consistent responses without waiting for business hours',
      'Context can carry from one interaction to the next',
    ],
    narration:
      "BuildMyBot is the front-line employee layer. The goal is simple: when a customer reaches a business, somebody useful answers. That can mean phone, website chat, text messaging, qualification, appointment scheduling, and follow-up. The important part is not merely answering a question. It is preserving context and moving the conversation toward a business outcome. If a prospect calls back, the system should know what was discussed before instead of treating that person like a stranger.",
    demoCue: 'Open BuildMyBot or place a live test call if you want a human-led demo here.',
  },
  {
    id: 'apex',
    title: 'APEX: The Workforce Behind the Front Line',
    kicker: 'Autonomous operations',
    durationSeconds: 110,
    bullets: [
      'Research and lead discovery',
      'Decision-maker and contact enrichment',
      'Campaign creation, outreach, pipeline, and follow-up',
    ],
    narration:
      "APEX works farther upstream. It is designed as an autonomous workforce and control plane. It can break a revenue goal into work, research companies, recover contact information, organize leads, create individualized campaign material, coordinate email and voice activity, and keep records of what happened. That matters because automation without memory is just a collection of disconnected tricks. APEX is intended to make the work observable, resumable, and measurable.",
  },
  {
    id: 'lead-engine',
    title: 'From Raw Search to Campaign-Ready Prospect',
    kicker: 'Lead engine',
    durationSeconds: 110,
    bullets: [
      'Searches are cached to avoid paying for the same discovery twice',
      'Duplicate and junk records are filtered before outreach',
      'Prospects progress through enrichment and qualification states',
    ],
    narration:
      "A lead is not useful because a search engine returned a company name. APEX treats discovery as a pipeline. First it finds a candidate. Then it enriches the business, searches for usable contact information, qualifies the fit, performs deeper research when it is worth the cost, and only then marks the prospect campaign-ready. Search results can be cached so repeated work does not keep burning money. The objective is better data, faster throughput, and less wasted outreach.",
  },
  {
    id: 'campaigns',
    title: 'One Campaign, Thousands of Individual Contexts',
    kicker: 'Personalization',
    durationSeconds: 105,
    bullets: [
      'Campaigns can be segmented by market, industry, and territory',
      'Research can shape the pitch instead of sending one generic script',
      'Every action can be logged for the next interaction',
    ],
    narration:
      "Once prospects are ready, APEX can build campaigns around the actual company rather than blasting a single generic message. Industry, geography, decision-maker context, prior activity, and the specific pain the business appears to have can all influence the approach. Every call, email, voicemail, no-answer result, and next action should become part of the record. That is what allows a later inbound call to feel like a continuation instead of a cold restart.",
  },
  {
    id: 'voice',
    title: 'Voice AI That Behaves Like Part of the Team',
    kicker: 'Conversation',
    durationSeconds: 100,
    bullets: [
      'Low-latency two-way conversation',
      'Barge-in and interruption handling',
      'Call outcomes and transcript context feed the next action',
    ],
    narration:
      "Voice is where a lot of AI demos fall apart. The standard here is not simply whether a model can speak. It has to respond quickly, let a person interrupt naturally, understand when the conversation is over, and record the outcome. APEX already has a live voice stack built around full-duplex audio, interruption handling, persistent transcripts, call outcomes, and provider fallbacks. BuildMyBot uses that customer-facing capability while APEX can use the result to decide what happens next.",
  },
  {
    id: 'together',
    title: 'The Closed Loop',
    kicker: 'APEX + BuildMyBot',
    durationSeconds: 100,
    bullets: [
      'APEX creates and works demand',
      'BuildMyBot catches and converts conversations',
      'Results flow back into the operating system',
    ],
    narration:
      "The useful part is the loop. APEX can create demand by finding and working prospects. BuildMyBot can catch conversations from prospects and customers. The outcome of those conversations goes back into the system so the next call, message, task, or human handoff has context. Instead of buying an AI tool for one narrow task, the business gets an operating loop that can keep doing useful revenue work while a human remains able to supervise and take over.",
  },
  {
    id: 'roi',
    title: 'Measure It Like a Business System',
    kicker: 'ROI',
    durationSeconds: 105,
    bullets: [
      'Cost per conversation and cost per booked opportunity',
      'Missed-call recovery and speed-to-lead',
      'Campaign yield, booked appointments, revenue, churn, and refunds',
    ],
    narration:
      "This only matters if the economics work. The system should measure things a business owner actually cares about: how many opportunities were found, how many had usable contact information, how many conversations happened, how many appointments were booked, what each booked opportunity cost, and ultimately how much revenue came back. It should also watch the negative side of the ledger: model spend, failed calls, bad data, churn, refunds, and risky actions. Automation that cannot explain its value is just overhead with a robot voice.",
  },
  {
    id: 'qa',
    title: 'Ask the AI Anything About the System',
    kicker: 'Live Q&A',
    durationSeconds: 600,
    bullets: [
      'Submit questions in the room',
      'The AI answers from the product brief and current architecture',
      'Matthew can take over any answer at any time',
    ],
    narration:
      "We are opening the live question period now. Use the question box in this room. I will answer what I can about APEX, BuildMyBot, the architecture, workflow, and the business use cases. If a question needs a commitment about pricing, a custom integration, or something that has not been verified, I will say that instead of inventing an answer. Matthew can take over whenever he wants.",
  },
  {
    id: 'cta',
    title: 'Put an AI Workforce on One Real Problem',
    kicker: 'Next step',
    durationSeconds: 90,
    bullets: [
      'Start with a concrete revenue or customer-response problem',
      'Define the outcome and the guardrails',
      'Use the CTA in this room to continue the conversation',
    ],
    narration:
      "The best next step is not to automate everything at once. Pick one expensive problem: missed after-hours calls, slow lead follow-up, a sales pipeline nobody has time to work, or a large prospect market that needs research and outreach. Define the outcome, define the safety boundaries, then let the system prove value against real numbers. The button on your screen will take you to BuildMyBot so you can continue the conversation.",
  },
  {
    id: 'close',
    title: 'Thanks for Joining',
    kicker: 'Close',
    durationSeconds: 75,
    bullets: [
      'APEX works the opportunity pipeline',
      'BuildMyBot works the conversations',
      'Humans stay in control of the boundaries',
    ],
    narration:
      "That is the core idea: APEX works the opportunity pipeline, BuildMyBot works the conversations, and humans stay in control of the boundaries. Thanks for spending the time with us. The room will remain open for questions and the next-step link is available on screen.",
  },
];


const webinarAudioBuilds = new Map<string, Promise<Buffer>>();

function webinarAudioPath(segment: WebinarSegment): string {
  const root = process.env.APEX_ARTIFACT_DIR?.trim() || '/tmp/apex-artifacts';
  const fingerprint = createHash('sha256').update(segment.narration).digest('hex').slice(0, 12);
  return join(root, 'webinar-audio', `${segment.id}-${fingerprint}.wav`);
}

async function ensureSegmentAudio(segment: WebinarSegment): Promise<Buffer> {
  const path = webinarAudioPath(segment);
  try {
    return await readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }

  const existing = webinarAudioBuilds.get(path);
  if (existing) return existing;

  const build = (async () => {
    const apiKey = process.env.CARTESIA_API_KEY?.trim();
    if (!apiKey) throw new Error('CARTESIA_API_KEY is not configured');

    const voiceId = await resolveCartesiaSalesVoiceId();
    const response = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Cartesia-Version': CARTESIA_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: 'sonic-2',
        transcript: segment.narration,
        voice: voiceId,
        output_format: {
          container: 'wav',
          encoding: 'pcm_s16le',
          sample_rate: 44100,
        },
        language: 'en',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Cartesia webinar TTS failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, audio);
    console.log(`[webinar] Cached Don Matthews narration for segment ${segment.id} (${audio.length} bytes)`);
    return audio;
  })();

  webinarAudioBuilds.set(path, build);
  try {
    return await build;
  } finally {
    webinarAudioBuilds.delete(path);
  }
}

function prewarmSegmentAudio(index: number): void {
  for (const offset of [0, 1]) {
    const segment = DEFAULT_WEBINAR_SEGMENTS[index + offset];
    if (!segment) continue;
    void ensureSegmentAudio(segment).catch((error) => {
      console.warn(
        `[webinar] Don Matthews narration prewarm failed for ${segment.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    });
  }
}

const joinSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(240),
  company: z.string().trim().max(180).optional().default(''),
  phone: z.string().trim().max(40).optional().default(''),
});

const questionSchema = z.object({
  attendeeId: z.string().uuid(),
  question: z.string().trim().min(2).max(1200),
});

const createSchema = z.object({
  title: z.string().trim().min(3).max(180).optional(),
  description: z.string().trim().max(1000).optional(),
  mode: z.enum(['autonomous', 'cohost']).optional(),
  ctaLabel: z.string().trim().max(80).optional(),
  ctaUrl: z.string().url().optional(),
});

function slugify(value: string): string {
  const base = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 54);
  return `${base || 'apex-live'}-${Math.random().toString(36).slice(2, 6)}`;
}

async function getSessionBySlug(slug: string): Promise<WebinarSessionRow | null> {
  const result = await db.execute(sql`
    SELECT * FROM webinar_sessions WHERE slug = ${slug} LIMIT 1
  `);
  return rows<WebinarSessionRow>(result)[0] ?? null;
}

async function getSessionById(id: string): Promise<WebinarSessionRow | null> {
  const result = await db.execute(sql`
    SELECT * FROM webinar_sessions WHERE id = ${id} LIMIT 1
  `);
  return rows<WebinarSessionRow>(result)[0] ?? null;
}

async function recordEvent(
  sessionId: string,
  type: string,
  segmentIndex: number | null = null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.execute(sql`
    INSERT INTO webinar_events (id, session_id, type, segment_index, payload)
    VALUES (${randomUUID()}, ${sessionId}, ${type}, ${segmentIndex}, ${JSON.stringify(payload)}::jsonb)
  `);
}

async function maybeAdvance(session: WebinarSessionRow): Promise<WebinarSessionRow> {
  if (session.status !== 'live' || !session.autonomous || !session.segment_started_at) return session;
  const index = Math.max(0, Math.min(DEFAULT_WEBINAR_SEGMENTS.length - 1, session.current_segment));
  const segment = DEFAULT_WEBINAR_SEGMENTS[index];
  if (index >= DEFAULT_WEBINAR_SEGMENTS.length - 1) return session;
  const started = new Date(session.segment_started_at).getTime();
  if (!Number.isFinite(started)) return session;
  if (Date.now() - started < segment.durationSeconds * 1000) return session;

  const next = index + 1;
  await db.execute(sql`
    UPDATE webinar_sessions
    SET current_segment = ${next}, segment_started_at = now(), updated_at = now()
    WHERE id = ${session.id}
  `);
  await recordEvent(session.id, 'segment_changed', next, { automatic: true });
  return (await getSessionById(session.id)) ?? session;
}

async function publicSnapshot(session: WebinarSessionRow) {
  const current = Math.max(0, Math.min(DEFAULT_WEBINAR_SEGMENTS.length - 1, session.current_segment));
  const attendeeCountResult = await db.execute(sql`
    SELECT count(*)::int AS count
    FROM webinar_attendees
    WHERE session_id = ${session.id}
      AND last_seen_at > now() - interval '2 minutes'
  `);
  const questionResult = await db.execute(sql`
    SELECT id, question, answer, status, created_at, answered_at
    FROM webinar_questions
    WHERE session_id = ${session.id} AND answer IS NOT NULL
    ORDER BY answered_at DESC NULLS LAST, created_at DESC
    LIMIT 12
  `);
  const eventResult = await db.execute(sql`
    SELECT id, type, segment_index, payload, created_at
    FROM webinar_events
    WHERE session_id = ${session.id}
      AND type IN ('host_message', 'human_takeover', 'human_release')
    ORDER BY created_at DESC
    LIMIT 12
  `);
  const attendeeCount = rows<{ count: number }>(attendeeCountResult)[0]?.count ?? 0;
  return {
    session: {
      id: session.id,
      slug: session.slug,
      title: session.title,
      description: session.description,
      hostName: session.host_name,
      mode: session.mode,
      status: session.status,
      autonomous: session.autonomous,
      currentSegment: current,
      startedAt: session.started_at,
      ctaLabel: session.cta_label,
      ctaUrl: session.cta_url,
    },
    currentSegment: DEFAULT_WEBINAR_SEGMENTS[current],
    segments: DEFAULT_WEBINAR_SEGMENTS.map(({ narration, ...segment }) => segment),
    attendeeCount,
    questions: rows<QuestionRow>(questionResult).map((q) => ({
      id: q.id,
      question: q.question,
      answer: q.answer,
      status: q.status,
      createdAt: q.created_at,
      answeredAt: q.answered_at,
    })),
    events: rows<Record<string, unknown>>(eventResult).reverse(),
  };
}

const webinarQaPrompt = `You are the AI co-host for a live webinar about APEX and BuildMyBot.app.

Verified product context for this webinar:
- APEX is an autonomous workforce/control plane with lead research, contact enrichment, campaign segmentation, email campaign operations, sales/voice operations, territory controls, spend/capacity observability, durable task state, and operator approvals.
- APEX is designed to find prospects, research decision makers, create individualized campaign context, execute outreach, log outcomes, and continue follow-up work.
- BuildMyBot.app is the customer-facing AI employee layer for business conversations: phone, website chat, SMS, lead qualification, scheduling, and follow-up.
- The products are actively evolving. Do not invent customer counts, conversion rates, guaranteed ROI, pricing, launch dates, or integrations that are not stated in the question.
- If asked for a commitment, custom integration, legal/compliance conclusion, or unverified feature, say that Matthew should confirm it.
- Keep live answers concise: usually 2-5 sentences. Answer the question first. Be concrete and conversational, not hypey.
- Never claim a live demo action happened unless the question or webinar state says it happened.
- When useful, explain how APEX and BuildMyBot work together rather than describing them as unrelated apps.`;

export function createPublicWebinarRouter() {
  const router = Router();
  const llm = createLLMClient(getDefaultLLMConfig('SALES'));

  router.get('/:slug/audio/:segmentId', async (req, res) => {
    try {
      const session = await getSessionBySlug(String(req.params.slug));
      if (!session) return res.status(404).json({ error: 'Webinar not found' });
      const segment = DEFAULT_WEBINAR_SEGMENTS.find((item) => item.id === String(req.params.segmentId));
      if (!segment) return res.status(404).json({ error: 'Webinar segment not found' });
      const audio = await ensureSegmentAudio(segment);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Content-Length', String(audio.length));
      return res.send(audio);
    } catch (error) {
      console.warn('[webinar] Cartesia narration unavailable:', error instanceof Error ? error.message : String(error));
      return res.status(503).json({ error: 'Premium webinar narration is temporarily unavailable' });
    }
  });

  router.get('/:slug', async (req, res) => {
    try {
      let session = await getSessionBySlug(String(req.params.slug));
      if (!session) return res.status(404).json({ error: 'Webinar not found' });
      session = await maybeAdvance(session);
      prewarmSegmentAudio(Math.max(0, Math.min(DEFAULT_WEBINAR_SEGMENTS.length - 1, session.current_segment)));
      return res.json(await publicSnapshot(session));
    } catch (error) {
      console.error('[webinar] public state failed', error);
      return res.status(500).json({ error: 'Unable to load webinar' });
    }
  });

  router.post('/:slug/join', async (req, res) => {
    const parsed = joinSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const session = await getSessionBySlug(String(req.params.slug));
    if (!session) return res.status(404).json({ error: 'Webinar not found' });
    const attendeeId = randomUUID();
    const { name, email, company, phone } = parsed.data;
    const result = await db.execute(sql`
      INSERT INTO webinar_attendees
        (id, session_id, name, email, company, phone, engagement_score, joined_at, last_seen_at)
      VALUES
        (${attendeeId}, ${session.id}, ${name}, ${email.toLowerCase()}, ${company || null}, ${phone || null}, 5, now(), now())
      ON CONFLICT (session_id, email)
      DO UPDATE SET
        name = EXCLUDED.name,
        company = NULLIF(EXCLUDED.company, ''),
        phone = NULLIF(EXCLUDED.phone, ''),
        last_seen_at = now(),
        engagement_score = webinar_attendees.engagement_score + 1
      RETURNING id
    `);
    const id = rows<{ id: string }>(result)[0]?.id ?? attendeeId;
    await recordEvent(session.id, 'attendee_joined', session.current_segment, { attendeeId: id });
    return res.json({ attendeeId: id, snapshot: await publicSnapshot(session) });
  });

  router.post('/:slug/heartbeat', async (req, res) => {
    const attendeeId = String(req.body?.attendeeId ?? '');
    const session = await getSessionBySlug(String(req.params.slug));
    if (!session || !attendeeId) return res.status(400).json({ error: 'Invalid session' });
    await db.execute(sql`
      UPDATE webinar_attendees SET last_seen_at = now()
      WHERE id = ${attendeeId} AND session_id = ${session.id}
    `);
    return res.json({ ok: true });
  });

  router.post('/:slug/engagement', async (req, res) => {
    const attendeeId = String(req.body?.attendeeId ?? '');
    const type = String(req.body?.type ?? '').slice(0, 40);
    const session = await getSessionBySlug(String(req.params.slug));
    if (!session || !attendeeId || !['cta_click', 'question_view', 'rejoin'].includes(type)) {
      return res.status(400).json({ error: 'Invalid engagement event' });
    }
    const points = type === 'cta_click' ? 25 : type === 'question_view' ? 2 : 1;
    await db.execute(sql`
      UPDATE webinar_attendees
      SET engagement_score = engagement_score + ${points}, last_seen_at = now()
      WHERE id = ${attendeeId} AND session_id = ${session.id}
    `);
    await recordEvent(session.id, type, session.current_segment, { attendeeId });
    return res.json({ ok: true });
  });

  router.post('/:slug/question', async (req, res) => {
    const parsed = questionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const session = await getSessionBySlug(String(req.params.slug));
    if (!session) return res.status(404).json({ error: 'Webinar not found' });
    const questionId = randomUUID();
    await db.execute(sql`
      INSERT INTO webinar_questions (id, session_id, attendee_id, question, status)
      VALUES (${questionId}, ${session.id}, ${parsed.data.attendeeId}, ${parsed.data.question}, 'answering')
    `);
    await db.execute(sql`
      UPDATE webinar_attendees
      SET engagement_score = engagement_score + 10, last_seen_at = now()
      WHERE id = ${parsed.data.attendeeId} AND session_id = ${session.id}
    `);

    let answer = '';
    try {
      const segment = DEFAULT_WEBINAR_SEGMENTS[Math.max(0, Math.min(DEFAULT_WEBINAR_SEGMENTS.length - 1, session.current_segment))];
      const messages: LLMMessage[] = [
        { role: 'system', content: webinarQaPrompt },
        {
          role: 'user',
          content: `Current webinar section: "${segment.title}". Audience question: ${parsed.data.question}`,
        },
      ];
      const response = await llm.complete(messages, [], {
        role: 'SALES',
        interactive: true,
        conversationId: `webinar-${session.id}-${questionId}`,
      });
      answer = response.content.trim();
    } catch (error) {
      console.warn('[webinar] AI answer failed:', error instanceof Error ? error.message : String(error));
      answer = "I captured that question, but the live answer engine is temporarily unavailable. Matthew can take it live, and the question is saved for follow-up.";
    }

    await db.execute(sql`
      UPDATE webinar_questions
      SET answer = ${answer}, status = 'answered', answered_at = now()
      WHERE id = ${questionId}
    `);
    await recordEvent(session.id, 'question_answered', session.current_segment, { questionId });
    return res.json({ id: questionId, answer });
  });

  return router;
}

export function createWebinarAdminRouter() {
  const router = Router();

  router.get('/sessions', async (_req, res) => {
    const result = await db.execute(sql`
      SELECT
        s.*,
        (SELECT count(*)::int FROM webinar_attendees a WHERE a.session_id = s.id) AS attendee_count,
        (SELECT count(*)::int FROM webinar_questions q WHERE q.session_id = s.id) AS question_count
      FROM webinar_sessions s
      ORDER BY s.created_at DESC
      LIMIT 30
    `);
    return res.json({ sessions: rows<Record<string, unknown>>(result) });
  });

  router.post('/sessions', async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const title = parsed.data.title ?? 'The AI Workforce: APEX + BuildMyBot Live';
    const id = randomUUID();
    const slug = slugify(title);
    await db.execute(sql`
      INSERT INTO webinar_sessions
        (id, slug, title, description, host_name, mode, status, autonomous, current_segment, cta_label, cta_url)
      VALUES
        (
          ${id},
          ${slug},
          ${title},
          ${parsed.data.description ?? 'See how APEX and BuildMyBot work together as an AI workforce for prospecting, customer conversations, follow-up, and revenue operations.'},
          'Don',
          ${parsed.data.mode ?? 'autonomous'},
          'draft',
          ${(parsed.data.mode ?? 'autonomous') === 'autonomous'},
          0,
          ${parsed.data.ctaLabel ?? 'Explore BuildMyBot.app'},
          ${parsed.data.ctaUrl ?? 'https://buildmybot.app'}
        )
    `);
    await recordEvent(id, 'session_created', 0, {});
    return res.status(201).json({ session: await getSessionById(id) });
  });

  router.get('/:id/dashboard', async (req, res) => {
    const session = await getSessionById(String(req.params.id));
    if (!session) return res.status(404).json({ error: 'Webinar not found' });
    const attendeeResult = await db.execute(sql`
      SELECT id, name, email, company, phone, engagement_score, joined_at, last_seen_at
      FROM webinar_attendees
      WHERE session_id = ${session.id}
      ORDER BY engagement_score DESC, joined_at ASC
    `);
    const questionResult = await db.execute(sql`
      SELECT id, attendee_id, question, answer, status, created_at, answered_at
      FROM webinar_questions
      WHERE session_id = ${session.id}
      ORDER BY created_at DESC
    `);
    return res.json({
      session,
      segments: DEFAULT_WEBINAR_SEGMENTS,
      attendees: rows<Record<string, unknown>>(attendeeResult),
      questions: rows<Record<string, unknown>>(questionResult),
    });
  });

  router.post('/:id/start', async (req, res) => {
    const id = String(req.params.id);
    await db.execute(sql`
      UPDATE webinar_sessions
      SET status = 'live', started_at = COALESCE(started_at, now()), segment_started_at = now(), updated_at = now()
      WHERE id = ${id}
    `);
    const session = await getSessionById(id);
    if (!session) return res.status(404).json({ error: 'Webinar not found' });
    await recordEvent(id, 'session_started', session.current_segment, {});
    return res.json({ session });
  });

  router.post('/:id/pause', async (req, res) => {
    const id = String(req.params.id);
    await db.execute(sql`
      UPDATE webinar_sessions SET status = 'paused', updated_at = now() WHERE id = ${id}
    `);
    const session = await getSessionById(id);
    if (!session) return res.status(404).json({ error: 'Webinar not found' });
    await recordEvent(id, 'human_takeover', session.current_segment, {});
    return res.json({ session });
  });

  router.post('/:id/resume', async (req, res) => {
    const id = String(req.params.id);
    await db.execute(sql`
      UPDATE webinar_sessions SET status = 'live', segment_started_at = now(), updated_at = now() WHERE id = ${id}
    `);
    const session = await getSessionById(id);
    if (!session) return res.status(404).json({ error: 'Webinar not found' });
    await recordEvent(id, 'human_release', session.current_segment, {});
    return res.json({ session });
  });

  router.post('/:id/end', async (req, res) => {
    const id = String(req.params.id);
    await db.execute(sql`
      UPDATE webinar_sessions SET status = 'ended', ended_at = now(), updated_at = now() WHERE id = ${id}
    `);
    const session = await getSessionById(id);
    if (!session) return res.status(404).json({ error: 'Webinar not found' });
    await recordEvent(id, 'session_ended', session.current_segment, {});
    return res.json({ session });
  });

  router.post('/:id/segment', async (req, res) => {
    const id = String(req.params.id);
    const requested = Number(req.body?.segment);
    if (!Number.isInteger(requested) || requested < 0 || requested >= DEFAULT_WEBINAR_SEGMENTS.length) {
      return res.status(400).json({ error: 'Invalid segment' });
    }
    await db.execute(sql`
      UPDATE webinar_sessions
      SET current_segment = ${requested}, segment_started_at = now(), updated_at = now()
      WHERE id = ${id}
    `);
    const session = await getSessionById(id);
    if (!session) return res.status(404).json({ error: 'Webinar not found' });
    await recordEvent(id, 'segment_changed', requested, { automatic: false });
    return res.json({ session });
  });

  router.post('/:id/mode', async (req, res) => {
    const id = String(req.params.id);
    const autonomous = Boolean(req.body?.autonomous);
    const mode = autonomous ? 'autonomous' : 'cohost';
    await db.execute(sql`
      UPDATE webinar_sessions SET autonomous = ${autonomous}, mode = ${mode}, updated_at = now() WHERE id = ${id}
    `);
    const session = await getSessionById(id);
    if (!session) return res.status(404).json({ error: 'Webinar not found' });
    return res.json({ session });
  });

  router.post('/:id/message', async (req, res) => {
    const session = await getSessionById(String(req.params.id));
    if (!session) return res.status(404).json({ error: 'Webinar not found' });
    const message = String(req.body?.message ?? '').trim().slice(0, 1200);
    if (!message) return res.status(400).json({ error: 'Message is required' });
    await recordEvent(session.id, 'host_message', session.current_segment, { message });
    return res.json({ ok: true });
  });

  return router;
}
