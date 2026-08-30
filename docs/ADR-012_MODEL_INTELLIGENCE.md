# ADR-012 — Model Intelligence is evidence-driven, operator-bounded, and fail-safe

**Status:** Accepted  
**Date:** 2026-08-30

## Context

APEX routes production inference through OpenRouter and can expose hundreds of model choices. A static “best model” list is insufficient for an autonomous workforce because the best choice depends on role, task complexity, tool reliability, latency, cost, and actual task completion quality.

At the same time, allowing an adaptive router to experiment freely or learn from ambiguous provider aliases would create unacceptable risks: hidden spend, unstable behavior, bad attribution, and confident routing decisions based on incorrect evidence.

## Decision

APEX Model Intelligence is an **operator-bounded learning layer**, not an independent authority over the model catalog.

The operator-selected OpenRouter roster remains the admissible model set. Model Intelligence may rank or trial only candidates already present in that roster. A role-specific first-choice pin is a hard operator decision and remains stronger than learned routing.

### Routing modes

- **Manual:** exact operator order; evidence collection only.
- **Advisor:** exact operator order; recommendations are displayed but do not change runtime order.
- **Adaptive:** evidence-qualified selected candidates may reorder inside the selected roster.

Old policies default to Manual.

### Evidence qualification

A candidate may move automatically only after meeting the configured completed-task sample threshold. At least two candidates must be evidence-qualified before ranking can alter order. Sparse evidence therefore cannot create a production winner.

If the evidence database is unavailable or evidence is insufficient, runtime routing preserves the operator-defined order. Model Intelligence is not allowed to become an inference-availability dependency.

### Evidence source

Per-generation telemetry records operational metadata only and is joined to APEX’s existing durable task outcomes by task ID. Ranking may use completed-task success/satisfaction, task complexity, actual OpenRouter generation cost, latency, token usage, cache/reasoning token information, generation reliability, and tool-call behavior.

One task contributes at most one completed-task sample to the dominant attributable selected route candidate. Iterative LLM turns do not become duplicate task successes.

### Routing attribution

APEX keeps two identities separate:

- the concrete model OpenRouter reports as serving the response;
- the selected route candidate APEX is allowed to credit for learning.

Attribution is fail-closed:

1. exact concrete match to a requested selected candidate → attribute exactly;
2. exactly one requested selected alias/router/model → attribute to that sole selected route candidate;
3. multi-candidate alias/router fallback whose concrete response does not exactly identify a requested candidate → leave unattributed.

Ambiguous attribution is excluded from scoring rather than guessed. The intelligence report exposes attribution coverage and the number of successful calls excluded for ambiguity.

### Router audit metadata

APEX opts into OpenRouter router-audit metadata for observability, but stores only a bounded privacy-minimized subset: requested route, strategy, attempt number, selected provider, and capped provider/model/status attempt records.

Router summaries, pipeline payloads, prompts, completions, tool-result content, secrets, API keys, and arbitrary free-form router data are not copied into Model Intelligence telemetry.

Router metadata is audit evidence only. It is not a new runtime dependency and does not authorize undocumented alias inference.

### Controlled learning trials

Controlled trials are optional and default off. They are allowed only:

- in Adaptive mode;
- within the selected roster;
- for tasks with pre-run complexity <= 0.5;
- when the role has no hard model pin;
- at a deterministic per-task sample;
- at a configured rate hard-capped to 25%;
- targeting the least-sampled under-threshold selected candidate.

Trials exist to close evidence gaps, not to create unrestricted random experimentation.

### Smart complexity escalation

Complexity escalation is optional and defaults off.

When enabled:

- task complexity >= 0.70 uses the Quality objective;
- task complexity <= 0.35 shifts a neutral Balanced objective to Budget;
- middle-complexity tasks preserve the base objective;
- explicit routine Quality/Budget/Speed preferences remain unchanged;
- missing complexity preserves the base objective;
- role pins remain authoritative;
- normal evidence thresholds still apply.

The API/UI exposes both base and effective objectives when they differ.

## Consequences

- Model Intelligence may improve cost/quality routing over time without silently expanding the operator-approved model set.
- Under-sampled candidates cannot win production routing based on a few lucky calls.
- Ambiguous alias/fallback traffic lowers attribution coverage instead of contaminating rankings.
- A sole `~latest` alias or router product such as `openrouter/auto` can accumulate route-level evidence because it is the only selected route candidate in that request, while the concrete served model remains separately observable.
- Hard model pins always override adaptive ranking, complexity escalation, and learning trials.
- Learning failures degrade to the saved operator order rather than blocking inference.
- Telemetry remains an observability function; a telemetry write failure cannot turn a successful generation into a failed task.
- Existing provider pacing, retry-after handling, circuit breakers, token/spend controls, tool authorization, approvals, non-completion guards, and deployment provenance remain authoritative.

## Verification

The ordinary production CI gate must include deterministic tests proving at minimum:

- sparse evidence cannot reorder models;
- only selected candidates can appear in learned order;
- role pins stay first;
- exact/single-route attribution works and ambiguous multi-alias attribution stays unattributed;
- controlled learning trials remain bounded and low-complexity-only;
- complexity escalation is opt-in and deterministic;
- actual OpenRouter cost and concrete served model telemetry remain wired;
- router metadata is sanitized before persistence;
- task attribution remains concurrency-safe;
- prompt/completion content is not stored in Model Intelligence telemetry.

Implementation and operating details are maintained in `docs/MODEL_INTELLIGENCE.md`.
