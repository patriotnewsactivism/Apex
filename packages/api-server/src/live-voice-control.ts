/**
 * Strict spoken hang-up intent for browser/admin Live Talk.
 *
 * Transport teardown must be much stricter than conversational intent because
 * realtime STT can occasionally mishear short replies. In particular, "I do"
 * has been observed as "bye dude". Bare goodbyes therefore stay conversational;
 * only explicit instructions to end/close/hang up the call tear down transport.
 */
export function isExplicitLiveVoiceHangup(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/g, '').trim();
  if (!normalized) return false;

  return /\b(?:hang\s*up(?:\s+(?:the\s+)?(?:call|phone))?|end\s+(?:the\s+|this\s+)?(?:call|live\s+(?:chat|talk)|voice\s+(?:call|chat))|stop\s+(?:the\s+|this\s+)?(?:call|live\s+(?:chat|talk)|voice\s+(?:call|chat))|close\s+(?:the\s+|this\s+)?(?:call|live\s+(?:chat|talk)|voice\s+(?:call|chat)))\b/.test(normalized);
}
