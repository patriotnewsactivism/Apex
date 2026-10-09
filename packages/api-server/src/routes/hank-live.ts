import { Router } from 'express';

// ─── Hank Live Monitor ─────────────────────────────────────────────────────────
//
// Silent, read-only live monitor for every Hank Vance call. Renders a single
// self-refreshing HTML page plus a JSON feed. It NEVER joins a call, plays no
// audio, and touches no call-control state — it only reads Telnyx AI
// conversation transcripts and recording URLs.
//
// Auth: shared-secret query param (?key=) checked against APEX_HANK_LIVE_KEY.
// Mounted BEFORE requireAdminAuth (like the webhook routers) because Don opens
// this straight from a phone browser with no operator session.

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
  '+18328804970': 'Owner line (test)',
};

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
      office: (number && OFFICE_LABELS[number]) || (c.name ?? 'Unknown'),
      status: c.status ?? null,
      recording_url: c.recording_url ?? null,
      message_count: messages.length,
      messages: messages.map(m => ({ role: m.role ?? '?', text: m.text ?? '', at: m.created_at ?? null })),
    });
  }
  return out;
}

function page(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hank — Silent Live Monitor</title>
<style>
:root{color-scheme:dark}
body{background:#0c1017;color:#e6e9ef;font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:14px}
h1{font-size:16px;margin:0 0 4px}
.sub{color:#8a94a6;font-size:12px;margin-bottom:12px}
.call{background:#131a24;border:1px solid #232c3b;border-radius:10px;margin-bottom:12px;overflow:hidden}
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
.badge.dead{background:#f05252;color:#fff}
#err{color:#f05252;font-size:12px;min-height:16px}
</style></head><body>
<h1>HANK — SILENT LIVE MONITOR</h1>
<div class="sub">Read-only transcript mirror. Polls every 3s. Joins nothing, plays nothing.</div>
<div id="err"></div><div id="calls"></div>
<script>
const KEY = new URLSearchParams(location.search).get('key') || '';
async function tick(){
  try{
    const r = await fetch('/api/hank-live/data?key='+encodeURIComponent(KEY), {cache:'no-store'});
    if(!r.ok){ document.getElementById('err').textContent='feed '+r.status; return; }
    document.getElementById('err').textContent='';
    const d = await r.json();
    const wrap = document.getElementById('calls');
    const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
    wrap.innerHTML = (d.calls||[]).map(c=>{
      const live = c.message_count>0 && c.status!=='failed';
      const msgs=(c.messages||[]).map(m=>{
        const cls=m.role==='assistant'?'h':(m.role==='user'?'u':'s');
        return '<div class="'+cls+'">'+(m.text||'').replace(/[<>&]/g,x=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[x]))+'</div>';
      }).join('') || '<div class="s">— no speech yet —</div>';
      return '<div class="call"><div class="head"><span><span class="office">'+(c.office||'')+'</span> <span class="num">'+(c.number||'')+'</span></span><span class="badge'+(live?'':' dead')+'">'+(c.status||'ACTIVE')+'</span></div><div class="msgs">'+msgs+'</div>'+(c.recording_url?'<div class="rec"><a href="'+c.recording_url+'" target="_blank">&#9654; recording</a></div>':'')+'</div>';
    }).join('') || '<div class="s">No Hank calls in the last 24h.</div>';
    if(atBottom) wrap.scrollTop = wrap.scrollHeight;
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
      const calls = await collectHankCalls();
      res.json({ ok: true, calls, fetched_at: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
