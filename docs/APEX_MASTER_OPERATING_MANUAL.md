# APEX Master Operating Manual, System Inventory, and Bug-Eradication Baseline

**Version:** 2026-09-24  
**Repository:** `patriotnewsactivism/apex`  
**Production:** Railway — project `APEX`, service `apex-backend`  
**Canonical production URL:** `https://apex.donmatthews.live`  
**Purpose:** One current, engineering-grade source that tells a human engineer or coding copilot what APEX is, what it controls, how the pieces fit together, what is verified, what is partial, what remains broken or unverified, and how to finish the system without reintroducing retired architecture.

> This document is a current-state consolidation. Live source and live production evidence still outrank documentation. If this document conflicts with live evidence, fix this document in the same change that establishes the new truth.

---

## 1. Executive definition

APEX is an autonomous AI workforce and operating control plane for engineering, business operations, lead research, sales execution, campaign management, cross-product orchestration, software delivery, health monitoring, learning, and measurable revenue operations.

It is not a chatbot wrapper. APEX accepts goals, decomposes them into durable work, assigns work through a 13-agent hierarchy, uses real tools, pauses for approvals when required, executes scheduled/background work, records state in Postgres, learns from outcomes, monitors itself, and exposes an operator dashboard/API.

The commercial system built around APEX can:

- discover and qualify target businesses or buyers;
- enrich prospects with company, decision-maker, contact, and contextual information;
- deduplicate and score leads;
- build individualized campaign strategy and messaging;
- operate email outreach with pacing, status, suppression, and webhook telemetry;
- support single outbound calls and telephony integration;
- receive/route inbound call workflows where configured;
- maintain lead/campaign/CRM-like state;
- coordinate follow-up and handoff;
- monitor replies, opens, clicks, bounces, complaints, call outcomes, appointments, opportunities, and revenue-oriented outcomes where the implementation records them;
- run software-engineering work through a persistent hierarchy;
- inspect, modify, test, build, deploy, and roll back software under approval policy;
- operate connected products such as BuildMyBot through product-specific connectors;
- monitor infrastructure, provider capacity, model use, queue health, artifacts, workers, scheduled work, and production provenance.

The near-term commercial form is **APEX Managed Pipeline**: the customer buys researched pipeline creation, personalized outreach, follow-up, qualified conversations/appointments, and measurable sales outcomes rather than “access to 13 AI agents.”

---

## 2. Documentation authority

Use this precedence when sources disagree:

1. live production evidence and current source;
2. `AGENTS.md`;
3. `docs/ARCHITECTURE_DECISIONS.md` and `docs/PRODUCTION_OPERATIONS.md`;
4. this master manual;
5. `README.md`, `docs/deploy-provenance.md`, `docs/APEX_ARCHITECTURE.md`;
6. `docs/APEX_CAPABILITY_MATRIX.md`, `CHECKLIST.md`, `ROADMAP.md`;
7. historical plans, handoffs, valuation reports, and dated incident notes.

Do not treat old Cloud Run, AWS Lightsail, Vapi-only, Convex-authoritative, or older model-routing instructions as current unless live source confirms them.

---

## 3. Production truth

### 3.1 Hosting

APEX production runs on Railway, not Cloud Run and not Vercel serverless.

- Railway project: `APEX`
- Railway service: `apex-backend`
- source: `main`
- build artifact: repository `Dockerfile`
- health endpoint: `/health`
- public origin: `https://apex.donmatthews.live`
- durable artifact directory on Railway: `/data/artifacts` when configured through `APEX_ARTIFACT_DIR`
- executor on Railway: in-process; `APEX_EXECUTOR_JOB` should remain unset unless architecture deliberately changes.

The Vercel project is a dashboard/static-build integration and GitHub status. It is not the APEX backend and must not become a production gate for Railway.

Cloud Run is a retired/rollback path only. GCP billing on the historical project was disabled. Do not restore or redirect production there without explicit operator direction.

### 3.2 Release truth

A deployment is not “done” because a commit merged or a build succeeded. Production verification requires:

1. green production CI;
2. exact intended commit identified;
3. Railway deployment completed;
4. `/health` returns healthy;
5. `/health.build.sha` matches the intended commit;
6. task queue and worker/autonomy health are acceptable;
7. the changed user path is smoke-tested.

### 3.3 Database authority

The live authoritative persistence layer is Postgres through `lib/db` and Drizzle schema/migrations.

