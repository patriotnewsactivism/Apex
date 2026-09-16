// ─── Telnyx ↔ Deepgram Agent — Vitest test suite ────────────────────────────
//
// Tests simulate the WebSocket lifecycle using lightweight mock sockets so
// no real network calls are made. The `executeServerTool` function is mocked
// to return deterministic results, isolating the session logic from external
// services (Stripe, Telnyx API, Deepgram).
//
// Run with: pnpm --filter @workspace/api-server test

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ─── Mock WebSocket ───────────────────────────────────────────────────────────
//
// We need a minimal ws-compatible fake that the real DeepgramVoiceSession code
// can interact with. The ws `WebSocket` class extends EventEmitter, so our mock
// does too. We capture sent messages for assertion.

class MockWebSocket extends EventEmitter {
  public readyState: number = 1; // OPEN
  public sent: Array<{ data: string | Buffer; isBinary: boolean }> = [];

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  send(data: string | Buffer): void {
    this.sent.push({ data, isBinary: Buffer.isBuffer(data) });
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', _code ?? 1000, Buffer.from(_reason ?? ''));
  }

  /** Helper: simulate receiving a text frame (JSON). */
  receiveText(json: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(json)), false);
  }

  /** Helper: simulate receiving a binary frame (raw audio). */
  receiveBinary(buf: Buffer): void {
    this.emit('message', buf, true);
  }

  /** Helper: simulate receiving a text frame that happens to be a Buffer object. */
  receiveTextAsBuffer(json: unknown): void {
    // This is the bug scenario: a text frame delivered as Buffer (isBinary=false)
    // must NOT be treated as audio.
    this.emit('message', Buffer.from(JSON.stringify(json)), false);
  }
}

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../telnyx-voice-guardrails.js', () => ({
  getToolDeclarationsForDeepgram: () => [
    {
      name: 'quote_discounted_plan',
      description: 'Quote plan prices',
      parameters: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
    },
    {
      name: 'send_checkout_link',
      description: 'Send checkout link',
      parameters: { type: 'object', properties: { plan: { type: 'string' }, email: { type: 'string' } }, required: ['plan', 'email'] },
    },
    {
      name: 'transfer_to_owner',
      description: 'Transfer call',
      parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    },
  ],
  executeServerTool: vi.fn().mockResolvedValue({ ok: true, message: 'done' }),
}));

