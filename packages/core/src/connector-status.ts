/**
 * connector-status.ts — reads an installed project's `.apex/connectors.json`
 * (written by apex-install --connectors=...) and cross-checks actual
 * process.env to report REAL configured/missing status per connector.
 *
 * This never fakes "connected" — a connector is only reported `configured:
 * true` if every one of its requiredEnvVars is actually present and non-empty
 * in the environment this code is running in.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ConnectorDef {
  enabled: boolean;
  description: string;
  requiredEnvVars: string[];
}

export interface ConnectorStatus {
  id: string;
  enabled: boolean;
  description: string;
  requiredEnvVars: string[];
  missingEnvVars: string[];
  configured: boolean;
}

export function readConnectorsConfig(targetDir: string): Record<string, ConnectorDef> | null {
  const p = path.join(targetDir, '.apex', 'connectors.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, ConnectorDef>;
}

/**
 * Returns status for every connector DECLARED in .apex/connectors.json
 * (whether enabled or not). Use `.filter(c => c.enabled)` if you only want
 * the ones this project opted into.
 */
export function getConnectorStatus(targetDir: string, env: NodeJS.ProcessEnv = process.env): ConnectorStatus[] {
  const config = readConnectorsConfig(targetDir);
  if (!config) {
    throw new Error(`No .apex/connectors.json found in ${targetDir} — run apex-install on this dir first.`);
  }

  return Object.entries(config).map(([id, def]) => {
    const missingEnvVars = def.requiredEnvVars.filter((v) => !env[v] || env[v] === '');
    return {
      id,
      enabled: def.enabled,
      description: def.description,
      requiredEnvVars: def.requiredEnvVars,
      missingEnvVars,
      configured: def.enabled && missingEnvVars.length === 0,
    };
  });
}

/** Convenience: just the connectors this project enabled AND that are fully configured. */
export function getReadyConnectors(targetDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return getConnectorStatus(targetDir, env)
    .filter((c) => c.configured)
    .map((c) => c.id);
}