The Convex backend is experimental and is **not** production authority. Do not dual-write or migrate production state into Convex merely because code exists there.

Never create or substitute a new production database because a management credential is missing. Runtime DB credentials and provider management-plane permissions are separate concerns.

---

## 4. Repository map

| Area | Responsibility |
|---|---|
| `packages/core/` | agent runtime, LLM routing, tool registry, task queue, approvals, memory, orchestration tools, provider failure/backpressure |
| `packages/agents/` | CEO/CTO/COO and specialist workforce definitions |
| `packages/api-server/` | REST/WebSocket control plane, auth, health, campaign/telephony/webhook routes |
| `packages/dashboard/` | operator UI |
| `packages/background-jobs/` | scheduler, recurring jobs, campaign runner |
| `packages/executor/` | heavy task execution; in-process on Railway |
| `packages/health-monitor/` | component health checks and alerts |
| `packages/learning-system/` | task outcomes, insights, strategy recommendations |
| `packages/predictive/` | forecasting/predictive functions |
| `packages/multiapp/` | cross-product application state/orchestration surface |
| `packages/cicd-automation/` | test/build/deploy/rollback automation |
| `packages/cicd-worker/` | experimental/legacy Convex CI/CD path; not production authority |
| `packages/convex-backend/` | experimental backend migration path |
| `packages/community-watch/` | advisory classification/drafting library; not fully wired |
| `lib/db/` | Postgres/Drizzle schema, migrations, crypto, data access |
| `scripts/` | deterministic verification, safety, routing, provenance, regression checks |
| `.agents/skills/apex-autopilot/` | coding-agent/autopilot operating skill and governance references |
| `docs/` | architecture, operations, model policy, campaigns, audits, incident history |

---

## 5. Workforce model

APEX uses a hierarchical 13-agent production organization. The operating model is role-based, but agents consume shared durable work rather than requiring 13 simultaneous LLM calls.

Core leadership and branches include:

- APEX CEO — goal intake, decomposition, delegation, portfolio-level direction, follow-through.
- CTO — engineering strategy, architecture, technical delegation.
- COO — business operations and revenue execution.
- Lead Developer — implementation coordination.
- Frontend — dashboard/client implementation.
- Backend — API, persistence, integrations.
- DevOps — hosting, deployment, infrastructure, reliability.
- QA / QA Director — independent verification, regression prevention, release quality.
- Sales — outreach strategy and execution.
- Customer Success / business specialists — handoff, customer/operational work.
- Lead Research — sourcing, enrichment, qualification, prospect intelligence.

Source definitions live under `packages/agents/src/`. The exact runtime roster must be taken from current source/live health rather than old screenshots or historical charters.

### Workforce operating rule

“Agent active” is not the KPI. Useful completed work is.

A healthy APEX may have roles waiting while the queue is empty, while a provider is cooling down, while work is awaiting approval, or while another role owns the current dependency. The dashboard must distinguish:

- idle because no work exists;
- queued;
- claimed/running;
- waiting on dependency;
- waiting on approval;
- paused for provider capacity;
- retry/backoff;
- checkpointed/yielded;
- failed;
- completed with verified outcome.

---

## 6. Goal, task, approval, and execution lifecycle

The canonical flow is:

**Goal → decomposition → durable tasks → assignment/claim → LLM reasoning if needed → tool execution → approval yield if gated → continuation/resume → verification → outcome → learning/telemetry.**

Important invariants:

- delegation is not completion;
- narration of a tool call is not execution;
- a queued task is not a finished task;
- an approval request must not occupy a live concurrency slot indefinitely;
- provider exhaustion is a capacity pause when a resume condition exists, not automatically an agent failure;
- repeated failures are defects until evidence proves recovery;
- scheduled work must deduplicate before creating duplicate live tasks;
- tasks must checkpoint/resume across long execution slices.

Durable approval continuations and long-task checkpointing are architectural requirements, not optional polish.

---

## 7. Approval and autonomy governance

APEX is autonomous inside defined boundaries and fail-closed for high-impact actions.

Hard-gated classes include production deploy/rollback, protected remote writes, externally sent communications where policy requires it, outbound calls, financial actions, destructive/schema database changes, and other irreversible actions designated by policy.

`runShell` remains approval-gated unless the authoritative policy is explicitly changed. Do not introduce a global approval bypass.

