import { describe, expect, it } from 'vitest';
import type { TelemetryField, TelemetryGap, TelemetrySample } from './telemetry';
import {
  decimateTelemetryPoints,
  filterTelemetryWindow,
  groupTelemetryFieldsByUnit,
  prepareTelemetryCharts,
  telemetryYDomain,
  type TelemetryChartPoint,
} from './telemetryChart';

function sample(id: string, timestamp: string, values: Record<string, number>): TelemetrySample {
  return {
    id,
    timestamp,
    nativeSessionId: 'native-a',
    sequence: Number(id.replace(/\D/g, '')) || 1,
    format: 'pairs',
    schemaId: 'pairs:test=',
    values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])),
  };
}

const fields: readonly TelemetryField[] = [
  { key: 'temperature', unit: '°C', formats: ['pairs'] },
  { key: 'humidity', unit: '%', formats: ['pairs'] },
  { key: 'ambient', unit: '°C', formats: ['pairs'] },
];

describe('telemetry chart preparation', () => {
  it('filters its window from the newest valid timestamp and ignores invalid timestamps', () => {
    const rows = [
      sample('old', '2026-08-10T10:00:00.000Z', { temperature: 20 }),
      sample('invalid', 'not-a-timestamp', { temperature: 99 }),
      sample('middle', '2026-08-10T10:00:08.000Z', { temperature: 21 }),
      sample('new', '2026-08-10T10:00:10.000Z', { temperature: 22 }),
    ];

    const filtered = filterTelemetryWindow(rows, 3_000);
    expect(filtered.samples.map(({ sample: row }) => row.id)).toEqual(['middle', 'new']);
    expect(filtered.startMs).toBe(Date.parse('2026-08-10T10:00:07.000Z'));

    const prepared = prepareTelemetryCharts({
      samples: rows,
      fields,
      gaps: [],
      selectedFieldKeys: ['temperature'],
      windowMs: 3_000,
    });
    expect(prepared.groups[0].series[0].points.map((point) => point.value)).toEqual([21, 22]);
  });

  it('groups selected fields by unit without mixing their Y scales', () => {
    const groups = groupTelemetryFieldsByUnit(fields, ['humidity', 'ambient', 'temperature']);
    expect(groups.map((group) => [group.label, group.fields.map((field) => field.key)])).toEqual([
      ['°C', ['temperature', 'ambient']],
      ['%', ['humidity']],
    ]);
  });

  it('retains extrema and endpoints when decimating a large series', () => {
    const points: TelemetryChartPoint[] = Array.from({ length: 100 }, (_, index) => ({
      sampleId: `s${index}`,
      timestampMs: index,
      value: index === 37 ? 1_000 : index === 68 ? -1_000 : index,
    }));
    const decimated = decimateTelemetryPoints(points, 12);

    expect(decimated.length).toBeLessThanOrEqual(12);
    expect(decimated[0]).toEqual(points[0]);
    expect(decimated[decimated.length - 1]).toEqual(points[points.length - 1]);
    expect(decimated).toContainEqual(points[37]);
    expect(decimated).toContainEqual(points[68]);
    expect(decimateTelemetryPoints(points, 12)).toEqual(decimated);
  });

  it('builds a usable padded domain for flat and varied values', () => {
    expect(telemetryYDomain([
      { sampleId: 'one', timestampMs: 1, value: 24 },
      { sampleId: 'two', timestampMs: 2, value: 24 },
    ])).toEqual({ min: 22.8, max: 25.2 });
    expect(telemetryYDomain([
      { sampleId: 'one', timestampMs: 1, value: -5 },
      { sampleId: 'two', timestampMs: 2, value: 5 },
    ])).toEqual({ min: -5.8, max: 5.8 });
  });

  it('includes only reconnect gaps inside the chart window', () => {
    const gaps: readonly TelemetryGap[] = [
      { id: 'old', type: 'reconnect', timestamp: '2026-08-10T10:00:00.000Z', previousNativeSessionId: 'a', nextNativeSessionId: 'b', nextSequence: 1 },
      { id: 'inside', type: 'reconnect', timestamp: '2026-08-10T10:00:09.000Z', previousNativeSessionId: 'b', nextNativeSessionId: 'c', nextSequence: 1 },
      { id: 'bad', type: 'reconnect', timestamp: 'not-a-date', previousNativeSessionId: 'c', nextNativeSessionId: 'd', nextSequence: 1 },
    ];
    const prepared = prepareTelemetryCharts({
      samples: [sample('end', '2026-08-10T10:00:10.000Z', { temperature: 24 })],
      fields,
      gaps,
      selectedFieldKeys: ['temperature'],
      windowMs: 2_000,
    });

    expect(prepared.gaps).toEqual([{ id: 'inside', type: 'reconnect', timestampMs: Date.parse('2026-08-10T10:00:09.000Z') }]);
  });
});
