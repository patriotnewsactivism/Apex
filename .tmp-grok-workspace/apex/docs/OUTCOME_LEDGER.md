# Unified Outcome Ledger

The Outcome Ledger is APEX's canonical, cross-portfolio evidence plane for answering one question: **what did the autonomous workforce actually accomplish for the business?**

It is intentionally not a second CRM. Source applications keep ownership of operational records. The ledger stores standardized, append-only evidence that connects intent and autonomous work to observable business action, result, cost, revenue, savings, and evaluation.

## Evidence chain

Every meaningful event can carry:

`INTENT -> AUTONOMOUS WORK -> CUSTOMER/BUSINESS ACTION -> RESULT -> COST -> REVENUE OR SAVINGS`

Missing links remain missing. The ledger never fills them with assumed dollars or assumed labor savings.

### Evidence classes

Every value-bearing claim uses exactly one class:

- `MEASURED` — directly observed from an authoritative source or explicit instrumented measurement.
- `ESTIMATED` — an explicit estimate with stated evidence/method. It is never merged into measured totals.
- `INFERRED` — derived from indirect evidence. It is never merged into measured totals.
- `UNKNOWN` — no defensible numeric assertion is made.

A later event may add better evidence, but an existing append-only record is never silently upgraded from estimated/inferred to measured.

## Canonical entity vocabulary

The common entity type vocabulary is:

`Organization`, `Customer`, `Lead`, `Opportunity`, `Campaign`, `Conversation`, `Call`, `Appointment`, `Task`, `AgentRun`, `WorkflowRun`, `Deployment`, `Incident`, `Approval`, `Experiment`, `RevenueEvent`, `CostEvent`, `Outcome`.

The ledger uses a typed entity registry rather than creating 18 competing copies of source-system business tables. `source_system + tenant_id + entity_type + external_id` identifies an entity across retries.

## Tables

- `outcome_entities` — canonical external entity identities and non-authoritative attributes.
- `outcome_entity_links` — cross-entity relationships and trace evidence.
- `outcome_events` — append-only activity facts with source, tenant, trace, agent/workflow and intent.
- `outcomes` — append-only measured/estimated/inferred/unknown business results.
- `revenue_events` — separately classified sourced/influenced/recognized/refund revenue facts.
- `cost_events` — separately classified provider, telephony, SMS, infrastructure, labor, and other cost facts.
- `experiments` — control/treatment experiment definitions.
- `experiment_assignments` — entity-to-cohort assignments.
- `experiment_observations` — append-only cohort metric observations.
- `outcome_audit_log` — ingestion/audit trail.

`outcome_events`, `outcomes`, `revenue_events`, `cost_events`, and `experiment_observations` reject UPDATE and DELETE operations at the database layer.

## Standard event envelope

A portfolio publisher POSTs one event or `{ "events": [...] }` to:

`POST /api/learning/outcome-ledger/events`

The durable idempotency key is the accounting boundary. Re-delivery is safe.

Example:

```json
{
  "schemaVersion": 1,
  "idempotencyKey": "buildmybot:lead:8a75:qualified",
  "source": "buildmybot",
  "organizationId": "org_123",
  "tenantId": "org_123",
  "occurredAt": "2026-09-07T17:00:00.000Z",
  "traceId": "lead:8a75",
  "intent": "Qualify an inbound lead",
  "activity": {
    "eventType": "lead.qualified",
    "responsibleAgentId": "sales-agent-4",
    "responsibleWorkflow": "lead-lifecycle",
    "humanIntervention": false
  },
  "entity": {
    "type": "Lead",
    "externalId": "8a75"
  },
  "outcome": {
    "outcomeType": "lead_qualification",
    "metricName": "lead_qualified",
    "measuredResult": true,
    "unit": "boolean",
    "classification": "MEASURED",
    "confidence": 1
  }
}
```

Money belongs in `revenueEvents` / `costEvents` or the explicit monetary fields of an outcome. Omission means unknown; omission does **not** mean zero.

## Authentication and tenancy

All read/analytics routes use normal APEX admin authentication.

Portfolio applications may receive `APEX_OUTCOME_INGEST_TOKEN`. That token is accepted only for the exact append-only endpoint:

`POST /api/learning/outcome-ledger/events`

It cannot read the ledger or access any other APEX API. This keeps a compromised portfolio publisher from inheriting control-plane authority.

Required APEX environment variables:

- `APEX_ADMIN_TOKEN` — existing operator credential.
- `APEX_OUTCOME_INGEST_TOKEN` — new shared service credential for standardized outcome publishers. Generate a high-entropy secret; do not reuse the admin token.

Each event must include `organizationId` and `tenantId`. Analytics can be tenant-scoped. APEX admin may intentionally query across tenants for portfolio-level views.

## APIs

- `POST /api/learning/outcome-ledger/events` — idempotent single/batch ingestion.
- `GET /api/learning/outcome-ledger/dashboard?tenant=<id>&window=1d|7d|30d|90d` — CEO/operator summary.
- `GET /api/learning/outcome-ledger/outcomes?tenant=<id>&limit=50` — recent canonical outcomes.
- `GET /api/learning/outcome-ledger/attribution?tenant=<id>&window=30d` — standardized funnel/event attribution counts.
- `GET /api/learning/outcome-ledger/experiments?tenant=<id>` — experiment definitions plus cohort observations.
- `POST /api/learning/outcome-ledger/experiments` — create/update experiment definition.
- `POST /api/learning/outcome-ledger/experiments/:id/assignments` — idempotently assign an entity to a cohort.
- `GET /api/learning/outcome-ledger/evaluation?tenant=<id>&window=30d` — `business_outcome_score` evidence for the evaluation platform.

## CEO/operator dashboard

The dashboard build publishes `/outcomes.html`. It reads the existing `apex_token` from the APEX login session and answers:

- What did the AI workforce accomplish in the selected window?
- What measured/estimated cost did it incur?
- What measured revenue did it source or influence?
- How many measured or estimated human hours were saved?
- Which workflows have positive measured direct ROI?
- Which agents have measured cost but no measured outcomes?
- What do control/treatment cohorts show?

The dashboard's measured direct ROI is deliberately conservative:

`(MEASURED sourced revenue - MEASURED cost) / MEASURED cost`

Influenced revenue is shown separately and is not counted in direct ROI.

## Evaluation integration

`BusinessOutcomeEvaluator` emits `business_outcome_score`. It uses only available measured components:

- measured quality: 35%
- measured target attainment: 35%
- measured direct commercial efficiency: 30%

Unavailable components are removed and remaining weights are renormalized. If no measured component is available the score is `null`, not zero and not a fabricated success. Evaluation confidence is a transparent sample-size heuristic and is returned separately from the score.

## Existing APEX evidence

The migration adds database triggers that mirror these existing facts into the ledger:

- `task_outcomes` -> engineering task completed/failed + measured task-success outcome.
- `researched_leads` -> sourced, enriched and status-change evidence.
- `deployments` -> deployment lifecycle evidence.

Those mirrors do not assign revenue, cost, or labor savings because the source rows do not contain authoritative values for them.

## Experiments

Create an experiment with a control cohort and one or more treatment cohorts. Assign Leads, Customers, Conversations, etc. to cohorts. Publisher events can then include:

```json
{
  "experiment": {
    "experimentId": "exp_followup_v2",
    "cohort": "treatment-v2",
    "metricName": "booking_rate",
    "value": 1,
    "classification": "MEASURED",
    "confidence": 1
  }
}
```

Recommended business experiment metrics include conversion rate, response rate, booking rate, resolution rate, retention, and operating cost. Compare cohorts only within the same defined experiment and metric; do not mix evidence classes without explicitly labeling them.

## Publishing from future portfolio businesses

A new product does not need APEX-specific database tables. It needs only:

1. A durable local outbox or equivalent transactional event mechanism.
2. Stable idempotency keys derived from the source business transaction.
3. `organizationId`, `tenantId`, source, event type, trace ID, and responsible workflow/agent where known.
4. Explicit evidence classification for every numeric business claim.
5. The scoped ingest token and APEX ledger URL.

Never call the ledger synchronously as a required step in a customer transaction. Commit the business transaction and its local outbox event together, then deliver asynchronously/retryably.

## Rollout

1. Deploy the APEX schema/API first and set `APEX_OUTCOME_INGEST_TOKEN`.
2. Verify the dashboard endpoint with an admin token.
3. Apply each portfolio application's local outbox migration.
4. Configure the portfolio service with `APEX_OUTCOME_LEDGER_URL` and the same scoped ingest token.
5. Send one synthetic **non-financial** test event with a unique tenant and confirm idempotent re-delivery produces one ledger event.
6. Enable real publishers. Do not backfill monetary claims unless a source system can provide authoritative historical amounts and evidence class.
