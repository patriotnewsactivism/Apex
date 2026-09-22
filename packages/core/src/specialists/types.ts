export const STANDING_AGENT_ROLES = [
  'CEO','CTO','COO','LEAD_DEV','FRONTEND','BACKEND','DEVOPS','QA',
  'RESEARCH','DOCS','OPS','QA_DIRECTOR','LEAD_RESEARCH','SALES','MARKETING','CUSTOMER_SUCCESS',
] as const;

export type StandingAgentRole = typeof STANDING_AGENT_ROLES[number];

export interface SpecialistProfile {
  id: string;
  name: string;
  parentRole: StandingAgentRole;
  mission: string;
  operatingRules?: string[];
}

export interface SpecialistDepartment {
  id: string;
  name: string;
  lead: string;
  defaultRole: StandingAgentRole;
  revenuePriority: number;
  purpose: string;
  defaultActivation: string[];
  profiles: SpecialistProfile[];
}

export const specialist = (
  id: string,
  name: string,
  parentRole: StandingAgentRole,
  mission: string,
  operatingRules: string[] = [],
): SpecialistProfile => ({ id, name, parentRole, mission, operatingRules });
