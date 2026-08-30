# APEX Model Intelligence

_Last verified against source and CI: 2026-08-30._

APEX uses OpenRouter as its production LLM gateway, but model selection is an operator-governed learning problem rather than a static provider list.

## Goals

The Model Intelligence layer answers a practical question with production evidence:

> For this APEX role and this kind of task, which model in the operator-approved roster gives the best observed outcome for the chosen quality/cost/latency objective?

It does **not** treat price, context length, model branding, or a synthetic dashboard heuristic as proof of intelligence.

## Operator authority

The authenticated Settings → OpenRouter Model Control panel owns the admissible model roster.

APEX must never use Model Intelligence to add an unselected model. The operator may also pin a selected model as a role-specific first choice; that pin is stronger than learned ranking and remains first in every routing mode.

The three routing modes are:

- **Manual** — use the exact operator order. Evidence is collected but never changes routing.
- **Advisor** — use the exact operator order and show evidence-backed recommendations for review.
- **Adaptive** — allow evidence-qualified models to reorder within the selected roster. Under-sampled models keep their operator-defined positions. Role pins remain first.

Old saved policies that predate these fields parse as `manual`, preserving their original behavior.

## Evidence threshold

Adaptive routing is deliberately conservative. A model must have at least the configured number of completed-task outcomes before it can move automatically. The policy supports 2–100 samples; the UI defaults to 5 and offers practical higher thresholds.

At least two models must be evidence-qualified before adaptive ranking can change the order. A single qualified model is not a comparison.

## Controlled learning trials

A pure fallback chain can create a learning dead zone: if model #1 normally succeeds, later selected models may never accumulate enough real task evidence to challenge it.

APEX therefore supports an **optional controlled learning trial rate**. The default is `0` (off), including for all policies saved before the feature existed.

When enabled, trials are restricted by all of these rules:

- Adaptive mode only;
- selected models only;
- hard-capped to 25% of eligible tasks;
- only tasks with a pre-run complexity hint of `0.5` or below;
- disabled whenever that role has an explicit model pin;
- deterministic per task ID so retries/workers make the same trial decision;
- chooses the least-sampled under-threshold selected model rather than a random model;
- preserves every selected fallback exactly once.

Trials collect comparative evidence; they are not permission to weaken task completion, tool, approval, or spend controls.

## Smart complexity escalation

The operator may optionally enable **Smart complexity escalation**. It is off by default and is separate from Adaptive routing authority.

When enabled, APEX derives an **effective objective** from the operator's saved base objective and the task's pre-run complexity hint:

- complexity `>= 0.70`: use the `quality` objective, even if the base objective is budget/speed/balanced;
- complexity `<= 0.35`: a neutral `balanced` base objective shifts to `budget` so routine work can prefer proven value;
- middle-complexity work keeps the saved base objective;
- explicit `quality`, `budget`, or `speed` choices are preserved for routine work;
- if no complexity hint exists, the base objective is preserved;
- role-specific model pins remain stronger than escalation.

This is intentionally deterministic and transparent. The Settings intelligence view reports both the base objective and effective objective when they differ.

Complexity escalation does not make an under-sampled model eligible for automatic promotion. The normal evidence threshold still applies.

## What APEX records

Each OpenRouter generation may emit a structured telemetry event into the existing Postgres-backed `logs` table. The event contains operational metadata only:

- durable task ID, agent ID, and role;
- ordered requested model IDs;
- actual model ID reported by OpenRouter;
- provider/gateway identity;
- success/failure;
- observed latency;
- prompt/completion token counts;
- cached and reasoning token counts when reported;
- OpenRouter-reported generation cost when available;
- tool-call count and whether tools were available;
- a coarse pre-run complexity hint;
- provider error type for failed calls.

Model telemetry must **not** persist prompt text, completion text, tool-result content, secrets, or API keys.

Task identity is carried through concurrent asynchronous work using Node `AsyncLocalStorage`, so one multi-concurrency QA or research agent cannot attribute another task's generations to itself accidentally.

## Outcome join

APEX already records completed task outcomes in `task_outcomes`, including:

- success/failure;
- quality score;
- satisfaction metric;
- post-run complexity;
- duration;
- tool executions;
- LLM calls/iterations;
- error classification.

Model Intelligence joins generation telemetry to these outcomes by durable task ID.

A task outcome is credited once to the dominant serving model for that task (the model that handled the most successful LLM turns). This avoids turning a 12-iteration task into 12 successful task samples and avoids blindly crediting every transient fallback model with the same outcome.

## Observed score

The observed score is calculated only when a model has completed-task evidence. The selected/effective optimization objective determines the weights:

| Objective | Outcome quality | Generation reliability | Actual cost | Latency |
| --- | ---: | ---: | ---: | ---: |
| Quality | 58% | 17% | 8% | 17% |
| Balanced | 40% | 15% | 25% | 20% |
| Budget | 30% | 15% | 42% | 13% |
| Speed | 30% | 15% | 10% | 45% |

Outcome quality itself combines completed-task success and task satisfaction. Cost and latency are normalized against the other evidenced candidates in the same recommendation set.

The post-run task complexity score is used to weight evidence toward a requested target complexity. Distant-complexity outcomes still retain some influence as a general capability prior rather than disappearing completely.

This score is an APEX operational ranking, not an independent model benchmark.

## Static value score vs learned score

The catalog continues to show a **static value-efficiency heuristic** based on live OpenRouter price metadata, capabilities, and context length. That is useful before evidence exists.

The **Observed Model Intelligence** panel is distinct. It reports evidence from actual APEX work: task success, sample count, average actual generation cost, average latency, confidence, and the evidence-backed recommended order for a role.

Do not merge these two concepts or present the static heuristic as learned performance.

## Cold start and failure behavior

If telemetry is unavailable, the database is temporarily inaccessible, no task outcomes exist, or too few models meet the evidence threshold, adaptive routing preserves the operator-defined order. Learning is not allowed to become a new availability dependency for inference.

Telemetry writes are best-effort observability and must never convert a successful generation into a failed task.

## OpenRouter request behavior

APEX requests usage information on OpenRouter chat-completion requests so the response can include billed generation cost and token details when supported. APEX continues to record the actual `model` returned by OpenRouter rather than assuming the first requested model served the response.

Model Intelligence does not bypass:

- provider pacing/backpressure;
- credential/provider cooldowns;
- retry-after handling;
- token reservations and daily caps;
- malformed-tool-call rejection;
- non-completion detection;
- per-tool authorization/approval;
- production deployment/rollback approvals;
- source-to-production provenance checks.

## Deterministic guards

`scripts/verify-model-intelligence.ts` protects these invariants:

- sparse evidence cannot reorder the roster;
- only evidence-qualified slots can move;
- under-sampled models retain their operator-defined slots;
- explicit role pins remain first;
- adaptive ranking cannot introduce an unselected model;
- complexity escalation is opt-in and deterministic;
- hard tasks escalate to quality while routine explicit preferences are preserved;
- controlled trials stay bounded to low-complexity unpinned work;
- OpenRouter usage/cost telemetry remains wired;
- async task attribution remains concurrency-safe;
- model telemetry does not store response content;
- the dashboard keeps static heuristics and observed evidence visibly distinct.

The guard is part of the ordinary production CI gate.