vi.mock('ws', async (importOriginal) => {
  // Return our mock as the default export for `new WebSocket(url, opts)`.
  const actual = await importOriginal<typeof import('ws')>();
  return {
    ...actual,
    default: class FakeDeepgramWS extends MockWebSocket {
      constructor(_url: string, _opts?: unknown) {
        super();
        // Emit open asynchronously so test code can set up listeners first.
        process.nextTick(() => this.emit('open'));
      }
    },
  };
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a fresh Telnyx + Deepgram socket pair and a running session. */
async function buildSession(callControlId = 'call-123', caller = '+15555550100') {
  const { DeepgramVoiceSession } = await import('../telnyx-deepgram-agent.js');

  const telnyxWs = new MockWebSocket();
  const session = new DeepgramVoiceSession(
    telnyxWs as unknown as import('ws').WebSocket,
    callControlId,
    caller,
  );

  void session.start();

  // Let the mock Deepgram WS open.
  await tick();

  // Capture the mock Deepgram socket from the ws mock.
  // We can get it by inspecting what was sent after the open.
  // For test purposes we access the internal dgWs via a cast.
  const dgWs = (session as unknown as { dgWs: MockWebSocket }).dgWs as MockWebSocket;

  return { session, telnyxWs, dgWs };
}

/** Drive the Deepgram handshake (Welcome → SettingsApplied). */
async function handshake(dgWs: MockWebSocket, telnyxWs: MockWebSocket): Promise<void> {
  dgWs.receiveText({ type: 'Welcome' });
  await tick();

  // Verify Settings was sent.
  const settingsFrame = dgWs.sent.find(
    (f) => !f.isBinary && JSON.parse(f.data as string).type === 'Settings',
  );
  expect(settingsFrame).toBeDefined();

  // Send start event to Telnyx side (validates PCMU/8000).
  telnyxWs.receiveText({
    event: 'start',
    start: { media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } },
  });
  await tick();

  dgWs.receiveText({ type: 'SettingsApplied' });
  await tick();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DeepgramVoiceSession', () => {
  beforeEach(() => {
    process.env.DEEPGRAM_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. start / media / stop lifecycle ──────────────────────────────────────

  it('forwards PCMU audio to Deepgram after SettingsApplied', async () => {
    const { dgWs, telnyxWs } = await buildSession();
    await handshake(dgWs, telnyxWs);

    const audioPayload = Buffer.from([0x00, 0x01, 0x02, 0x03]).toString('base64');

    telnyxWs.receiveText({
      event: 'media',
      media: { track: 'inbound', payload: audioPayload },
    });
    await tick();

    const binaryFrames = dgWs.sent.filter((f) => f.isBinary);
    expect(binaryFrames.length).toBeGreaterThan(0);
    expect(binaryFrames[0].data).toEqual(Buffer.from(audioPayload, 'base64'));
  });

  it('cleans up on Telnyx stop event', async () => {
    const { dgWs, telnyxWs } = await buildSession();
    await handshake(dgWs, telnyxWs);

    telnyxWs.receiveText({ event: 'stop' });
    await tick();

    // After stop, Deepgram socket should be closed.
    expect(dgWs.readyState).toBe(MockWebSocket.CLOSED);
  });

  // ── 2. isBinary frame routing ──────────────────────────────────────────────

  it('does not treat a text frame delivered as Buffer as audio', async () => {
    const { dgWs, telnyxWs } = await buildSession();
    await handshake(dgWs, telnyxWs);

    const binaryCountBefore = dgWs.sent.filter((f) => f.isBinary).length;

    // Simulate a Deepgram JSON event (UserStartedSpeaking) arriving as Buffer
    // but isBinary=false. The bug was: (isBinary || Buffer.isBuffer(data))
    // which would have treated this as audio.
    dgWs.receiveTextAsBuffer({ type: 'UserStartedSpeaking' });
    await tick();

    const binaryCountAfter = dgWs.sent.filter((f) => f.isBinary).length;
    // No new binary audio frames should have been forwarded to Telnyx.
    expect(binaryCountAfter).toBe(binaryCountBefore);

    // But the barge-in clear should have been sent to Telnyx.
    const clearFrame = telnyxWs.sent.find(
      (f) => !f.isBinary && JSON.parse(f.data as string).event === 'clear',
    );
    expect(clearFrame).toBeDefined();
  });

  // ── 3. Deepgram barge-in (UserStartedSpeaking) ────────────────────────────

  it('sends {"event":"clear"} to Telnyx on UserStartedSpeaking', async () => {
    const { dgWs, telnyxWs } = await buildSession();
    await handshake(dgWs, telnyxWs);

    dgWs.receiveText({ type: 'UserStartedSpeaking' });
    await tick();

    const clearFrame = telnyxWs.sent.find(
      (f) => !f.isBinary && JSON.parse(f.data as string).event === 'clear',
    );
    expect(clearFrame).toBeDefined();
  });

  // ── 4. FunctionCallRequest → response ─────────────────────────────────────

  it('sends FunctionCallResponse with correct id/name/content', async () => {
    const { executeServerTool } = await import('../telnyx-voice-guardrails.js');
    vi.mocked(executeServerTool).mockResolvedValueOnce({
      ok: true,
      plans: [{ key: 'starter', priceMonthly: 29 }],
    });

    const { dgWs, telnyxWs } = await buildSession();
    await handshake(dgWs, telnyxWs);

    dgWs.receiveText({
      type: 'FunctionCallRequest',
      functions: [
        {
          id: 'fn-001',
          name: 'quote_discounted_plan',
          arguments: JSON.stringify({ plan: 'all' }),
          client_side: false,
        },
      ],
    });

    await tick(20);

    const response = dgWs.sent.find(
      (f) => !f.isBinary && JSON.parse(f.data as string).type === 'FunctionCallResponse',
    );

    expect(response).toBeDefined();
    const parsed = JSON.parse((response!.data as string));
    expect(parsed.id).toBe('fn-001');
    expect(parsed.name).toBe('quote_discounted_plan');
    expect(JSON.parse(parsed.content)).toMatchObject({ ok: true });
  });

  // ── 5. FunctionCallCancelled suppresses response ───────────────────────────

  it('suppresses FunctionCallResponse when function is cancelled', async () => {
    const { executeServerTool } = await import('../telnyx-voice-guardrails.js');

    // Slow tool that takes 50ms — cancellation arrives before it completes.
    vi.mocked(executeServerTool).mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 50)),
    );

    const { dgWs } = await buildSession();
    await handshake(dgWs, dgWs as unknown as MockWebSocket);

    dgWs.receiveText({
      type: 'FunctionCallRequest',
      functions: [{ id: 'fn-002', name: 'quote_discounted_plan', arguments: '{"plan":"all"}' }],
    });

    // Cancel immediately before the 50ms tool resolves.
    await tick(5);
    dgWs.receiveText({
      type: 'FunctionCallCancelled',
      functions: [{ id: 'fn-002', name: 'quote_discounted_plan' }],
    });

    await tick(60);

    const responses = dgWs.sent.filter(
      (f) => !f.isBinary && JSON.parse(f.data as string).type === 'FunctionCallResponse',
    );
    expect(responses).toHaveLength(0);
  });

  // ── 6. Deferred tool skipped on cancel ────────────────────────────────────

  it('does not call executeServerTool for client_side=true functions', async () => {
    const { executeServerTool } = await import('../telnyx-voice-guardrails.js');
    vi.mocked(executeServerTool).mockClear();

    const { dgWs, telnyxWs } = await buildSession();
    await handshake(dgWs, telnyxWs);

    dgWs.receiveText({
      type: 'FunctionCallRequest',
      functions: [
        {
          id: 'fn-003',
          name: 'send_checkout_link',
          arguments: '{"plan":"starter","email":"test@example.com"}',
          client_side: true,
        },
      ],
    });

    await tick(20);

    // client_side=true must skip server execution entirely.
    expect(executeServerTool).not.toHaveBeenCalled();
  });

  // ── 7. Audio buffering before SettingsApplied ─────────────────────────────

  it('buffers audio before SettingsApplied then flushes in order', async () => {
    const { dgWs, telnyxWs } = await buildSession();

    // Send Welcome but NOT SettingsApplied yet.
    dgWs.receiveText({ type: 'Welcome' });
    await tick();

    telnyxWs.receiveText({
      event: 'start',
      start: { media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } },
    });

    const frames = [
      Buffer.from([0x01]),
      Buffer.from([0x02]),
      Buffer.from([0x03]),
    ];

    for (const f of frames) {
      telnyxWs.receiveText({
        event: 'media',
        media: { track: 'inbound', payload: f.toString('base64') },
      });
    }

    await tick();

    // Deepgram should have received only the Settings message (no audio yet).
    const binaryBeforeFlush = dgWs.sent.filter((f) => f.isBinary);
    expect(binaryBeforeFlush).toHaveLength(0);

    // Now apply settings — triggers flush.
    dgWs.receiveText({ type: 'SettingsApplied' });
    await tick();

    const binaryAfterFlush = dgWs.sent.filter((f) => f.isBinary);
    expect(binaryAfterFlush).toHaveLength(3);

    // Order must be preserved.
    expect((binaryAfterFlush[0].data as Buffer)[0]).toBe(0x01);
    expect((binaryAfterFlush[1].data as Buffer)[0]).toBe(0x02);
    expect((binaryAfterFlush[2].data as Buffer)[0]).toBe(0x03);
  });

  // ── 8. Buffer eviction at MAX_PENDING_AUDIO_BYTES ─────────────────────────

  it('evicts oldest frames when buffer ceiling is exceeded', async () => {
    const { dgWs, telnyxWs } = await buildSession();

    dgWs.receiveText({ type: 'Welcome' });
    await tick();

    // Feed 65 KB of audio before SettingsApplied (ceiling is 64 KB).
    const chunkSize = 1000;
    const numChunks = 65; // 65 KB total

    for (let i = 0; i < numChunks; i++) {
      const chunk = Buffer.alloc(chunkSize, i % 256);
      telnyxWs.receiveText({
        event: 'media',
        media: { track: 'inbound', payload: chunk.toString('base64') },
      });
    }

    await tick();

    // Apply settings — buffer is flushed.
    dgWs.receiveText({ type: 'SettingsApplied' });
    await tick();

    const flushed = dgWs.sent.filter((f) => f.isBinary);

    // Should be fewer than 65 chunks (eviction dropped the oldest ones).
    expect(flushed.length).toBeLessThan(numChunks);
    // But at least some audio should have made it through.
    expect(flushed.length).toBeGreaterThan(0);
  });

  // ── 9. PCMU format validation ─────────────────────────────────────────────

  it('closes the session when Telnyx reports non-PCMU format', async () => {
    const { dgWs, telnyxWs } = await buildSession();

    dgWs.receiveText({ type: 'Welcome' });
    await tick();

    // Wrong encoding.
    telnyxWs.receiveText({
      event: 'start',
      start: { media_format: { encoding: 'OPUS', sample_rate: 48000, channels: 1 } },
    });
    await tick();

    // Both sockets should be closed after a bad format is detected.
    expect(telnyxWs.readyState).toBe(MockWebSocket.CLOSED);
  });
});
