export type IntegrationProbeStatus =
  | 'connected'
  | 'configured'
  | 'rate_limited'
  | 'billing_required'
  | 'invalid_key'
  | 'degraded';

export interface IntegrationEnvVar {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  configured: boolean;
  probeable: boolean;
}

export interface IntegrationCatalogItem {
  id: string;
  name: string;
  description: string;
  category: string;
  docsUrl?: string;
  envVars: IntegrationEnvVar[];
}

export interface IntegrationSettingsResponse {
  integrations: Array<{ key: string; configured: boolean }>;
  catalog: IntegrationCatalogItem[];
}

export interface IntegrationProbeResult {
  key: string;
  status: IntegrationProbeStatus;
  detail: string;
  httpStatus?: number;
}

export interface WorkforceRecoveryResult {
  ok: boolean;
  recoveredTasks: number;
  resetAgentRows: number;
  skippedTasks: number;
  note: string;
}

async function settingsFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('apex_token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const settingsApi = {
  list: () => settingsFetch<IntegrationSettingsResponse>('/api/settings/integrations'),
  save: (key: string, value: string) =>
    settingsFetch<{ ok: boolean; key: string; configured: boolean }>('/api/settings/integrations', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    }),
  clear: (key: string) =>
    settingsFetch<{ ok: boolean; key: string; configured: boolean }>(
      `/api/settings/integrations/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    ),
  probe: (key: string) =>
    settingsFetch<IntegrationProbeResult>('/api/settings/integrations/probe', {
      method: 'POST',
      body: JSON.stringify({ key }),
    }),
  recoverWorkforce: () =>
    settingsFetch<WorkforceRecoveryResult>('/api/settings/recover-workforce', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
};