The system should auto-execute safe read/research/draft/local-analysis work where allowed, while keeping irreversible effects auditable.

A coding copilot fixing bugs must **not** weaken approval gates just to make a test pass or make the workforce “look active.”

---

## 8. LLM intelligence and routing

Production routing truth lives in `packages/core/src/llm-client.ts`.

Current architecture has a governed direct Qwen primary route, then a free-first chain, then one explicit paid continuity exception.

Current order documented by the repository:

1. Qwen3.8 Flash direct BYOK — governed operator-funded primary when enabled.
2. Nex N2.5 Mini Free.
3. Nex N2.5 Pro Free.
4. NVIDIA Nemotron 3 Super Free.
5. NVIDIA Nemotron 3.5 Lightning Free.
6. OpenRouter Free Router with tool requirements preserved.
7. NVIDIA Nemotron 3 Ultra Free.
8. direct Groq GPT-OSS 120B BYOK when enabled.
9. direct Gemini 3.8 Flash BYOK when enabled.
10. `z-ai/glm-5.3-flashx` — paid unrestricted continuity route, last resort.

DeepSeek V4 Flash 0731 is retired. MiniMax M3 Free is not a production route until reverified.

### OpenRouter accounts

Qualifying credential slots include:

- `OPENROUTER_FREE_API_KEY`
- `OPENROUTER_API_KEY`
- `OPENROUTER_API_KEY_2`
- `OPENROUTER_API_KEY_3`
- `OPENROUTER_API_KEY_4`

Multiple keys on one OpenRouter account do not create multiple quota pools. Account identity/unique-account telemetry must be used instead of assuming key count equals capacity.

### Routing requirements

- preserve structured tool calls;
- bounded retries;
- obey Retry-After and circuit breakers;
- rotate qualifying accounts on account-level capacity errors;
- cache reusable research;
- batch compatible work;
- use deterministic code instead of LLM calls for sorting, filtering, arithmetic, dedupe, scheduling, and templates;
- track served model separately from selected route;
- do not persist prompt/completion/tool-result content into model telemetry;
- adaptive routing cannot introduce models outside the operator-approved roster;
- provider capacity cannot bypass approval/security rules.

---

## 9. Turn economy and cost control

APEX should maximize **useful commercial work per request**, not raw request volume.

Required controls:

- every LLM request tied to a defined job/output;
- batch compatible records;
- enrich through conventional APIs before LLM reasoning;
- cache company summaries, qualification results, campaign components, and reusable facts;
- bounded retries and cooldowns;
- provider/account/request/token/cost telemetry;
- queue non-urgent work when constrained rather than thrashing;
- expose cost per useful result where possible;
- preserve scope isolation when bundling tasks.

Operational metrics should include request count, input/output tokens, cost, latency, retries, timeouts, rate limits, cache hits, batched work, provider failures, useful jobs completed, leads researched/qualified/rejected/deduped, outreach attempts, positive responses, appointments, opportunities, customers, and attributed revenue.

---

## 10. Lead research engine

APEX's lead engine is designed to:

1. receive an ICP, geography, vertical, exclusions, and commercial objective;
2. search business/data sources;
3. collect company information;
4. identify decision makers/contact information where available;
5. enrich records;
6. deduplicate;
7. score/qualify;
8. reject poor-fit or low-confidence records;
9. create prospect-specific research hooks;
10. persist researched leads for campaign use.

Known research integrations/configuration have included Brave Search, Firecrawl, Tavily, Google Places, Yelp, and other directory/search paths. Credentials must be verified from production configuration; missing keys must not be invented.

### Lead quality requirements

A lead count alone is not success. Track:

- unique qualified prospects;
- decision-maker coverage;
- verified email/phone coverage;
- duplicate rate;
- confidence;
- reason for qualification/rejection;
- source/provenance where practical;
- last verified/enriched timestamp;
- campaign eligibility/suppression state.

The system must never bury required structured contact fields only in free-text notes and then claim enrichment succeeded.

---

## 11. Campaign intelligence and personalization

For each qualified lead, APEX can build individualized campaign strategy using company/decision-maker context.

Campaign generation should produce:

- why the prospect fits;
- pain hypothesis grounded in evidence;
- offer alignment;
- personalization hook;
- channel strategy;
- email subject/body variants;
- call brief/talking points;
- objections and responses;
- follow-up cadence;
- desired conversion event;
- compliance/suppression considerations;
- confidence and QA status.

