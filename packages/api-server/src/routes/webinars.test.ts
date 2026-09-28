import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WEBINAR_SEGMENTS, buildWebinarProducerCue } from './webinars.js';

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    slug: 'demo',
    title: 'Demo',
    description: null,
    host_name: 'Don',
    mode: 'autonomous',
    status: 'live',
    autonomous: true,
    current_segment: 0,
    segment_started_at: new Date('2026-09-28T15:00:00.000Z'),
    started_at: new Date('2026-09-28T15:00:00.000Z'),
    ended_at: null,
    cta_label: 'Explore BuildMyBot.app',
    cta_url: 'https://buildmybot.app',
    created_at: new Date('2026-09-28T14:50:00.000Z'),
    updated_at: new Date('2026-09-28T15:00:00.000Z'),
    ...overrides,
  } as Parameters<typeof buildWebinarProducerCue>[0];
}

describe('buildWebinarProducerCue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T15:00:30.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports on-track timing and high-intent attendees', () => {
    const cue = buildWebinarProducerCue(
      session(),
      [
        { name: 'Cold Lead', engagement_score: 5 },
        { name: 'Hot Lead', engagement_score: 40 },
      ],
      [],
    );

    expect(cue.timing).toBe('on_track');
    expect(cue.elapsedSeconds).toBe(30);
    expect(cue.secondsRemaining).toBe(DEFAULT_WEBINAR_SEGMENTS[0]!.durationSeconds - 30);
    expect(cue.highIntentCount).toBe(1);
    expect(cue.topLeadNames).toEqual(['Hot Lead']);
  });

  it('tells the operator to move on once a segment is over target', () => {
    vi.setSystemTime(new Date('2026-09-28T15:03:00.000Z'));
    const cue = buildWebinarProducerCue(session(), [], []);
    expect(cue.timing).toBe('move_on');
    expect(cue.secondsRemaining).toBe(0);
    expect(cue.recommendation).toContain('Advance now');
  });

  it('recognizes human takeover and ended sessions', () => {
    expect(buildWebinarProducerCue(session({ status: 'paused' }), [], []).timing).toBe('human_floor');
    expect(buildWebinarProducerCue(session({ status: 'ended' }), [], []).timing).toBe('complete');
  });
});
