import { describe, expect, it } from 'vitest';
import { TelemetryProjectionCache } from './telemetryProjection';
import { TelemetrySessionStore, type TelemetrySample } from './telemetry';

const epochMs = Date.UTC(2000, 0, 1);
const reading = (id: string, time: number, temperature: number): TelemetrySample => ({
  id, timestamp: new Date(time).toISOString(), nativeSessionId: 'native', sequence: 1,
  format: 'json', schemaId: 'json', values: { temperature: { value: temperature, unit: 'C' }, voltage: { value: 3.3 } },
});
const settings = { sourceId: 'source', fieldKeys: new Map([['temperature', 'Device · temperature'], ['voltage', 'Device · voltage']]), alignment: 'elapsed' as const, startMs: 1000, epochMs };

describe('cached full-fidelity plot projection', () => {
  it('reuses unchanged readings across real store updates without changing old plots', () => {
    const store = new TelemetrySessionStore();
    const ingest = (sequence: number, temperature: number) => {
      const text = `${JSON.stringify({ temperature, voltage: 3.3 })}\n`;
      store.ingestOrderedSerialEvent('source', { sessionId: 'native', port: '/fixture', sequence,
        timestamp: new Date(1000 + sequence).toISOString(), text, bytes: [...new TextEncoder().encode(text)] });
    };
    ingest(1, 20); ingest(2, 21);
    const cache = new TelemetryProjectionCache();
    const first = cache.project(store.getSnapshot('source').samples, settings);
    ingest(3, 99);
    const second = cache.project(store.getSnapshot('source').samples, settings);
    expect(second).toHaveLength(3);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(first.map((sample) => sample.values['Device · temperature'].value)).toEqual([20, 21]);
    expect(second.map((sample) => sample.values['Device · temperature'].value)).toEqual([20, 21, 99]);
  });

  it('updates elapsed origins, labels, source identities, and clock alignment without stale cached values', () => {
    const sample = reading('one', 1250, 99);
    const cache = new TelemetryProjectionCache();
    const first = cache.project([sample], settings)[0];
    expect(first.timestamp).toBe(new Date(epochMs + 250).toISOString());
    const shifted = cache.project([sample], { ...settings, startMs: 1200 })[0];
    expect(shifted.timestamp).toBe(new Date(epochMs + 50).toISOString());
    expect(shifted.values).toBe(first.values);
    expect(first.timestamp).toBe(new Date(epochMs + 250).toISOString());
    const renamed = cache.project([sample], { ...settings, sourceId: 'renamed', fieldKeys: new Map([['temperature', 'Renamed · temperature']]) })[0];
    expect(renamed.id).toBe('renamed:one');
    expect(renamed.values).toEqual({ 'Renamed · temperature': { value: 99, unit: 'C' } });
    const clock = cache.project([sample], { ...settings, alignment: 'clock' })[0];
    expect(clock.timestamp).toBe(sample.timestamp);
    expect(clock.values).toEqual(first.values);
  });

  it('preserves receive-burst order, spikes, units, and replay cutoffs without downsampling', () => {
    const samples = [reading('one', 1000, 20), reading('spike', 1000, 999), reading('three', 1000, 21), reading('later', 1100, 22)];
    const cache = new TelemetryProjectionCache();
    const projected = cache.project(samples, { ...settings, endMs: 1000 });
    expect(projected.map((sample) => sample.id)).toEqual(['source:one', 'source:spike', 'source:three']);
    expect(projected.map((sample) => sample.values['Device · temperature'])).toEqual([{ value: 20, unit: 'C' }, { value: 999, unit: 'C' }, { value: 21, unit: 'C' }]);
    expect(cache.project(samples, settings)).toHaveLength(4);
    expect(cache.project(samples, { ...settings, endMs: 999 })).toEqual([]);
    expect(samples[0].values.temperature.value).toBe(20);
  });

  it('retains readings before an elapsed origin at zero without changing their clock time', () => {
    const sample = reading('adjusted-clock', 900, 20);
    const cache = new TelemetryProjectionCache();
    expect(cache.project([sample], settings)[0].timestamp).toBe(new Date(epochMs).toISOString());
    expect(cache.project([sample], { ...settings, alignment: 'clock' })[0].timestamp).toBe(sample.timestamp);
  });
});
