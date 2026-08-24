import { describe, expect, it } from 'vitest';
import { TelemetrySessionStore } from './telemetry';
import { TELEMETRY_FORMAT_FIXTURES } from './telemetryFixtures';
import { prepareTelemetryCharts } from './telemetryChart';

const encoder = new TextEncoder();

function serialEvent(sessionId: string, sequence: number, line: string) {
  return {
    sessionId,
    port: '/dev/telemetry-fixture',
    sequence,
    timestamp: '2026-08-24T10:00:' + String(sequence).padStart(2, '0') + '.000Z',
    text: line + '\n',
    bytes: [...encoder.encode(line + '\n')],
  };
}

describe('telemetry format fixtures', () => {
  for (const fixture of TELEMETRY_FORMAT_FIXTURES) {
    it('parses and prepares chart data for ' + fixture.label, () => {
      const store = new TelemetrySessionStore();
      let sequence = 1;
      for (const line of fixture.lines) {
        store.ingestOrderedSerialEvent(fixture.id, serialEvent(fixture.id, sequence, line));
        sequence += 1;
      }

      const snapshot = store.getSnapshot(fixture.id);
      expect(snapshot.detectedSchemas.some((schema) => schema.format === fixture.format)).toBe(true);
      expect(snapshot.acceptedSampleCount).toBe(fixture.signals[0].values.length);
      expect(snapshot.fields.map((field) => field.key)).toEqual(fixture.signals.map((signal) => signal.key));

      const prepared = prepareTelemetryCharts({
        samples: snapshot.samples,
        fields: snapshot.fields,
        gaps: snapshot.gaps,
        selectedFieldKeys: fixture.signals.map((signal) => signal.key),
        windowMs: 0,
        maxPointsPerSeries: 100,
      });
      const series = prepared.groups.flatMap((group) => group.series);

      expect(prepared.totalPointCount).toBe(fixture.signals.reduce((count, signal) => count + signal.values.length, 0));
      for (const signal of fixture.signals) {
        const chartSeries = series.find((candidate) => candidate.key === signal.key);
        expect(chartSeries).toBeDefined();
        expect(chartSeries?.unit).toBe(signal.unit);
        expect(chartSeries?.points.map((point) => point.value)).toEqual(signal.values);
      }
    });
  }
});
