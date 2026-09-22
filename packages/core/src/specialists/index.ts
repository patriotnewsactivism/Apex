import { executiveDepartment } from './executive.js';
import { revenueDepartment } from './revenue.js';
import { marketingDepartment } from './marketing.js';
import { buildMyBotDepartment } from './buildmybot.js';
import { newsroomDepartment } from './newsroom.js';
import { videoDepartment } from './video.js';
import { publishingDepartment } from './publishing.js';
import { legalDepartment } from './legal.js';
import { engineeringDepartment } from './engineering.js';
import { operationsDepartment } from './operations.js';
import { apexControlDepartment } from './apex-control.js';
import type { SpecialistDepartment, SpecialistProfile } from './types.js';

export * from './types.js';

export const SPECIALIST_DEPARTMENTS: SpecialistDepartment[] = [
  executiveDepartment,
  revenueDepartment,
  marketingDepartment,
  buildMyBotDepartment,
  newsroomDepartment,
  videoDepartment,
  publishingDepartment,
  legalDepartment,
  engineeringDepartment,
  operationsDepartment,
  apexControlDepartment,
];

const departmentById = new Map<string, SpecialistDepartment>();
const specialistById = new Map<string, SpecialistProfile>();
const specialistDepartmentById = new Map<string, SpecialistDepartment>();

for (const department of SPECIALIST_DEPARTMENTS) {
  if (departmentById.has(department.id)) {
    throw new Error('Duplicate specialist department id: ' + department.id);
  }
  departmentById.set(department.id, department);

  for (const profile of department.profiles) {
    if (specialistById.has(profile.id)) {
      throw new Error('Duplicate specialist id: ' + profile.id);
    }
    specialistById.set(profile.id, profile);
    specialistDepartmentById.set(profile.id, department);
  }
}

for (const department of SPECIALIST_DEPARTMENTS) {
  for (const specialistId of department.defaultActivation) {
    const profile = specialistById.get(specialistId);
    if (!profile) {
      throw new Error('Department ' + department.id + ' default activation references unknown specialist ' + specialistId);
    }
    const owner = specialistDepartmentById.get(specialistId);
    if (owner?.id !== department.id) {
      throw new Error('Department ' + department.id + ' default activation includes specialist ' + specialistId + ' from ' + (owner?.id ?? 'unknown'));
    }
  }
}

export function getSpecialistDepartment(id: string): SpecialistDepartment | undefined {
  return departmentById.get(id);
}

export function getSpecialistProfile(id: string): SpecialistProfile | undefined {
  return specialistById.get(id);
}

export function getDepartmentForSpecialist(id: string): SpecialistDepartment | undefined {
  return specialistDepartmentById.get(id);
}

export function listSpecialistDepartments(): SpecialistDepartment[] {
  return [...SPECIALIST_DEPARTMENTS].sort(
    (a, b) => a.revenuePriority - b.revenuePriority || a.name.localeCompare(b.name),
  );
}

export function listSpecialists(departmentId?: string): SpecialistProfile[] {
  const rows = departmentId
    ? (departmentById.get(departmentId)?.profiles ?? [])
    : [...specialistById.values()];
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

export function defaultDepartmentActivation(departmentId: string): SpecialistProfile[] {
  const department = getSpecialistDepartment(departmentId);
  if (!department) return [];
  return department.defaultActivation
    .map((id) => specialistById.get(id))
    .filter((profile): profile is SpecialistProfile => Boolean(profile));
}

const DEPARTMENT_RULES: Record<string, string[]> = {
  revenue: [
    'Optimize for qualified pipeline, next-step conversion, retained customers, and measured revenue rather than raw activity.',
    'Never fabricate a prospect, contact, reply, meeting, opportunity, customer, sale, or revenue result.',
    'External sends, calls, public publishing, and commercial commitments remain governed by the parent tools and approval policy.',
  ],
  marketing: [
    'Claims must match verified product capability and evidence.',
    'Measure conversion events and attribution; do not treat impressions alone as success.',
  ],
  buildmybot: [
    'Do not promise a feature or live behavior until verified against current BuildMyBot source or runtime evidence.',
    'Treat signup, activation, working calls or messages, and retained customers as critical product outcomes.',
  ],
  newsroom: [
    'Separate established facts, allegations, analysis, and opinion.',
    'Preserve source URLs or document references for material factual claims.',
  ],
  video: [
    'Every external clip or asset must retain the original source URL and a provenance record.',
    'Do not edit source material in a way that materially misrepresents context.',
  ],
  publishing: [
    'Preserve factual accuracy, chronology, citations or annotations, and authorial intent.',
  ],
  legal: [
    'Prefer primary authority and exact source references; distinguish binding from persuasive authority.',
    'Do not invent cases, quotations, holdings, filing facts, deadlines, or procedural posture.',
  ],
  engineering: [
    'Reproduce or establish evidence before changing code; verify the real outcome after the change.',
    'Do not treat a build or plan as proof that production behavior changed.',
  ],
  operations: [
    'Label estimates, assumptions, and inferred metrics; never present them as measured facts.',
  ],
  'apex-control': [
    'Preserve operator authority, auditability, approval boundaries, and deployment provenance.',
  ],
};

export function buildSpecialistSystemPrompt(
  context: Record<string, unknown> | null | undefined,
  executingRole?: string,
): string {
  const specialistId = typeof context?.specialistId === 'string' ? context.specialistId : '';
  if (!specialistId) return '';

  const profile = getSpecialistProfile(specialistId);
  if (!profile) {
    return '\n\n## Specialist Profile Warning\nThe task requested unknown specialistId "' +
      specialistId +
      '". Do not pretend that profile exists. Execute only within the standing role and available tools, and report the invalid specialist id.\n';
  }

  const department = getDepartmentForSpecialist(profile.id);
  const rules = [
    'This specialist profile changes task focus, not authority. It grants no additional tools, credentials, permissions, or approval bypass.',
    'Do the work with available tools; do not merely describe what the specialist would do.',
    'Use evidence and label unknowns. Never manufacture completion, metrics, sources, or external side effects.',
    ...(DEPARTMENT_RULES[department?.id ?? ''] ?? []),
    ...(profile.operatingRules ?? []),
  ];

  return '\n\n## Active Specialist Profile\n' +
    'Name: ' + profile.name + '\n' +
    'Specialist ID: ' + profile.id + '\n' +
    'Department: ' + (department?.name ?? 'unknown') + '\n' +
    'Department purpose: ' + (department?.purpose ?? '') + '\n' +
    'Routed parent role: ' + profile.parentRole + '\n' +
    'Executing standing role: ' + (executingRole ?? 'unknown') + '\n' +
    'Mission: ' + profile.mission + '\n\n' +
    '### Specialist operating rules\n' +
    rules.map((rule, index) => String(index + 1) + '. ' + rule).join('\n') +
    '\n';
}
