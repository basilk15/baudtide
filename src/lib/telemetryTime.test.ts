import { describe, expect, it } from 'vitest';
import { formatTelemetryElapsedTime } from './telemetryTime';

describe('elapsed telemetry time', () => {
  const origin = Date.UTC(2000, 0, 1);
  it('keeps long aligned captures elapsed instead of becoming clock labels', () => {
    expect(formatTelemetryElapsedTime(origin, origin)).toBe('+0s');
    expect(formatTelemetryElapsedTime(origin + 130_000, origin)).toBe('+2m 10s');
    expect(formatTelemetryElapsedTime(origin + 3_723_000, origin)).toBe('+1h 02m 03s');
  });
  it('preserves millisecond precision for inspecting bursts', () => {
    expect(formatTelemetryElapsedTime(origin + 60_027, origin, true)).toBe('+1m 00.027s');
    expect(formatTelemetryElapsedTime(origin - 1, origin, true)).toBe('+0.000s');
  });
});