No two campaigns need be identical, but personalization must be factual. Never fabricate observations to make outreach appear researched.

---

## 12. Email outreach

Current repository capability includes:

- `emailCampaigns`, `emailSends`, and `emailSuppressions` persistence;
- one-off send/status tools;
- campaign enqueue;
- paced/resumable batch sending;
- pause/resume/cancel/read interfaces;
- Resend integration;
- signed webhook handling for delivery/open/click/bounce/complaint/failure events;
- automatic suppression on bounce/complaint;
- manual suppression/opt-out handling;
- human/approval oversight around sending.

The sending domain/provider configuration is an environment/deployment concern; secrets never belong in documentation.

### Email compliance gap

The historical capability matrix classifies email as working for send/observe but partial for compliance. Suppression after bounce/complaint/manual opt-out is not the same thing as a complete consent/compliance system.

Before scaling, verify:

- sender identity and physical-address/footer requirements where applicable;
- unsubscribe mechanism and immediate suppression;
- per-client suppression isolation;
- lawful-basis/consent fields if the selected market/workflow requires them;
- rate/pacing controls;
- bounce/complaint thresholds;
- domain reputation telemetry;
- idempotency so retries cannot duplicate sends.

---

## 13. Voice and telephony

Voice has evolved and must be treated carefully because historical docs mention Vapi while newer work uses Telnyx and BuildMyBot voice infrastructure.

Current source must be used to establish the active provider path before changing behavior.

Known capabilities/paths include:

- single outbound-call tooling;
- inbound assistant/number configuration paths;
- telephony webhooks;
- call outcome persistence/migrations;
- BuildMyBot integration for phone-agent workflows;
- sales-agent prompts/briefs;
- live call/campaign status work.

### Critical current requirement

Bulk outbound calling must not be assumed complete simply because single-call tools work. The older capability matrix explicitly identified the absence of a complete paced call-campaign runner at that audit point. Newer migrations include call-outcome work, so this must be re-audited against current source.

A production-ready call campaign requires:

- `call_campaigns`-equivalent durable campaign state;
- `call_sends`/attempt state;
- paced dialing and concurrency limits;
- retry policy;
- do-not-call/suppression checks;
- time-zone/calling-window enforcement;
- caller ID/provider state;
- recording-consent policy;
- outcome/disposition capture;
- callback/appointment/handoff;
- live status;
- cost/minute and campaign cost;
- idempotency against duplicate dials;
- approval policy aligned with operator governance.

Do not “fix” voice by bypassing provider verification, consent controls, or approval gates.

---

## 14. Sales and CRM/revenue operations

APEX's commercial workflow is intended to move records through:

**prospect → researched → qualified → campaign-ready → contacted → engaged → positive response → appointment/qualified conversation → opportunity → customer → attributed revenue / retention outcome.**

Revenue-operations schema/migrations exist in `lib/db`, including 2026-09 revenue-ops work and outcome backfill. The copilot should verify that the UI, API, agents, and database all use the same lifecycle vocabulary.

Every non-close should have a reason code where practical: unreachable, no authority, no need, no budget, wrong timing, wants proof, skeptical of quality, pricing objection, disqualified, opt-out, etc.

The KPI hierarchy is:

1. paying customers / MRR;
2. qualified held appointments and opportunities;
3. positive response rate;
4. qualified unique prospects;
5. useful jobs completed per model request;
6. gross margin and cost per customer.

Do not optimize the dashboard around vanity “agent activity.”

---

## 15. APEX Managed Pipeline commercial mode

The current commercial packaging is a managed outbound service.

The buyer is purchasing:

- ICP/market definition;
- target-account discovery;
- enrichment;
- qualification;
- individualized strategy;
- email/voice execution as enabled;
- follow-up;
- handoff/appointment flow;
- reporting;
- optimization from campaign outcomes.

A 30-day founder/pilot structure has been used as the initial commercialization motion. Pricing and promises must be verified against the current offer before customer-facing use.

Do not guarantee revenue or closed customers unless actual contract/performance evidence supports that guarantee.

---

## 16. BuildMyBot control/integration

APEX and BuildMyBot are separate products with a strategic bridge.

APEX has been designed to:

- read BuildMyBot workforce/product telemetry;
- issue briefings;
- trigger workers;
- dispatch engineering work;
- push researched leads;
- perform health checks;
- coordinate BuildMyBot as a portfolio application.

