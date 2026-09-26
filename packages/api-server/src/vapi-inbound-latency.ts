const ASSISTANT_NAME = 'APEX Inbound — BuildMyBot';

type JsonRecord = Record<string, any>;

function sameLowLatencyStack(assistant: JsonRecord): boolean {
  return (
    assistant?.model?.provider === 'openai' &&
    assistant?.model?.model === 'gpt-5.6-luna' &&
    assistant?.model?.serviceTier === 'fast' &&
    assistant?.voice?.provider === '11labs' &&
    assistant?.voice?.model === 'eleven_flash_v2_5' &&
    assistant?.voice?.optimizeStreamingLatency === 4 &&
    assistant?.transcriber?.provider === 'deepgram' &&
    assistant?.transcriber?.model === 'flux-general-en' &&
    assistant?.transcriber?.eotTimeoutMs === 2000 &&
    assistant?.startSpeakingPlan?.waitSeconds === 0.1
  );
}

/**
 * Reconcile the already-persisted Vapi inbound assistant after each deploy.
 *
 * The assistant lives in Vapi, not in Git. Updating configure_inbound_assistant
 * only affects the next explicit configure call, so the live 832-975-7665 line
 * could remain on the old high-latency stack forever after a code-only deploy.
 *
 * This read-modify-write preserves the current system prompt, tools, greeting,
 * voice ID and other assistant settings. Only latency-critical provider/timing
 * fields are changed.
 */
export async function reconcileVapiInboundLatency(): Promise<void> {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) {
    console.info('[Vapi inbound] VAPI_API_KEY not configured; latency reconcile skipped');
    return;
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const listRes = await fetch('https://api.vapi.ai/assistant?limit=100', { headers });
  if (!listRes.ok) {
    const body = await listRes.text().catch(() => '');
    throw new Error(`assistant list failed (${listRes.status}): ${body.slice(0, 300)}`);
  }

  const assistants = await listRes.json() as Array<{ id: string; name?: string }>;
  const match = assistants.find((assistant) => assistant.name === ASSISTANT_NAME);
  if (!match?.id) {
    console.info('[Vapi inbound] persistent assistant not found; latency reconcile skipped');
    return;
  }

  const currentRes = await fetch(`https://api.vapi.ai/assistant/${match.id}`, { headers });
  if (!currentRes.ok) {
    const body = await currentRes.text().catch(() => '');
    throw new Error(`assistant read failed (${currentRes.status}): ${body.slice(0, 300)}`);
  }

  const current = await currentRes.json() as JsonRecord;
  if (sameLowLatencyStack(current)) {
    console.info(`[Vapi inbound] ${ASSISTANT_NAME} already on low-latency stack`);
    return;
  }

  const currentModel = current.model && typeof current.model === 'object' ? current.model : {};
  const currentVoice = current.voice && typeof current.voice === 'object' ? current.voice : {};
  const currentTranscriber =
    current.transcriber && typeof current.transcriber === 'object' ? current.transcriber : {};

  const patch = {
    model: {
      ...currentModel,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      serviceTier: 'fast',
    },
    voice: {
      ...currentVoice,
      provider: '11labs',
      model: 'eleven_flash_v2_5',
      optimizeStreamingLatency: 4,
      stability: typeof currentVoice.stability === 'number' ? currentVoice.stability : 0.5,
      similarityBoost:
        typeof currentVoice.similarityBoost === 'number' ? currentVoice.similarityBoost : 0.75,
      speed: typeof currentVoice.speed === 'number' ? currentVoice.speed : 1.0,
    },
    transcriber: {
      ...currentTranscriber,
      provider: 'deepgram',
      model: 'flux-general-en',
      language: 'en',
      eotThreshold: 0.6,
      eagerEotThreshold: 0.45,
      eotTimeoutMs: 2000,
    },
    // Flux emits its own end-of-turn events. Do not add a separate smart
    // endpointing plan on top of it; Vapi's docs explicitly recommend letting
    // Flux own endpointing.
    startSpeakingPlan: {
      waitSeconds: 0.1,
    },
    stopSpeakingPlan: {
      numWords: 0,
      voiceSeconds: 0.15,
      backoffSeconds: 0.5,
    },
  };

  const patchRes = await fetch(`https://api.vapi.ai/assistant/${match.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch),
  });

  if (!patchRes.ok) {
    const body = await patchRes.text().catch(() => '');
    throw new Error(`assistant latency patch failed (${patchRes.status}): ${body.slice(0, 500)}`);
  }

  console.info(
    `[Vapi inbound] reconciled ${ASSISTANT_NAME} to Luna fast + Flux + Eleven Flash v2.5`,
  );
}
