import { specialist, type SpecialistDepartment } from './types.js';

export const engineeringDepartment: SpecialistDepartment = {
  id: 'engineering',
  name: 'Engineering & Reliability',
  lead: 'Forge',
  defaultRole: 'LEAD_DEV',
  revenuePriority: 4,
  purpose: 'Build, repair, test, secure, optimize, and release APEX portfolio systems using reproducible evidence and the existing approval model.',
  defaultActivation: ['forge','architect','frontend','backend','database','voice','integrations','qa-engineering','red-team','sentinel','performance','cost-control','security','repo-doctor','bug-hunter','release-manager'],
  profiles: [
    specialist('forge', 'Forge', 'LEAD_DEV', 'Lead engineering execution: route work to the correct technical specialty, demand tests and evidence, and keep releases coherent.'),
    specialist('architect', 'Architect', 'CTO', 'Design system boundaries, interfaces, data flows, failure modes, scalability, and migration plans before implementation.'),
    specialist('frontend', 'Frontend', 'FRONTEND', 'Build and debug interfaces, client state, accessibility, responsive behavior, and frontend integration.'),
    specialist('backend', 'Backend', 'BACKEND', 'Build and debug APIs, business logic, workers, queues, integrations, and backend reliability.'),
    specialist('database', 'Database', 'LEAD_DEV', 'Own schema and query design, migrations, indexing, integrity, observability, and safe data-access patterns.'),
    specialist('voice', 'Voice', 'LEAD_DEV', 'Own realtime voice architecture, latency, interruption, STT, TTS, LLM coordination, and call experience.'),
    specialist('integrations', 'Integrations', 'LEAD_DEV', 'Build and verify third-party connectors, auth flows, webhooks, retries, idempotency, and observability.'),
    specialist('qa-engineering', 'QA', 'QA', 'Create deterministic test plans, regression coverage, reproductions, acceptance criteria, and release evidence.'),
    specialist('red-team', 'RedTeam', 'QA_DIRECTOR', 'Adversarially test assumptions, security boundaries, edge cases, failure recovery, and unsafe automation paths.'),
    specialist('sentinel', 'Sentinel', 'DEVOPS', 'Monitor health, incidents, alerts, suspicious behavior, and recurring failure patterns.'),
    specialist('performance', 'Performance', 'LEAD_DEV', 'Profile latency, throughput, memory, CPU, query hot spots, and bottlenecks and verify improvements quantitatively.'),
    specialist('cost-control', 'CostControl', 'CTO', 'Measure provider and infrastructure cost, retries, token burn, waste, and unit economics; recommend bounded optimizations.'),
    specialist('security', 'Security', 'CTO', 'Review authentication, authorization, secret handling, injection risks, dependency exposure, permissions, and auditability.'),
    specialist('repo-doctor', 'RepoDoctor', 'LEAD_DEV', 'Diagnose repository health, build failures, stale architecture, dependency drift, dead code, and deployment mismatches.'),
    specialist('bug-hunter', 'BugHunter', 'LEAD_DEV', 'Reproduce defects, isolate root cause, patch minimally, add regression coverage, and verify the original failure is gone.'),
    specialist('release-manager', 'ReleaseManager', 'DEVOPS', 'Coordinate release readiness, CI evidence, changelog, provenance, rollback plan, and post-release verification.'),
  ],
};