BuildMyBot provides customer-engagement surfaces such as chat, knowledge/RAG, voice, SMS, CRM/leads, billing, automation, and agency/reseller workflows.

APEX must not assume BuildMyBot marketing claims equal production capability. Verify current `patriotnewsactivism/buildmybot2` source/live system before promising a feature.

---

## 17. Software engineering and portfolio operations

APEX is also an engineering workforce.

It can coordinate:

- repository inspection;
- code changes;
- testing/lint/typecheck;
- build;
- QA;
- artifact creation;
- durable workspace synchronization;
- deployment hooks;
- deployment/rollback workflows;
- production health/provenance checks;
- cross-product task dispatch.

Durable project workspaces use artifact/workspace synchronization rather than trusting ephemeral container disk.

A code task is complete only after relevant tests/verification. A production task is complete only after live verification.

---

## 18. Scheduler, workers, and durable autonomy

APEX supports scheduled/recurring jobs and autonomous work generation.

Required behavior:

- scheduler state persisted;
- atomic/deduplicated claims;
- dynamic-job ceiling;
- minimum frequency floor;
- cron governor pauses/controls jobs rather than creating unbounded churn;
- work generation deduplicates from goals/opportunities/workstreams;
- dedicated worker/runtime heartbeats;
- `GET /api/autonomy` reports real unattended-work health;
- long tasks checkpoint and resume;
- approvals yield cleanly;
- retries/backlogs visible.

The copilot should test multi-instance claim safety and restart recovery rather than only single-process happy paths.

---

## 19. Memory and learning

APEX has memory and a learning system.

Memory requirements:

- semantic/vector recall when local embedding runtime is healthy;
- keyword fallback if embeddings fail;
- no silent long-term degradation;
- privacy-safe storage;
- durable context tied to appropriate work.

The Railway image was moved from Alpine to Debian slim to match the glibc dependency required by ONNX runtime. Production logs should remain free of the old local-embedding loader failure.

Learning requirements:

- task outcomes;
- model/provider telemetry;
- learning insights;
- strategy recommendations;
- model intelligence attribution;
- outcome-driven optimization;
- fail-safe behavior when evidence is insufficient.

Learning must never fabricate evidence or auto-broaden model/provider authority.

---

## 20. Health and observability

APEX must make failure visible.

Health/observability should cover:

- API;
- database;
- worker heartbeat;
- scheduler;
- queue depth/age;
- task success/failure/retry;
- approvals waiting;
- executor/checkpoints;
- LLM providers/accounts/models;
- provider cooldowns/rate limits;
- token/request/cost state;
- memory/vector recall;
- artifact/workspace store;
- WebSocket;
- lead-source integrations;
- email;
- voice;
- campaign state;
- connected applications;
- build SHA/provenance.

A green HTTP server with a dead worker is not healthy autonomy.

---

## 21. Security

Non-negotiable controls:

- admin authentication on protected API routes;
- no hardcoded admin credential fallback;
- long-lived admin token must not be placed in WebSocket URLs;
- short-lived/single-use WebSocket ticket flow;
- secrets only through environment/secret stores;
- never log secret values;
- constant-time secret comparison where implemented;
- tenant/client data isolation;
- fail-closed durable artifact tools when storage is unconfigured;
- approval gates for high-impact actions;
- auditability of side effects;
- no invented production credentials;
- no database/schema changes against an unverified target.

Any credential that has ever appeared in source, chat logs copied into source, public issue text, or documentation should be treated as requiring rotation/review.

---

## 22. CI/CD and regression guards

Production CI should continue to protect:

- typecheck/build;
- provider routing;
- provider backpressure;
- model routing policy;
- model intelligence;
- approval policy;
- outreach safety;
- deploy provenance;
- malformed tool calls;
- non-completion;
- retired-hosting instructions;
- token/request budget behavior;
- durable execution invariants.

When a bug is fixed, add the smallest deterministic regression test that would have caught it before the fix.

---

## 23. Known architectural debt and stale areas

The following require deliberate cleanup or verification rather than assumption:

