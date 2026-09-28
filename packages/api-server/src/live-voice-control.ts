/**
 * Strict spoken hang-up intent for browser/admin Live Talk.
 *
 * Keep this narrower than a generic "stop" classifier: Don frequently says
 * "stop that task", "stop talking about X", etc. Only explicit call-ending
 * language should tear down the realtime transport.
 */
export function isExplicitLiveVoiceHangup(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/g, '').trim();
  if (!normalized) return false;

  if (/^(?:bye|goodbye|bye dude|that's all|thats all|that's it|thats it)$/.test(normalized)) {
    return true;
  }

  return /\b(?:hang\s*up(?:\s+(?:the\s+)?(?:call|phone))?|end\s+(?:the\s+|this\s+)?(?:call|live\s+(?:chat|talk)|voice\s+(?:call|chat))|stop\s+(?:the\s+|this\s+)?(?:call|live\s+(?:chat|talk)|voice\s+(?:call|chat))|close\s+(?:the\s+|this\s+)?(?:call|live\s+(?:chat|talk)|voice\s+(?:call|chat)))\b/.test(normalized);
}
