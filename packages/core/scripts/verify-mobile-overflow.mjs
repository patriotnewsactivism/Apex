/**
 * Mobile horizontal-overflow check for the APEX dashboard.
 *
 * Drives the BUILT dashboard in Chromium at phone widths across every view and
 * reports anything that extends past the right edge of the screen. The panels
 * style with inline objects, which cannot carry a media query, so responsive
 * regressions here are invisible to any static check — they only show up when
 * something is actually laid out.
 *
 * Runs in CI as the `mobile-layout` job in .github/workflows/ci.yml, which
 * installs the browser itself via `playwright install --with-deps chromium`.
 * deploy.yml gates on the whole CI workflow's conclusion, so a failure here
 * blocks production deploys — that is deliberate.
 *
 * To run it locally after touching dashboard layout:
 *
 *   pnpm --filter @workspace/dashboard run build
 *   node packages/core/scripts/verify-mobile-overflow.mjs
 *
 * PLAYWRIGHT_CHROMIUM overrides the browser path, for a sandbox that ships a
 * prebuilt Chromium at a version Playwright's own resolution would miss:
 *
 *   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *     node packages/core/scripts/verify-mobile-overflow.mjs
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
import { readFileSync } from 'fs';
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
  'ERROR provider chain exhausted: openrouter/glm-5.3-flashx 429 upstream_rate_limit; openrouter/free cooldown 30s; gemini unavailable',
];
const BOTTOM = [
  { id: 'command', label: 'Command' },
  { id: 'sales-ops', label: 'Revenue' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'agents', label: 'Workforce' },
  { id: 'settings', label: 'Settings' },
];
const DRAWER = [
  { id: 'chat', label: 'Talk to APEX' },
  { id: 'pending-sends', label: 'Pending sends' },
  { id: 'sales-ops', label: 'Revenue Operations' },
  { id: 'territories', label: 'Territories' },
  { id: 'webinars', label: 'Webinar Director' },
  { id: 'reporting', label: 'Reporting' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'mission', label: 'Mission Control' },
  { id: 'tasks', label: 'Work Queue' },
  { id: 'logs', label: 'Activity Log' },
  { id: 'leads', label: 'Prospects' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'deals', label: 'Pipeline' },
  { id: 'companies', label: 'Companies' },
  { id: 'suggestions', label: 'Suggestions' },
  { id: 'multiapp', label: 'Portfolio' },
  { id: 'control', label: 'Control Room' },
  { id: 'verify-scale', label: 'Verify & Scale' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'scheduled', label: 'Calendar / Scheduler' },
  { id: 'health', label: 'Health' },
  { id: 'learning', label: 'Intelligence' },
  { id: 'pipeline', label: 'CI/CD' },
  { id: 'spend', label: 'Spend / Burn' },
];

// Every sidebar nav id in App.tsx mapped to its exact visible label. Bottom-bar
// labels are intentionally shorter, so its click targets live in BOTTOM above.
//
// This exists because the view list silently fell behind the app twice: the
// 'Cron Registry' and 'Artifacts' panels shipped and the harness kept printing
// a clean result for the views it did know about, never opening the new ones.
// A clean run that skipped a view is the same lie as a clean run that could not
// see overflow, so an unknown id is FATAL rather than a warning.
const NAV_ID_TO_LABEL = {
  command: 'Command Center', chat: 'Talk to APEX', mission: 'Mission Control', approvals: 'Approvals', 'pending-sends': 'Pending sends',
  agents: 'Agent Network', tasks: 'Work Queue', logs: 'Activity Log',
  'sales-ops': 'Revenue Operations', leads: 'Prospects', contacts: 'Contacts', deals: 'Pipeline', companies: 'Companies', territories: 'Territories', webinars: 'Webinar Director', reporting: 'Reporting', integrations: 'Integrations', suggestions: 'Suggestions',
  multiapp: 'Portfolio', control: 'Control Room', 'verify-scale': 'Verify & Scale', artifacts: 'Artifacts',
  scheduled: 'Calendar / Scheduler', health: 'Health', learning: 'Intelligence',
  pipeline: 'CI/CD', spend: 'Spend / Burn', settings: 'Settings',
};

{
  const appTsx = new URL('../../dashboard/src/App.tsx', import.meta.url);
  let src = '';
  try { src = readFileSync(appTsx, 'utf8'); } catch { /* checked below */ }
  if (!src) {
    console.error(`FATAL: cannot read ${appTsx.pathname} to verify view coverage.`);
    process.exit(2);
  }
  const navIds = [...src.matchAll(/\{ id: '([^']+)', label: '([^']+)'/g)];
  if (navIds.length === 0) {
    console.error('FATAL: found no nav items in App.tsx — the nav shape changed, coverage is unverifiable.');
    process.exit(2);
  }
  const checked = new Set([...BOTTOM, ...DRAWER].map(({ id }) => id));
  const missing = navIds
    .filter(([, id, label]) => !NAV_ID_TO_LABEL[id] || !checked.has(id) || NAV_ID_TO_LABEL[id] !== label)
    .map(([, id, label]) => `${id} ("${label}")`);
  if (missing.length) {
    console.error(`FATAL: ${missing.length} view(s) in App.tsx are not checked by this harness:`);
    for (const m of missing) console.error(`   ${m}`);
    console.error('Add each to NAV_ID_TO_LABEL and to BOTTOM or DRAWER, then re-run.');
    process.exit(2);
  }
  console.log(`   view coverage: all ${navIds.length} nav views are checked`);
}
const WIDTHS = [360, 390, 430];
const SALES_OPS_SUBTABS = ['Overview', 'Calls', 'SMS', 'Email', 'Automation', 'Lead Campaigns'];

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
  // A React tree that throws during render unmounts to an empty #root. That
  // page cannot overflow, so without this the harness reports the crashed view
  // as "clean" — a second way for this check to pass vacuously, after the
  // canary. Track the throw and the rendered element count, and fail on both.
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.route('**/api/**', (route)=>{ const u=route.request().url();
    const j=(b)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(b)});
    const webinarSession = {
      id:'webinar-mobile-test', slug:'mobile-test',
      title:'The AI Workforce: APEX + BuildMyBot Live — Deliberately Long Mobile Broadcast Title',
      description:'A live demonstration with intentionally long content to prove the broadcast screen wraps correctly on narrow phones.',
      host_name:'Matthew Reardon', hostName:'Matthew Reardon',
      mode:'autonomous', status:'live', autonomous:true, current_segment:1, currentSegment:1,
      segment_started_at:new Date().toISOString(), segmentStartedAt:new Date().toISOString(),
      started_at:new Date().toISOString(), startedAt:new Date().toISOString(),
      ended_at:null, cta_label:'Explore BuildMyBot.app', ctaLabel:'Explore BuildMyBot.app',
      cta_url:'https://buildmybot.app', ctaUrl:'https://buildmybot.app',
      created_at:new Date().toISOString(), updated_at:new Date().toISOString(),
      attendee_count:24, question_count:7,
    };
    const webinarSegments = Array.from({length:6},(_,i)=>({
      id:i===1?'roi':`segment-${i}`,
      title:i===1?'Live ROI: Turning Missed Calls Into Recoverable Revenue':'A Long Webinar Segment Title That Must Wrap Cleanly On Mobile',
      kicker:i===1?'LIVE WORKSHEET':'APEX LIVE DEMO',
      durationSeconds:480,
      bullets:[
        NASTY[0],
        'Every prospect is verified against the real business website before it is campaign-ready.',
        'Mobile viewers and operators must be able to reach every control without horizontal page scrolling.',
      ],
      narration:'',
      demoCue:'Open the live APEX lead screen and demonstrate verified business identity, contact recovery, and the campaign-ready funnel.',
    }));
    const webinarAttendees = Array.from({length:8},(_,i)=>({
      id:`attendee-${i}`, name:`Attendee Number ${i} With A Long Name`,
      email:`very.long.attendee.${i}@example-business-domain.com`,
      company:'Commercial Roofing & Restoration Company With A Long Name',
      phone:'+1 832 555 0199', engagement_score:18+i*3,
      joined_at:new Date().toISOString(), last_seen_at:new Date().toISOString(),
    }));
    const webinarQuestions = Array.from({length:5},(_,i)=>({
      id:`q-${i}`, attendee_id:`attendee-${i}`,
      question:'How does APEX verify that a company and its contact information are real before starting a campaign?',
      answer:'APEX checks the first-party business website, contact sources, and pipeline verification state before the prospect becomes campaign-ready.',
      status:'answered', created_at:new Date().toISOString(), answered_at:new Date().toISOString(),
    }));
    if(u.includes('/webinar/admin/sessions')) return j({sessions:[webinarSession]});
    if(u.includes('/webinar/admin/webinar-mobile-test/dashboard')) return j({
      session:webinarSession, segments:webinarSegments, attendees:webinarAttendees, questions:webinarQuestions,
      producer:{timing:'on_track',elapsedSeconds:205,targetSeconds:480,secondsRemaining:275,
        recommendation:'Stay on this segment while the live lead verification finishes, then move into the call demonstration.',
        highIntentCount:4,topLeadNames:['Attendee Number 6 With A Long Name','Attendee Number 7 With A Long Name'],questionCount:5},
    });
    if(u.includes('/webinar/public/mobile-test')) return j({
      session:{...webinarSession,currentSegment:1},
      currentSegment:webinarSegments[1],segments:webinarSegments,attendeeCount:24,
      questions:webinarQuestions.map(q=>({id:q.id,question:q.question,answer:q.answer,status:q.status,createdAt:q.created_at,answeredAt:q.answered_at})),
      events:[],
    });
    if(u.includes('/sales-ops/overview')) return j({
      generatedAt: new Date().toISOString(), autonomyLevel: 'balanced',
      autonomyPresets: [
        {id:'balanced',label:'Balanced — goal review every 15 min (default)'},
        {id:'aggressive',label:'Aggressive — goal review every 10 min, max throughput'},
      ],
      spend: {spentUsd:1.25,projectedUsd:2.5,capUsd:10,remainingUsd:8.75,state:'ok',pacingEnabled:true,persistence:'durable',providers:[{provider:'openrouter',spentUsd:1.25}]},
      runningCost: {todayUsd:1.75,llmSpendTodayUsd:1.25,callSpendTodayUsd:0.5,projectedLlmUsd:2.5,dailyCapUsd:10},
      calls: {placedToday:2,placedTotal:10,completedToday:1,completedTotal:9,checkoutLinksTotal:3,spendTodayUsd:0.5,spendTotalUsd:4.5},
      emails: {sentToday:12,total:200,byStatus:{delivered:180,opened:90,bounced:2}},
      leads: {total:1284,byStatus:{new:200,contacted:600,qualified:400,converted:84}},
      campaigns: {leadRunning:2,emailRunning:1},
    });
    if(u.includes('/auth/websocket-ticket')) return j({ticket:'tkt'});
    if(u.includes('/health/components')) return j([{id:'db',name:'Primary Database (supabase pooler, us-east-2)',status:'healthy',latencyMs:12}]);
    if(u.includes('/health/alerts')) return j([]);
    if(u.includes('/health')) return j({status:'ok',agents:13,agentStatusCounts:{idle:9,thinking:4},build:{sha:'3ff66e87',uptimeSeconds:4210},taskQueue:{attempts:4192,successes:4192,failures:0,verdict:'ok'},llmCapacity:{state:'available',pausedProviders:[]},memory:{rssMb:183,heapUsedMb:56,wsClients:1,tmpUsedMb:6.2}});
    if(u.includes('/agents')) return j({agents:Array.from({length:13},(_,i)=>({id:`apex-specialist-agent-${i}-001`,name:`Agent Number ${i} With A Deliberately Long Display Name`,role:'Specialist Engineer',status:i%3?'idle':'thinking',liveStatus:i%3?'idle':'thinking',currentTaskTitle:NASTY[0]}))});
    if(u.includes('/goals')) return j(Array.from({length:6},(_,i)=>({id:`g${i}`,title:`Launch Lead Generation & Outreach Campaign For Commercial Real Estate ${i}`,description:NASTY[1],status:'active',priority:1,assignedAgentId:'apex-ceo-001',createdAt:new Date().toISOString(),completedAt:null,result:null})));
    if(u.includes('/approvals/counts')) return j({pending:5});
    if(u.includes('/leads/stats')) return j({total:1284,byIndustry:{'commercial real estate':402,'law firms':311},byCity:{'Baton Rouge':210}});
    if(u.includes('/crm/gmail/status')) return j({enabled:false,scope:'https://www.googleapis.com/auth/gmail.readonly',sends:false});
    // CRM phase 1: the panels the operator works in. Without these the harness
    // would exercise the new views against an empty payload and call the blank
    // render clean.
    if(u.includes('/crm/contacts/statuses')) return j({stages:['prospect','lead','qualified','client','churned'],priorities:['low','normal','high']});
    if(u.includes('/crm/tasks/due')) return j({date:'2026-10-11',timezone:'America/Chicago',tasks:[
      {id:'task-1',title:'Ring back the newsroom desk about the records request and the follow-up interview',notes:null,kind:'follow_up',status:'open',priority:'high',dueAt:new Date().toISOString(),dueChicago:'Oct 11, 2026, 9:00 AM',contactId:'contact-1',contactName:'Pat Newsroom Directory Contact With A Very Long Legal Name',contactOrganization:'Baton Rouge Investigative Desk And Publishing Cooperative',overdue:false},
      {id:'task-2',title:'Send the signed retainer',notes:null,kind:'follow_up',status:'open',priority:'normal',dueAt:new Date(Date.now()-86400000).toISOString(),dueChicago:'Oct 10, 2026, 9:00 AM',contactId:'contact-1',contactName:'Pat Newsroom',contactOrganization:'Baton Rouge Investigative Desk',overdue:true},
    ]});
    if(u.includes('/crm/tasks')) return j({timezone:'America/Chicago',tasks:[
      {id:'task-1',title:'Ring back the newsroom desk',notes:null,kind:'follow_up',status:'open',priority:'high',dueAt:new Date().toISOString(),dueChicago:'Oct 11, 2026, 9:00 AM',contactId:'contact-1',contactName:'Pat Newsroom',contactOrganization:'Baton Rouge Investigative Desk',overdue:false},
    ]});
    if(u.includes('/crm/suppressions')) return j({timezone:'America/Chicago',suppressions:[
      {id:'sup-1',channel:'all',reason:'dnc',source:'cartesia_sales_call',email:null,phoneE164:'+12255550199',createdAt:new Date().toISOString(),expiresAt:null,liftedAt:null,liftedBy:null,liftReason:null},
      {id:'sup-2',channel:'email',reason:'unsubscribed',source:'webhook',email:'editor@baton-rouge-investigative-desk.example',phoneE164:null,createdAt:new Date().toISOString(),expiresAt:null,liftedAt:new Date().toISOString(),liftedBy:'Matthew',liftReason:'they asked us to resume'},
    ]});
    if(u.includes('/crm/contacts/') && u.includes('/suppressions')) return j({suppressions:[
      {id:'sup-1',channel:'all',reason:'dnc',source:'cartesia_sales_call',email:null,phoneE164:'+12255550199',createdAt:new Date().toISOString(),expiresAt:null,liftedAt:null,liftedBy:null,liftReason:null},
    ]});
    if(u.includes('/crm/leads/imports')) return j({imports:[
      {id:'batch-1',status:'applied',appliedBy:'Matthew',appliedAt:new Date().toISOString(),undoneAt:null,createdCount:12,matched:3,skippedCount:1,notes:null},
    ]});
    if(u.includes('/crm/leads')) return j({recordType:'lead',leads:[]});
    // CRM phase 2: the pipeline board and the company page. A stage column and a
    // deal both carry long real-world strings on purpose — a board that only
    // looks clean with short names is not clean.
    const deal=(i,stageId)=>({id:`deal-${i}`,name:`Documentary rights package for the Baton Rouge investigative desk, season ${i}`,
      status:'open',amountCents:'1250000.00',amountUsd:12500,probability:0.4,expectedCloseAt:new Date().toISOString(),
      expectedCloseChicago:'Oct 24, 2026, 3:00 PM',closedAt:null,nextStep:'Send the updated scope and the two-year archive licence',
      lostReason:null,wonReason:null,notes:null,stageId,stageName:null,stagePosition:null,contactId:'contact-1',
      contactName:'Pat Newsroom Directory Contact With A Very Long Legal Name',companyId:'company-1',
      companyName:'Baton Rouge Investigative Desk And Publishing Cooperative',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    if(u.includes('/crm/pipeline')) return j({timezone:'America/Chicago',
      stages:[{id:'stage-1',name:'Qualified',position:1,deals:[deal(1,'stage-1')],totalUsd:12500},
              {id:'stage-2',name:'Proposal sent',position:2,deals:[deal(2,'stage-2'),deal(3,'stage-2')],totalUsd:25000},
              {id:'stage-3',name:'Negotiation',position:3,deals:[],totalUsd:0},
              {id:'stage-4',name:'Verbal yes',position:4,deals:[],totalUsd:0}],
      unassigned:{deals:[],totalUsd:0},
      open:{count:3,totalUsd:37500,weightedUsd:15000,closingThisMonthUsd:25000},
      closed:{won:2,lost:1,wonUsd:24000,lostUsd:3000}});
    if(u.includes('/crm/companies/company-1')) return j({timezone:'America/Chicago',
      company:{id:'company-1',name:'Baton Rouge Investigative Desk And Publishing Cooperative',domain:'baton-rouge-investigative-desk.example',website:'https://baton-rouge-investigative-desk.example',industry:'Investigative publishing',employeeCount:24,source:'manual'},
      contacts:[{id:'contact-1',name:'Pat Newsroom Directory Contact With A Very Long Legal Name',email:'editor@baton-rouge-investigative-desk.example',phoneE164:'+12255550199',title:'Editor in chief',city:'Baton Rouge',state:'LA',lifecycleStage:'qualified',doNotContact:false,lastContactedAt:new Date().toISOString(),nextFollowUpAt:new Date().toISOString()}],
      deals:[deal(1,'stage-1')],totals:{openValueUsd:12500,openCount:1,wonValueUsd:24000,wonCount:2,lostCount:1},openTasks:2,
      lastActivityAt:new Date().toISOString(),lastActivityChicago:'Oct 11, 2026, 9:00 AM'});
    if(u.includes('/crm/companies')) return j({timezone:'America/Chicago',companies:[
      {id:'company-1',name:'Baton Rouge Investigative Desk And Publishing Cooperative',domain:'baton-rouge-investigative-desk.example',website:'https://baton-rouge-investigative-desk.example',industry:'Investigative publishing',employeeCount:24,contactCount:3,openDeals:1,openValueUsd:12500,wonValueUsd:24000},
      {id:'company-2',name:'Gulf Coast Records Cooperative',domain:'gulf-coast-records.example',website:null,industry:'Archival services',employeeCount:8,contactCount:1,openDeals:0,openValueUsd:0,wonValueUsd:0},
    ]});
    if(u.includes('/crm/unmatched')) return j([{id:'unmatched-1',fromAddress:'tips@baton-rouge-investigative-desk.example',subject:NASTY[0],bodyText:'Unmatched inbound note',receivedAt:new Date().toISOString()}]);
    if(u.includes('/crm/duplicates')) return j([{kind:'domain',value:'baton-rouge-investigative-desk.example',contactIds:['contact-1','contact-2']}]);
    if(u.includes('/crm/contacts/') && !u.includes('/export')) return j({
      timezone:'America/Chicago',
      contact:{id:'contact-1',firstName:'Pat',lastName:'Newsroom',organizationName:'Baton Rouge Investigative Desk',email:'editor@baton-rouge-investigative-desk.example',phoneE164:'+12255550199',city:'Baton Rouge',state:'LA',tags:['newsroom','tier-A'],notes:NASTY[1],doNotContact:false,ownerBot:'newsroom-bot',website:'https://baton-rouge-investigative-desk.example',lifecycleStage:'qualified',lifecycleStageChangedAt:new Date().toISOString(),lifecycleStageChangedBy:'Matthew',nextFollowUpAt:new Date().toISOString(),nextFollowUpChicago:'Oct 11, 2026, 9:00 AM'},
      identifiers:[{id:'id-1',kind:'email',value:'editor@baton-rouge-investigative-desk.example',verified:true,sourceUrl:'https://baton-rouge-investigative-desk.example/contact',foundAt:new Date().toISOString()}],
      meetings:[],
      timeline:[{id:'tl-1',occurredAt:new Date().toISOString(),occurredChicago:'Oct 3, 2026, 3:13 PM',channel:'email',direction:'inbound',actorName:'Pat Newsroom',eventKind:'reply',subject:'Tip',bodyText:NASTY[1],attachments:[]}],
    });
    if(u.includes('/crm/contacts')) return j({timezone:'America/Chicago',contacts:[{
      id:'contact-1',firstName:'Pat',lastName:'Newsroom Directory Contact With A Very Long Legal Name',
      organizationName:'Baton Rouge Investigative Desk And Publishing Cooperative',
      email:'editor@baton-rouge-investigative-desk.example',phoneE164:'+12255550199',city:'Baton Rouge',state:'LA',
      tags:['newsroom','tier-A'],doNotContact:false,ownerBot:'newsroom-bot',notes:NASTY[1],
      lastContactedAt:new Date().toISOString(),lastReplyAt:null,lastContactedChicago:'Oct 3, 2026, 3:13 PM',lastReplyChicago:null,
      lifecycleStage:'lead',lifecycleStageChangedAt:new Date().toISOString(),lifecycleStageChangedBy:'Matthew',
      nextFollowUpAt:new Date().toISOString(),nextFollowUpChicago:'Oct 11, 2026, 9:00 AM',
    }]});
    return j([]); });

  await page.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'domcontentloaded'}).catch(()=>{});
  await page.waitForTimeout(1200);

  /** Measure uncontained horizontal overflow and render failures for one view. */
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
      const root=document.getElementById('root');
      return { scroll: de.scrollWidth>de.clientWidth, sw:de.scrollWidth, cw:de.clientWidth, n:out.length, top:out.slice(0,6),
               els: root ? root.querySelectorAll('*').length : 0,
               chars: (root?.innerText || '').trim().length };
    }, width);
    // Errors are cumulative across the context; attribute only the new ones.
    const errs = pageErrors.splice(0);
    findings.push({ width, view: viewName, errs, ...r });
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

  for (const { label } of BOTTOM) {
    await page.getByText(label, { exact:true }).first().click({ timeout:4000 });
    await page.waitForTimeout(500); await measure(label);
  }
  for (const { id, label } of DRAWER) {
    await page.getByLabel('Open menu').click({ timeout:4000 });
    await page.waitForTimeout(350);
    const item = page.locator(`#nav-${id}`);
    if (!await item.isVisible()) {
      await page.getByText('More systems', { exact:true }).click({ timeout:4000 });
    }
    // The drawer scrolls on its own, independently of the page. With 26 views
    // the lower items sit past its visible edge, where Playwright's own
    // scroll-into-view scrolls the page rather than the drawer, the click point
    // stays under the fixed chrome, and the click retries until it times out.
    // Scroll the item inside the drawer first, then click it for real.
    await item.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await page.waitForTimeout(120);
    await item.click({ timeout:8000 });
    await page.waitForTimeout(600); await measure(label);

    // Sales Operations consolidated three former top-level pages (Campaigns,
    // Automation, Email Campaigns) into one page with in-page sub-tabs. A
    // drawer click only ever renders the default sub-tab, so without this the
    // other five sub-tabs would silently lose the overflow coverage they had
    // as standalone pages — the same class of gap the view-coverage check
    // above exists to catch, just one level deeper.
    if (id === 'sales-ops') {
      for (const sub of SALES_OPS_SUBTABS) {
        await page.getByText(sub, { exact:true }).first().click({ timeout:4000 }).catch(()=>{});
        await page.waitForTimeout(500); await measure(`Sales Ops › ${sub}`);
      }
    }
  }

  // The public attendee room bypasses the dashboard navigation entirely, so
  // exercise its LIVE stage separately. Seed a joined attendee to render the
  // actual broadcast view instead of only the registration form.
  await page.evaluate(() => sessionStorage.setItem('apex-webinar-mobile-test', 'attendee-test'));
  await page.goto(`http://127.0.0.1:${PORT}/webinar/mobile-test`, {waitUntil:'domcontentloaded'}).catch(()=>{});
  await page.waitForTimeout(700);
  await measure('Public Webinar Room');

  await ctx.close();
}
await browser.close(); server.close();

