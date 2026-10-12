// ─── Apex Operator Registry ───────────────────────────────────────────────────
//
// Small in-process registry shared between the HTTP bootstrap and the voice
// tool executor. The CEO agent instance (workforce.get('apex-ceo-001')) is
// registered here at boot so the Deepgram voice tools can submit goals without
// re-running the bootstrap. Unlocked voice sessions are keyed by call_control_id.

import type { ApexCEO } from '@workspace/agents';

let ceoRef: ApexCEO | null = null;
const unlockedSessions = new Set<string>();

export function setOperatorCeo(ceo: ApexCEO): void {
  ceoRef = ceo;
}

export function getOperatorCeo(): ApexCEO | null {
  return ceoRef;
}

export function unlockSession(callControlId: string): void {
  unlockedSessions.add(callControlId);
}

export function isSessionUnlocked(callControlId: string): boolean {
  return unlockedSessions.has(callControlId);
}

export function removeSession(callControlId: string): void {
  unlockedSessions.delete(callControlId);
}