1. **Historical documentation drift.** Some older files still describe Cloud Run as current production or carry obsolete hosting/provider statements.
2. **Convex parallel backend.** Experimental, behind live Postgres in historical audits, and not production authority.
3. **Convex CI/CD worker path.** Historically incomplete/broken for deploy/rollback; decide whether to finish or remove.
4. **Cross-repo Apex-Stream integration.** Historical audit found no live runtime contract between APEX and Apex-Stream.
5. **Community-watch.** Library exists but historically was not wired to route/scheduler.
6. **Bulk outbound call campaigns.** Must be reverified; older audit marked this missing even though newer call-outcome work now exists.
7. **Email compliance completeness.** Sending/observation works; full pre-send compliance/consent policy remains a separate concern.
8. **Multi-instance correctness.** Task/scheduler claim safety needs load verification whenever scaling replicas.
9. **Browser/runtime Git on Railway.** Historical cutover notes marked these unverified; current production must be tested.
10. **Model documentation drift.** Model order has changed repeatedly; source must remain the single runtime truth and docs/UI/tests must match it.
11. **Agent “activity” UX.** UI must not label a healthy waiting role as broken merely because it is not currently consuming an LLM request.
12. **Contact-field integrity.** Lead enrichment must populate structured email/phone/contact fields, not free-text only.
13. **Campaign state consistency.** UI/API/agent tools/database must share one state machine.
14. **Cost tracker completeness.** Costs must join provider/model work to lead/campaign/call/email/revenue outcomes.
15. **Production provenance.** Every deploy must continue exposing exact SHA.

---

## 24. Bug-eradication mission for Copilot/engineering agents

The next engineering pass should not begin by adding features. It should establish a verified baseline and eliminate defects in dependency order.

### Phase A — establish truth

1. Pull current `main`; record HEAD SHA.
2. Run `pnpm install --frozen-lockfile`.
3. Run production typecheck and build.
4. Run every deterministic verification script referenced by CI.
5. Read current `/health` and `/api/autonomy`.
6. Compare live build SHA to repository HEAD/deployed SHA.
7. Capture queue counts, failed/retrying tasks, waiting approvals, provider state, worker heartbeats, scheduler state, model routing, and campaign state.
8. Enumerate failing CI checks, runtime exceptions, 4xx/5xx endpoints, WebSocket failures, provider errors, and UI console errors.
9. Do not change code until each observed failure is assigned a reproducible test or diagnostic.

### Phase B — restore core autonomy

Fix in this order:

1. database connectivity/migrations;
2. worker heartbeat and task claiming;
3. scheduler/work generation;
4. LLM provider routing and account rotation;
5. task continuation/checkpoint/approval resume;
6. tool execution;
7. memory;
8. health telemetry.

Acceptance: submit a safe internal goal and observe it decompose, execute, verify, and close without manual database repair.

### Phase C — restore lead engine

Verify:

1. search providers;
2. geocode/directory caching;
3. lead ingestion;
4. structured contact fields;
5. dedupe;
6. qualification/scoring;
7. persistence;
8. campaign eligibility.

Acceptance: controlled target query produces unique qualified records with provenance and usable structured contact data, without duplicate runaway requests.

### Phase D — restore sales channels

Email:
- one test send;
- signed webhook;
- status transition;
- suppression;
- paced campaign;
- pause/resume/cancel;
- idempotent retry.

Voice:
- one controlled outbound call;
- inbound path if configured;
- provider webhook;
- outcome persistence;
- live status;
- callback/appointment handoff;
- paced bulk campaign only if the implementation now exists and compliance gates are satisfied.

Acceptance: one internal end-to-end campaign can move from qualified lead to channel execution to durable outcome.

### Phase E — restore dashboard/control surfaces

Verify every major page against backend truth:

- Agent Network;
- goals/tasks;
- approvals;
- leads;
- campaigns;
- sales channels;
- cost/spend;
- model intelligence;
- settings/providers;
- health;
- autonomy;
- connected applications.

No card may show “active,” “configured,” “healthy,” or “complete” from static/default state. It must be backed by live data.

### Phase F — production hardening

- regression tests for every fixed bug;
- remove dead duplicate paths where decision is already made;
- update stale docs;
- rotate/review exposed historical credentials;
- validate backup/rollback;
- load-test claims/queue/provider pacing;
- run a 24-hour autonomous soak before declaring the system stable.

---

## 25. Definition of done for a bug

A bug is closed only when all applicable items are true:

- root cause identified;
- reproducible before fix;
- implementation changed;
- regression test added;
- local typecheck/build green;
- relevant deterministic guards green;
- deployed if production-facing;
- live path verified;
- telemetry shows recovery;
- no safety control weakened;
- documentation updated if behavior/architecture changed.

