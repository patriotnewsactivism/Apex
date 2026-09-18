// ─── Dashboard API client for Missions ──────────────────────────────────────────

import type { ApiClient } from './base.js';

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

declare module './base.js' {
  interface ApiClient {
    missions: {
      list(params?: { status?: string; projectId?: string; limit?: number; offset?: number }): Promise<{ missions: MissionSummary[]; total: number; limit: number; offset: number }>;
      get(missionId: string): Promise<MissionDetail>;
      create(data: {
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
      }): Promise<{
        missionId: string;
        status: string;
        title: string;
        objective: string;
        budgetCents: number;
        deadlineAt: string | undefined;
        message: string;
      }>;
      pause(missionId: string, reason?: string): Promise<{ missionId: string; status: string; pausedAt: string; reason: string | undefined; message: string }>;
      resume(missionId: string, reason?: string): Promise<{ missionId: string; status: string; resumedAt: string; reason: string | undefined; message: string }>;
      cancel(missionId: string, reason: string): Promise<{ missionId: string; status: string; cancelledAt: string; reason: string; message: string }>;
      submit(missionId: string, reason?: string): Promise<{ missionId: string; status: string; approvalId: string; message: string }>;
      budgetExhaust(missionId: string, spentCents: number): Promise<{ missionId: string; status: string; spentCents: number; budgetCents: number; exhaustedAt: string; message: string }>;
      budgetIncrease(missionId: string, newBudgetCents: number, approvedBy?: string): Promise<{ missionId: string; status: string; previousBudgetCents: number; newBudgetCents: number; resumedAt: string; approvedBy: string; message: string }>;
      update(missionId: string, data: { title?: string; deadlineAt?: string; budgetCents?: number; allowedChannels?: string[] }): Promise<{ missionId: string; message: string; updated: Record<string, unknown> }>;
      stats(): Promise<MissionStats>;
    };
  }
}

const missionApi = {
  list(params?: { status?: string; projectId?: string; limit?: number; offset?: number }) {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.projectId) qs.set('projectId', params.projectId);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    return fetch(`/api/missions?${qs}`).then(r => r.json()) as Promise<{ missions: MissionSummary[]; total: number; limit: number; offset: number }>;
  },

  get(missionId: string) {
    return fetch(`/api/missions/${missionId}`).then(r => r.json()) as Promise<MissionDetail>;
  },

  create(data: any) {
    return fetch('/api/missions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(r => r.json()) as Promise<any>;
  },

  pause(missionId: string, reason?: string) {
    return fetch(`/api/missions/${missionId}/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }).then(r => r.json()) as Promise<any>;
  },

  resume(missionId: string, reason?: string) {
    return fetch(`/api/missions/${missionId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }).then(r => r.json()) as Promise<any>;
  },

  cancel(missionId: string, reason: string) {
    return fetch(`/api/missions/${missionId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }).then(r => r.json()) as Promise<any>;
  },

  submit(missionId: string, reason?: string) {
    return fetch(`/api/missions/${missionId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }).then(r => r.json()) as Promise<any>;
  },

  budgetExhaust(missionId: string, spentCents: number) {
    return fetch(`/api/missions/${missionId}/budget-exhaust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spentCents }),
    }).then(r => r.json()) as Promise<any>;
  },

  budgetIncrease(missionId: string, newBudgetCents: number, approvedBy?: string) {
    return fetch(`/api/missions/${missionId}/budget-increase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newBudgetCents, approvedBy }),
    }).then(r => r.json()) as Promise<any>;
  },

  update(missionId: string, data: any) {
    return fetch(`/api/missions/${missionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(r => r.json()) as Promise<any>;
  },

  stats() {
    return fetch('/api/missions/stats').then(r => r.json()) as Promise<MissionStats>;
  },
};

export function registerMissionApi(api: ApiClient) {
  api.missions = missionApi;
}
