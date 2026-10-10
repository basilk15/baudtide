import { describe, expect, it } from 'vitest';
import { telemetryReplayTimeline } from './telemetryReplay';

describe('aligned capture replay', () => {
  it('finishes a short capture at its actual speed while a longer capture continues', () => {
    const timeline = telemetryReplayTimeline([
      { id: 'short', origin: 1_000, start: 1_000, end: 11_000 },
      { id: 'long', origin: 100_000, start: 100_000, end: 200_000 },
    ], 'elapsed', 0.5);
    expect(timeline.duration).toBe(100_000);
    expect(timeline.sourceEnds.get('short')).toBe(11_000);
    expect(timeline.sourceEnds.get('long')).toBe(150_000);
  });
  it('preserves the real delay between recordings in clock alignment', () => {
    const timeline = telemetryReplayTimeline([
      { id: 'early', origin: 1_000, start: 1_000, end: 11_000 },
      { id: 'late', origin: 31_000, start: 31_000, end: 41_000 },
    ], 'clock', 0.5);
    expect(timeline.duration).toBe(40_000);
    expect(timeline.sourceEnds.get('early')).toBe(11_000);
    expect(timeline.sourceEnds.get('late')).toBeLessThan(31_000);
  });
  it('keeps range offsets relative to each capture start', () => {
    const sources = [{ id: 'a', origin: 1_000, start: 6_000, end: 21_000 }, { id: 'b', origin: 50_000, start: 80_000, end: 100_000 }];
    const timeline = telemetryReplayTimeline(sources, 'elapsed', 0.5);
    expect(timeline.start).toBe(5_000);
    expect(timeline.duration).toBe(45_000);
    expect(timeline.sourceEnds.get('b')).toBe(77_500);
    expect(telemetryReplayTimeline(sources, 'elapsed', 1).sourceEnds.get('b')).toBe(100_000);
  });
});