“Agent says fixed,” “PR merged,” “build green,” or “deployment started” is not sufficient.

---

## 26. Copilot working rules

A coding copilot entering this repository should:

- read `AGENTS.md` first;
- read this manual;
- read `docs/PRODUCTION_OPERATIONS.md` before deployment work;
- read `docs/ARCHITECTURE_DECISIONS.md` before architectural changes;
- inspect current source before trusting historical handoffs;
- make small, testable changes;
- avoid parallel implementations of the same feature;
- prefer one canonical state machine/provider path;
- preserve approvals and fail-closed behavior;
- never invent credentials;
- never migrate production data to a new backend without explicit authorization;
- never claim live verification without observing live evidence;
- add regression coverage with every bug fix;
- update this manual when a capability materially changes.

---

## 27. Immediate verification checklist

Use this as the current “finish APEX” checklist:

- [ ] Production `/health` healthy and exact SHA verified.
- [ ] `/api/autonomy` shows healthy worker/scheduler and useful throughput.
- [ ] No unexplained failed/retrying/stalled task accumulation.
- [ ] All 13 workforce roles load correctly.
- [ ] Qwen/free/BYOK/FlashX routing matches current source and UI.
- [ ] Independent OpenRouter account detection is correct.
- [ ] Provider cooldown/backpressure works without deadlocking workforce.
- [ ] Vector memory works in Railway runtime; no ONNX/libc fallback errors.
- [ ] Durable artifacts/workspaces persist across restart.
- [ ] Browser/Chromium QA works on Railway.
- [ ] Runtime Git workspace operations work on Railway.
- [ ] Lead sourcing produces records at expected pace without request waste.
- [ ] Geocode/research caching prevents repeated paid/metered lookups.
- [ ] Structured email/phone/decision-maker fields persist.
- [ ] Dedupe and qualification work.
- [ ] Email one-off send works.
- [ ] Email campaign batching/pause/resume/cancel works.
- [ ] Resend webhook events persist and suppression works.
- [ ] Voice provider path is identified and documented as current.
- [ ] Controlled outbound call works.
- [ ] Inbound call path works if enabled.
- [ ] Call outcomes persist.
- [ ] Bulk call campaign runner status is conclusively WORKING/PARTIAL/MISSING.
- [ ] Appointment/callback/handoff path works.
- [ ] Cost tracker joins spend to provider/model/channel/campaign.
- [ ] Revenue/outcome ledger receives real outcomes.
- [ ] Dashboard cards reflect backend truth.
- [ ] WebSocket live status survives reconnect.
- [ ] Approval requests yield/resume durably.
- [ ] Hard-gated actions cannot be silently auto-approved.
- [ ] CI regression suite green.
- [ ] No retired Cloud Run/AWS instruction is presented as current production.
- [ ] Convex experimental paths cannot accidentally become production authority.
- [ ] 24-hour autonomous soak completes without critical unresolved incident.

---

## 28. Commercial acceptance test

The strongest end-to-end proof of APEX is not an agent-count screenshot. It is a controlled revenue workflow:

1. define one target vertical/ICP;
2. source a controlled batch;
3. dedupe and qualify;
4. enrich decision-maker/contact data;
5. generate individualized campaign plans;
6. QA;
7. send a controlled email batch;
8. make controlled calls where lawful/configured;
9. capture replies/call outcomes;
10. schedule or hand off qualified conversations;
11. update CRM/revenue state;
12. report cost, conversion, and next action;
13. learn from objections/results;
14. run the next batch better.

When that loop runs repeatedly without operator babysitting while preserving approvals and compliance boundaries, APEX is functioning as the autonomous sales operating system it is intended to be.

---

## 29. Current strategic bottom line

APEX already contains substantial autonomous-workforce infrastructure: durable goals/tasks, approvals, scheduling, provider routing, memory, health monitoring, learning, campaign/lead systems, software-delivery tooling, and cross-product connectors.

The remaining job is not to keep expanding the feature list blindly. The priority is to make every existing capability agree across source, database, API, dashboard, provider configuration, and live production; eliminate stale duplicate paths; close the remaining sales-channel and compliance gaps; and prove the entire system with repeatable end-to-end tests.

This document should be handed directly to Copilot or another engineering agent as the baseline. Its first assignment is **verification and bug elimination against current `main` and live Railway production**, not speculative redesign.
