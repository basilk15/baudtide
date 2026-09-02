import { describe, expect, it } from 'vitest';
import {
  evaluateTelemetryAlerts,
  type TelemetryAlertRule,
} from './telemetryAlerts';
import type { TelemetrySample } from './telemetry';

function sample(id: number, values: Record<string, number | { value: number; unit?: string }>): TelemetrySample {
  return {
    id: `sample-${id}`,
    timestamp: `2026-09-02T10:00:${String(id).padStart(2, '0')}.000Z`,
    nativeSessionId: 'native-session',
    sequence: id,
    format: 'pairs',
    schemaId: 'pairs:telemetry',
    values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === 'number' ? { value } : value])),
  };
}

function rule(overrides: Partial<TelemetryAlertRule> = {}): TelemetryAlertRule {
  return {
    id: 'temperature-high',
    sessionKey: 'bench-a',
    fieldKey: 'temperature',
    condition: 'above',
    threshold: 80,
    enabled: true,
    ...overrides,
  };
}

describe('evaluateTelemetryAlerts', () => {
  it('emits only a rising breach edge, then arms again after recovery', () => {
    const watch = rule();
    const first = evaluateTelemetryAlerts('bench-a', [sample(1, { temperature: 81 })], [watch]);
    expect(first.events).toEqual([expect.objectContaining({ ruleId: watch.id, sampleId: 'sample-1', value: 81, threshold: 80 })]);
    expect(first.activeStates.get(watch.id)).toBe(true);

    const sustained = evaluateTelemetryAlerts('bench-a', [sample(2, { temperature: 84 })], [watch], first.activeStates);
    expect(sustained.events).toEqual([]);
    expect(sustained.activeStates.get(watch.id)).toBe(true);

    const recovered = evaluateTelemetryAlerts('bench-a', [sample(3, { temperature: 79 })], [watch], sustained.activeStates);
    expect(recovered.events).toEqual([]);
    expect(recovered.activeStates.get(watch.id)).toBe(false);

    const breachedAgain = evaluateTelemetryAlerts('bench-a', [sample(4, { temperature: 82 })], [watch], recovered.activeStates);
    expect(breachedAgain.events).toHaveLength(1);
    expect(breachedAgain.events[0]).toEqual(expect.objectContaining({ sampleId: 'sample-4', value: 82 }));
  });

  it('uses an inclusive expected range and catches both out-of-range directions', () => {
    const watch = rule({ id: 'voltage-range', fieldKey: 'voltage', condition: 'outsideRange', threshold: undefined, min: 3.1, max: 3.4 });
    const evaluation = evaluateTelemetryAlerts('bench-a', [
      sample(1, { voltage: 3.1 }),
      sample(2, { voltage: 3.4 }),
      sample(3, { voltage: 3.05 }),
      sample(4, { voltage: 3.2 }),
      sample(5, { voltage: 3.45 }),
    ], [watch]);

    expect(evaluation.events.map((event) => [event.sampleId, event.value])).toEqual([
      ['sample-3', 3.05],
      ['sample-5', 3.45],
    ]);
  });

  it('does not change another session’s active state or match a different unit', () => {
    const watch = rule({ id: 'temperature-celsius', unit: 'C' });
    const previous = new Map([[watch.id, true]]);
    const wrongSession = evaluateTelemetryAlerts('bench-b', [sample(1, { temperature: { value: 30, unit: 'C' } })], [watch], previous);
    expect(wrongSession.events).toEqual([]);
    expect(wrongSession.activeStates.get(watch.id)).toBe(true);

    const wrongUnit = evaluateTelemetryAlerts('bench-a', [sample(2, { temperature: { value: 90, unit: 'F' } })], [watch]);
    expect(wrongUnit.events).toEqual([]);
    expect(wrongUnit.activeStates.get(watch.id)).toBe(false);
  });

  it('ignores disabled and malformed rules without turning them into alerts', () => {
    const disabled = rule({ id: 'disabled', enabled: false });
    const malformedRange = rule({ id: 'bad-range', condition: 'outsideRange', threshold: undefined, min: 10, max: 5 });
    const evaluation = evaluateTelemetryAlerts('bench-a', [sample(1, { temperature: 100 })], [disabled, malformedRange]);

    expect(evaluation.events).toEqual([]);
    expect(evaluation.activeStates.get(disabled.id)).toBe(false);
    expect(evaluation.activeStates.get(malformedRange.id)).toBe(false);
  });
});
