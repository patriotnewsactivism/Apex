// Dashboard types for revenue-ops missions.
// Missions are APEX goals with missionType='revenue_ops' in goal.result (D1).

export interface MissionSummary {
  missionId: string;
  title: string;
  description: string;
  goalStatus: string;
  missionStatus: string;
  effectiveStatus: string;
  objective: string;
  budgetCents: number;
  spentCents: number;
  remainingCents: number;
  allowedChannels: string[];
  deadlineAt: string | undefined;
  projectId: string | undefined;
  assignedAgentId: string | undefined;
  createdAt: string;
  updatedAt: string;
  completedAt: string | undefined;
}

export interface MissionDetail {
  missionId: string;
  title: string;
  description: string;
  goalStatus: string;
  missionStatus: string;
  effectiveStatus: string;
  objective: string;
  targetDefinition: Record<string, unknown>;
  qualificationRules: Record<string, unknown>;
  allowedChannels: string[];
  policy: Record<string, unknown>;
  budgetCents: number;
  spentCents: number;
  remainingCents: number;
  deadlineAt: string | undefined;
  startedAt: string | undefined;
  channels: string[];
  approveBeforePivot: boolean;
  firstTouchOptIn: string;
  projectId: string | undefined;
  assignedAgentId: string | undefined;
  createdAt: string;
  updatedAt: string;
  completedAt: string | undefined;
  activeTasks: Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    priority: number;
    assignedAgentId: string | undefined;
    context: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
  }>;
  completedTasks: number;
  totalTasks: number;
  pendingApprovals: Array<{
    id: string;
    reason: string;
    status: string;
    toolName: string;
    createdAt: string;
  }>;
}

export interface MissionStats {
  total: number;
  byStatus: Record<string, number>;
  totalBudgetCents: number;
  totalSpentCents: number;
  activeMissions: number;
}

export interface MissionListResponse {
  missions: MissionSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateMissionRequest {
  objective: string;
  targetDefinition: Record<string, unknown>;
  qualificationRules: Record<string, unknown>;
  allowedChannels: string[];
  policy: {
    budgetCents: number;
    approveBeforePivot: boolean;
    firstTouchOptIn: 'manual' | 'auto_with_warn';
    requireApprovalForNewCampaigns?: boolean;
    requireApprovalForOfferChange?: boolean;
  };
  deadlineAt?: string;
  title?: string;
  projectId?: string;
  assignedAgentId?: string;
}

export interface CreateMissionResponse {
  missionId: string;
  status: string;
  title: string;
  objective: string;
  budgetCents: number;
  deadlineAt: string | undefined;
  message: string;
}

export interface MissionActionResponse {
  missionId: string;
  status: string;
  message: string;
  pausedAt?: string;
  resumedAt?: string;
  cancelledAt?: string;
  reason?: string;
  approvalId?: string;
  spentCents?: number;
  budgetCents?: number;
  exhaustedAt?: string;
  previousBudgetCents?: number;
  newBudgetCents?: number;
  approvedBy?: string;
}

export interface UpdateMissionResponse {
  missionId: string;
  message: string;
  updated: Record<string, unknown>;
}
