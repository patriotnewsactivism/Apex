import { Router } from 'express';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desc, gt, inArray, and } from 'drizzle-orm';
import { db, callBridgeSessions } from '@workspace/db';
import { joinBridgeSession } from './call-bridge.js';
import { campaignForCustomer } from './call-bridge-campaigns.js';

// ─── Hank Live Monitor ─────────────────────────────────────────────────────────
//
// Live call monitor for every Hank Vance call. The page has two clearly
// separated sections:
//
//   1. LIVE CALL MONITOR  — active bridge sessions with a live-updating
//      transcript and Listen / Talk buttons that dial Don into the call
//      (muted or audible) via the shared call bridge.
//   2. RECORDED CALLS     — everything that has ended, with recordings.
//
// Auth: shared-secret query param (?key=) checked against APEX_HANK_LIVE_KEY.
// Mounted BEFORE requireAdminAuth because Don opens this straight from a phone
// browser with no operator session. The /listen action re-uses the exact same
// joinBridgeSession() the operator dashboard uses, just gated on this key.

const HANK_ASSISTANT_IDS = new Set([
  'assistant-3cea8e28-0ef8-4633-8420-2ebc4ae9b40f', // Hank Vance - Outbound
  'assistant-21f604e8-9e64-44ae-8bf8-88454792eeed', // Hank Vance - Inbound (desk)
]);

const OFFICE_LABELS: Record<string, string> = {
  '+14792439600': 'Mena PD (admin line)',
  '+14793941212': 'Mena PD (chief line)',
  '+14793948140': 'Polk County District Court',
  '+14793943271': 'Polk County Sheriff',
  '+18707778944': 'Arkansas State Police CID Co. C',
  '+14793948132': 'Polk County Judge',
  '+14793948100': 'Polk County Circuit Clerk',
  '+14793944585': 'Mena City Hall / Mayor',
  '+14793948123': 'Polk County Clerk',
  '+14793946114': 'Polk County Prosecuting Attorney',
  '+15016188000': 'Arkansas State Police HQ (Little Rock)',
  '+15012239081': 'Sen. Tom Cotton (Little Rock)',
  '+15013727153': 'Sen. John Boozman (Little Rock)',
  '+15016099796': 'Rep. Bruce Westerman (Hot Springs)',
  '+17032242150': 'NCMEC HQ (Alexandria VA)',
  '+18775434673': 'Morgan Nick Foundation',
  '+15016822345': 'Arkansas Governor (Little Rock)',
  '+18328804970': 'Owner line (test)',
};

function officeLabel(number: string | null): string | null {
  if (!number) return null;
  if (OFFICE_LABELS[number]) return OFFICE_LABELS[number];
  const camp = campaignForCustomer(number);
  const office = camp?.dynamicVariables?.office;
  return typeof office === 'string' && office ? office : null;
}

interface TelnyxMessage { role?: string; text?: string; created_at?: string }
interface TelnyxConversation {
  id: string; name?: string | null; system_prompt?: string | null;
  status?: string | null; created_at?: string; last_message_at?: string | null;
  metadata?: Record<string, unknown> | null; recording_url?: string | null;
  insights_instructions?: unknown; assistant_id?: string | null;
}

function isHankConversation(c: TelnyxConversation): boolean {
  const md = c.metadata ?? {};
  const assistantId = String(md.assistant_id ?? '') || String(c.assistant_id ?? '');
  if (HANK_ASSISTANT_IDS.has(assistantId)) return true;
  const sp = c.system_prompt ?? '';
  if (sp.includes('Hank Vance')) return true;
  const nm = (c.name ?? '').toLowerCase();
  if (nm.includes('hank')) return true;
  return false;
}

