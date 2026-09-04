/**
 * Mobile horizontal-overflow check for the APEX dashboard.
 *
 * Drives the BUILT dashboard in Chromium at phone widths across every view and
 * reports anything that extends past the right edge of the screen. The panels
 * style with inline objects, which cannot carry a media query, so responsive
 * regressions here are invisible to any static check — they only show up when
 * something is actually laid out.
 *
 * Not wired into CI: it needs a browser binary the runner does not install.
 * Run it on demand after touching dashboard layout:
 *
 *   pnpm --filter @workspace/dashboard run build
 *   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
 *     pnpm --filter @workspace/core exec node scripts/verify-mobile-overflow.mjs
 *
 * Two things this deliberately does NOT count as a defect:
 *   - content inside an overflow-x:auto/scroll ancestor, which the reader can
 *     still reach (wide data tables are wrapped in exactly such a scroller);
 *   - absolutely/fixed positioned decoration clipped by its own card.
 *
 * And one thing it refuses to do: pass quietly. An earlier version treated
 * #root's own overflow-x:hidden as containment, which marked every element in
 * the app as contained and made the check incapable of reporting anything but
 * "clean". The canary below injects a known-overflowing element and aborts the
 * run if the detector cannot see it.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const DIST = fileURLToPath(new URL('../../dashboard/dist', import.meta.url));
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json' };
const server = http.createServer((req,res)=>{ let f=path.join(DIST, decodeURIComponent(req.url.split('?')[0]));
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory()) f=path.join(DIST,'index.html');
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(res); });
await new Promise(r=>server.listen(0,r)); const PORT=server.address().port;

const NASTY = [
  'runShell: pnpm --filter @workspace/api-server exec tsx /home/user/Apex/scripts/verify-websocket-lifecycle.ts --reporter=verbose --timeout=120000',
  '{"tool":"searchBusinessDirectory","args":{"industry":"commercial real estate","city":"Baton Rouge","radiusMeters":50000,"fields":["name","address","phone","website","rating"]},"result":{"count":20,"source":"google"}}',
  'https://places.googleapis.com/v1/places:searchText?fields=places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhcGV4LWxlYWQtcmVzZWFyY2hlciIsImlhdCI6MTc4ODQ5MTAxN30.QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
  'ERROR provider chain exhausted: openrouter/deepseek-v4-flash 400 models_array_too_long; openrouter2/qwen3-max cooldown 30s; cerebras no key configured',
];
const BOTTOM = ['Chat','Mission','Tasks','Agents','Settings'];
const DRAWER = ['Approvals','Agent Network','Log Stream','Campaigns','Leads','Suggestions','Portfolio','Control Room','Health','Intelligence','CI/CD'];
const WIDTHS = [360, 390, 430];

// PLAYWRIGHT_CHROMIUM lets a sandbox point at a pre-installed browser whose
// build number does not match the pinned playwright package.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM || undefined;
const browser = await chromium.launch({ executablePath, args:['--no-sandbox'] });
const findings = [];

for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport:{width,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true });
  await ctx.addInitScript(({nasty})=>{
    localStorage.setItem('apex_token','test-token');
    class FakeWS { static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
      constructor(){ this.readyState=1; setTimeout(()=>{ this.onopen?.({}); const t=Date.now();
        const s=(o)=>this.onmessage?.({data:JSON.stringify(o)});
        s({type:'connected',timestamp:t});
        for(let i=0;i<24;i++) s({type:'log',agentId:'apex-lead-researcher-001',level:i%3?'info':'error',message:nasty[i%nasty.length],timestamp:t+i});
      },60); }
      send(){} close(){} addEventListener(){} removeEventListener(){} }
    window.WebSocket = FakeWS;
  },{nasty:NASTY});

  const page = await ctx.newPage();
  await page.route('**/api/**', (route)=>{ const u=route.request().url();
    const j=(b)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(b)});
    if(u.includes('/auth/websocket-ticket')) return j({ticket:'tkt'});
    if(u.includes('/health/components')) return j([{id:'db',name:'Primary Database (supabase pooler, us-east-2)',status:'healthy',latencyMs:12}]);
    if(u.includes('/health/alerts')) return j([]);
    if(u.includes('/health')) return j({status:'ok',agents:13,agentStatusCounts:{idle:9,thinking:4},build:{sha:'3ff66e87',uptimeSeconds:4210},taskQueue:{attempts:4192,successes:4192,failures:0,verdict:'ok'},llmCapacity:{state:'available',pausedProviders:[]},memory:{rssMb:183,heapUsedMb:56,wsClients:1,tmpUsedMb:6.2}});
    if(u.includes('/agents')) return j({agents:Array.from({length:13},(_,i)=>({id:`apex-specialist-agent-${i}-001`,name:`Agent Number ${i} With A Deliberately Long Display Name`,role:'Specialist Engineer',status:i%3?'idle':'thinking',liveStatus:i%3?'idle':'thinking',currentTaskTitle:NASTY[0]}))});
    if(u.includes('/goals')) return j(Array.from({length:6},(_,i)=>({id:`g${i}`,title:`Launch Lead Generation & Outreach Campaign For Commercial Real Estate ${i}`,description:NASTY[1],status:'active',priority:1,assignedAgentId:'apex-ceo-001',createdAt:new Date().toISOString(),completedAt:null,result:null})));
    if(u.includes('/approvals/counts')) return j({pending:5});
    if(u.includes('/leads/stats')) return j({total:1284,byIndustry:{'commercial real estate':402,'law firms':311},byCity:{'Baton Rouge':210}});
    return j([]); });

  await page.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'domcontentloaded'}).catch(()=>{});
  await page.waitForTimeout(1200);

  const measure = async (viewName) => {
    const r = await page.evaluate((vw)=>{
      const de=document.documentElement, out=[];
      for(const el of Array.from(document.querySelectorAll('*'))){
        const b=el.getBoundingClientRect();
        if(b.width===0&&b.height===0) continue;
        const over=Math.round(b.right-vw);
        if(over>1){ const cs=getComputedStyle(el);
          // An element wider than the viewport is only a DEFECT if nothing
          // between it and the root contains it. A wide table inside an
          // overflow-x:auto scroller is working as designed, and an absolutely
          // positioned glow inside an overflow:hidden card is decoration.
          // Containment only counts when the user can still REACH the content,
          // i.e. a scrollable ancestor. `overflow-x: hidden` hides it, which is
          // the defect, not the fix.
          //
          // Crucially the walk stops before #root/body/html: index.css sets
          // overflow-x:hidden on #root at mobile widths as a last-resort guard,
          // so counting it as containment marks every element in the app as
          // contained and makes this whole check vacuously pass.
          const root=document.getElementById('root');
          let contained=false;
          for(let a=el.parentElement; a && a!==root && a!==document.body && a!==document.documentElement; a=a.parentElement){
            const ox=getComputedStyle(a).overflowX;
            if(ox==='auto'||ox==='scroll'){ contained=true; break; }
          }
          if(contained) continue;
          if(cs.position==='absolute'||cs.position==='fixed') continue;
          out.push({tag:el.tagName.toLowerCase(),over,w:Math.round(b.width),
            ws:cs.whiteSpace,minW:cs.minWidth,ovx:cs.overflowX,wb:cs.wordBreak,ow:cs.overflowWrap,
            txt:(el.textContent||'').trim().replace(/\s+/g,' ').slice(0,70)});
        }
      }
      out.sort((a,b)=>b.over-a.over);
      return { scroll: de.scrollWidth>de.clientWidth, sw:de.scrollWidth, cw:de.clientWidth, n:out.length, top:out.slice(0,6) };
    }, width);
    findings.push({ width, view: viewName, ...r });
  };

  // CANARY. This harness already produced one false all-clear: the ancestor
  // walk counted #root's own overflow-x:hidden as containment, so every element
  // was "contained" and the check passed vacuously. Prove the detector can
  // still see a known-bad element before trusting a clean run.
  await page.evaluate(() => {
    const c = document.createElement('div');
    c.id = '__overflow_canary__';
    c.textContent = 'canary';
    c.style.cssText = 'width:3000px;height:8px;background:transparent';
    document.getElementById('root')?.appendChild(c);
  });
  const canarySeen = await page.evaluate((vw) => {
    const el = document.getElementById('__overflow_canary__');
    return !!el && el.getBoundingClientRect().right - vw > 1;
  }, width);
  await page.evaluate(() => document.getElementById('__overflow_canary__')?.remove());
  if (!canarySeen) { console.error(`FATAL: canary not detected at ${width}px — the detector is blind, results are meaningless.`); process.exitCode = 2; }
  else console.log(`   canary detected at ${width}px — detector is live`);

  for (const label of BOTTOM) {
    await page.getByText(label, { exact:true }).first().click({ timeout:4000 }).catch(()=>{});
    await page.waitForTimeout(500); await measure(label);
  }
  for (const label of DRAWER) {
    await page.getByLabel('Open menu').click({ timeout:4000 }).catch(()=>{});
    await page.waitForTimeout(350);
    await page.getByText(label, { exact:true }).first().click({ timeout:4000 }).catch(()=>{});
    await page.waitForTimeout(600); await measure(label);
  }
  await ctx.close();
}
await browser.close(); server.close();

let bad=0;
for(const f of findings){
  const flag = f.scroll ? 'SCROLL' : (f.n>0 ? 'CLIPPED' : 'clean');
  if(f.scroll||f.n>0) bad++;
  if(flag==='clean') { console.log(`${String(f.width).padStart(3)}px  ${f.view.padEnd(14)} clean`); continue; }
  console.log(`${String(f.width).padStart(3)}px  ${f.view.padEnd(14)} ${flag}  sw=${f.sw}/cw=${f.cw}  ${f.n} el(s) past edge`);
  for(const o of f.top) console.log(`         +${String(o.over).padStart(4)}px <${o.tag}> w=${o.w} ws=${o.ws} minW=${o.minW} wb=${o.wb} ow=${o.ow}${o.txt?`\n              "${o.txt}"`:''}`);
}
console.log(`\n${bad}/${findings.length} view+width combinations have overflow`);
if (bad > 0) process.exitCode = 1;
if (process.exitCode === 2) console.error('Detector canary failed — treat the run as inconclusive, not as a pass.');