// A view that rendered almost nothing is not clean, it is broken. Real views
// run to hundreds of elements; a crashed one is empty.
const MIN_ELEMENTS = 10;

let bad=0;
for(const f of findings){
  const blank = f.els < MIN_ELEMENTS || f.errs.length > 0;
  const flag = blank ? 'BLANK' : f.scroll ? 'SCROLL' : (f.n>0 ? 'CLIPPED' : 'clean');
  if(blank||f.scroll||f.n>0) bad++;
  if(flag==='clean') { console.log(`${String(f.width).padStart(3)}px  ${f.view.padEnd(14)} clean`); continue; }
  if(blank){
    console.log(`${String(f.width).padStart(3)}px  ${f.view.padEnd(14)} BLANK  ${f.els} element(s), ${f.chars} chars rendered`);
    for(const e of f.errs) console.log(`         uncaught: ${e}`);
    continue;
  }
  console.log(`${String(f.width).padStart(3)}px  ${f.view.padEnd(14)} ${flag}  sw=${f.sw}/cw=${f.cw}  ${f.n} el(s) past edge`);
  for(const o of f.top) console.log(`         +${String(o.over).padStart(4)}px <${o.tag}> w=${o.w} ws=${o.ws} minW=${o.minW} wb=${o.wb} ow=${o.ow}${o.txt?`\n              "${o.txt}"`:''}`);
}
console.log(`\n${bad}/${findings.length} view+width combinations failed (overflow or blank render)`);
if (bad > 0) process.exitCode = 1;
if (process.exitCode === 2) console.error('Detector canary failed — treat the run as inconclusive, not as a pass.');