async function telnyx(path: string): Promise<unknown> {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error('TELNYX_API_KEY not configured');
  const res = await fetch(`https://api.telnyx.com${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'apex-hank-live' },
  });
  if (!res.ok) throw new Error(`Telnyx ${res.status}`);
  return res.json();
}

async function collectHankCalls(): Promise<unknown[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const enc = encodeURIComponent(since).replace(/%3A/g, ':');
  const raw = (await telnyx(`/v2/ai/conversations?created_at=gte.${enc}&order=created_at.desc&limit=30`)) as { data?: TelnyxConversation[] };
  const convs = (raw.data ?? []).filter(isHankConversation);
  const out = [];
  for (const c of convs.slice(0, 20)) {
    const md = c.metadata ?? {};
    const number = String(md.telnyx_end_user_target ?? '') || null;
    let messages: TelnyxMessage[] = [];
    try {
      const mraw = (await telnyx(`/v2/ai/conversations/${c.id}/messages?limit=100`)) as { data?: TelnyxMessage[] };
      messages = mraw.data ?? [];
    } catch { /* conversation too new / not ready — show what we have */ }
    out.push({
      id: c.id,
      created_at: c.created_at ?? null,
      last_message_at: c.last_message_at ?? null,
      number,
      office: officeLabel(number) || (c.name ?? 'Unknown'),
      status: c.status ?? null,
      recording_url: c.recording_url ?? null,
      message_count: messages.length,
      messages: messages.map(m => ({ role: m.role ?? '?', text: m.text ?? '', at: m.created_at ?? null })),
    });
  }
  return out;
}

async function collectLiveSessions(): Promise<unknown[]> {
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(callBridgeSessions)
    .where(and(
      inArray(callBridgeSessions.status, ['dialing_operator', 'dialing_customer', 'active', 'ai_dialing', 'ai_joined']),
      gt(callBridgeSessions.updatedAt, since),
    ))
    .orderBy(desc(callBridgeSessions.createdAt))
    .limit(10);
  return rows.map(s => ({
    id: s.id,
    status: s.status,
    customer_number: s.customerNumber,
    operator_number: s.operatorNumber,
    office: officeLabel(s.customerNumber) || s.buyerName || 'Unknown target',
    buyer_name: s.buyerName ?? null,
    operator_joined: Boolean(s.operatorCallControlId),
    operator_join_role: s.operatorJoinRole ?? null,
    created_at: (s.createdAt instanceof Date) ? s.createdAt.toISOString() : String(s.createdAt),
    updated_at: (s.updatedAt instanceof Date) ? s.updatedAt.toISOString() : String(s.updatedAt),
  }));
}

function page(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hank — Live Call Monitor</title>
<style>
:root{color-scheme:dark}
body{background:#0c1017;color:#e6e9ef;font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:14px}
h1{font-size:16px;margin:0 0 4px}
h2{font-size:13px;letter-spacing:.8px;text-transform:uppercase;margin:18px 0 8px;color:#aab4c5}
h2.live{color:#ff5d5d}
.sub{color:#8a94a6;font-size:12px;margin-bottom:12px}
.call{background:#131a24;border:1px solid #232c3b;border-radius:10px;margin-bottom:12px;overflow:hidden}
.call.livecall{border-color:#ff5d5d66;box-shadow:0 0 14px #ff5d5d22}
.head{padding:10px 12px;border-bottom:1px solid #232c3b;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.office{font-weight:600}
.num{color:#8a94a6;font-size:12px}
.msgs{padding:8px 12px;max-height:340px;overflow-y:auto}
.msgs div{margin:4px 0}
.h{color:#7ab0ff;white-space:pre-wrap}
.u{color:#ffd479;white-space:pre-wrap}
.s{color:#666;font-style:italic}
.rec{margin:6px 0 0}
.rec a{color:#39d98a}
.badge{font-size:10px;padding:2px 7px;border-radius:99px;background:#39d98a22;color:#39d98a;letter-spacing:.5px}
.badge.dead{background:#3a4356;color:#aab4c5}
.badge.livebadge{background:#ff5d5d;color:#fff;animation:pulse 1.4s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
.actions{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #232c3b;flex-wrap:wrap}
button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:8px 12px;cursor:pointer}
button.listen{background:#39d98a;color:#06210f}
button.talk{background:#ffb02e;color:#2b1c00}
button:disabled{opacity:.55;cursor:wait}
.actnote{color:#8a94a6;font-size:12px;align-self:center}
.err-inline{color:#ff8080;font-size:12px;align-self:center}
details{background:#131a24;border:1px solid #232c3b;border-radius:10px;margin-bottom:10px;overflow:hidden}
details summary{padding:10px 12px;cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;list-style:none}
details summary::-webkit-details-marker{display:none}
details .msgs{border-top:1px solid #232c3b}
#err{color:#f05252;font-size:12px;min-height:16px}
#nolive{color:#8a94a6;font-size:13px;padding:14px;border:1px dashed #2a3550;border-radius:10px}
</style></head><body>
<h1>HANK — LIVE CALL MONITOR</h1>
<div class="sub">Live section below updates every 3s. Listen rings your phone into the call muted; Talk joins you audible. Never dials the office.</div>
<div id="err"></div>

<h2 class="live">&#9679; LIVE CALL MONITOR</h2>
<div id="live"></div>

<h2>RECORDED CALLS (last 24h)</h2>
<div id="calls"></div>

<script>
const KEY = new URLSearchParams(location.search).get('key') || '';
const esc = s => (s||'').replace(/[<>&"]/g,x=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[x]));
const msgsHtml = (ms, rev) => {
  const arr = (ms||[]).slice();
  if (rev) arr.reverse();
  return arr.map(m=>{
    const cls=m.role==='assistant'?'h':(m.role==='user'?'u':'s');
    return '<div class="'+cls+'">'+esc(m.text)+'</div>';
  }).join('') || '<div class="s">— no speech yet —</div>';
};

async function listen(sessionId, role, btn){
  document.querySelectorAll('button[data-sid="'+sessionId+'"]').forEach(b=>b.disabled=true);
  btn.textContent = role==='monitor' ? 'Ringing your phone…' : 'Ringing (audible)…';
  try{
    const r = await fetch('/api/hank-live/listen?key='+encodeURIComponent(KEY), {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({sessionId, role})
    });
    const d = await r.json();
    if(!r.ok){ btn.textContent = d.error||('failed '+r.status); return; }
    btn.textContent = role==='monitor' ? '🎧 Listening (muted)' : '🎤 You are on the call';
  }catch(e){ btn.textContent='request failed'; }
}

function renderLive(d){
  const wrap = document.getElementById('live');
  const sessions = d.sessions||[];
  const calls = d.calls||[];
  if(!sessions.length){
    wrap.innerHTML = '<div id="nolive">No live call right now. When Hank dials, it appears here instantly with a Listen button.</div>';
    return;
  }
  wrap.innerHTML = sessions.map(s=>{
    // pair with the newest conversation for the same number, started around the session
    const sessStart = new Date(s.created_at).getTime() - 5*60*1000;
    const c = calls.filter(x=>x.number===s.customer_number && new Date(x.created_at).getTime()>=sessStart)
                  .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0];
    const live = s.status!=='failed';
    const transcript = c ? msgsHtml(c.messages, true)
      : '<div class="s">— dialing, no speech yet —</div>';
    const joined = s.operator_joined ? '<span class="badge">&#127911; you '+(s.operator_join_role||'joined')+'</span>' : '';
    const joinedRole = (s.operator_join_role||'');
    const lbtn = joined && joinedRole!=='barge' ? '' : '<button class="listen" data-sid="'+s.id+'" onclick="listen(\\''+s.id+'\\',\\'monitor\\',this)">&#127911; Listen live (muted)</button>';
    const tbtn = joined && joinedRole==='barge' ? '' : '<button class="talk" data-sid="'+s.id+'" onclick="listen(\\''+s.id+'\\',\\'barge\\',this)">&#127908; Talk</button>';
    return '<div class="call livecall"><div class="head"><span><span class="office">'+esc(s.office)+'</span> <span class="num">'+esc(s.customer_number)+'</span></span><span><span class="badge livebadge">LIVE</span> <span class="num">'+esc(s.status)+'</span> '+joined+'</span></div>'
      + '<div class="msgs">'+transcript+'</div>'
      + '<div class="actions">'+lbtn+tbtn+'<span class="actnote">Your phone: '+esc(s.operator_number)+' — it will ring and connect.</span></div></div>';
  }).join('');
}

function renderRecorded(d){
  const wrap = document.getElementById('calls');
  const liveNums = new Set((d.sessions||[]).map(s=>s.customer_number));
  const liveIds = new Set();
  (d.sessions||[]).forEach(s=>{
    (d.calls||[]).forEach(c=>{ if(c.number===s.customer_number) liveIds.add(c.id); });
  });
  const recorded = (d.calls||[]).filter(c=>{
    if (liveIds.has(c.id)) return false;            // shown in the live section
    if (liveNums.has(c.number) && c.status==='active') return false;
    return true;
  });
  wrap.innerHTML = recorded.map(c=>{
    const live = c.message_count>0 && c.status!=='failed';
    return '<details><summary><span><span class="office">'+esc(c.office)+'</span> <span class="num">'+esc(c.number||'')+'</span></span><span><span class="badge'+(live?'':' dead')+'">'+esc(c.status||'ACTIVE')+'</span>'+(c.recording_url?' <a class="rec" href="'+c.recording_url+'" target="_blank">&#9654; recording</a>':'')+'</span></summary><div class="msgs">'+msgsHtml(c.messages,true)+'</div></details>';
  }).join('') || '<div class="s">No recorded calls yet.</div>';
}

async function tick(){
  try{
    const r = await fetch('/api/hank-live/data?key='+encodeURIComponent(KEY), {cache:'no-store'});
    if(!r.ok){ document.getElementById('err').textContent='feed '+r.status; return; }
    document.getElementById('err').textContent='';
    const d = await r.json();
    renderLive(d);
    renderRecorded(d);
    const lm = document.querySelector('#live .msgs');
    if(lm && lm.scrollHeight - lm.scrollTop - lm.clientHeight < 120) lm.scrollTop = lm.scrollHeight;
  }catch(e){ document.getElementById('err').textContent='poll failed'; }
}
tick(); setInterval(tick, 3000);
</script></body></html>`;
}

export function createHankLiveRouter(): Router {
  const router = Router();
  const okKey = (req: { query: Record<string, unknown> }) => {
    const expected = process.env.APEX_HANK_LIVE_KEY;
    if (!expected) return false;
    const given = String(req.query.key ?? '');
    if (given.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  };

  router.get('/', (req, res) => {
    if (!okKey(req)) { res.status(403).send('forbidden'); return; }
    res.type('html').send(page());
  });

  router.get('/data', async (req, res) => {
    if (!okKey(req)) { res.status(403).json({ error: 'forbidden' }); return; }
    try {
      const [calls, sessions] = await Promise.all([collectHankCalls(), collectLiveSessions()]);
      res.json({ ok: true, calls, sessions, fetched_at: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /listen — dial Don into a live bridge session (muted or audible) ──
  // Same joinBridgeSession() the operator dashboard uses; gated on the page key.
  router.post('/listen', async (req, res) => {
    if (!okKey(req)) { res.status(403).json({ error: 'forbidden' }); return; }
    const { sessionId, role } = (req.body ?? {}) as { sessionId?: string; role?: string };
    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'sessionId is required.' });
      return;
    }
    const wantRole = role === 'barge' ? 'barge' : 'monitor';
    const result = await joinBridgeSession(sessionId, wantRole);
    if ('error' in result) { res.status(result.status).json({ error: result.error }); return; }
    res.json({ ok: true, role: result.role });
  });

  // ── GET /audio/:name — permanent call-evidence recordings ────────────────
  // Audio pulled from the Telnyx recording store and committed to the repo so
  // the signed S3 links (10-min expiry) can't rot. Served behind the same page
  // key. Files live in src/routes/hank-audio/ (copied wholesale by the Docker
  // runtime stage), resolved from cwd first, then relative to this module.
  const AUDIO_FILES: Record<string, string> = {
    'boozman-20261012': 'boozman-20261012.mp3',
    'westerman-20261012': 'westerman-20261012.mp3',
  };
  const audioDir = (() => {
    const viaCwd = resolve(process.cwd(), 'packages/api-server/src/routes/hank-audio');
    if (existsSync(viaCwd)) return viaCwd;
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, 'hank-audio');
  })();
  router.get('/audio/:name', (req, res) => {
    if (!okKey(req)) { res.status(403).send('forbidden'); return; }
    const file = AUDIO_FILES[req.params.name];
    if (!file) { res.status(404).send('unknown recording'); return; }
    const full = join(audioDir, file);
    if (!existsSync(full)) { res.status(404).send('recording not present in this build'); return; }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', statSync(full).size);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    createReadStream(full).pipe(res);
  });

  return router;
}
