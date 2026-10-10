import { describe, it, expect } from 'vitest';
import { TelemetrySessionStore } from './telemetry';
import { TelemetryWatchEngine } from './telemetryWatchEngine';
import type { TelemetryAlertEvent, TelemetryAlertRule } from './telemetryAlerts';

const rule: TelemetryAlertRule = { id: 'watch', sessionKey: 'device', fieldKey: 'temperature', condition: 'above', threshold: 50, enabled: true };
function receive(store: TelemetrySessionStore, values: number[], nativeId = 'native') {
  const text = values.map((temperature) => JSON.stringify({ temperature })).join('\n') + '\n';
  store.ingestOrderedSerialEvent('device', { sessionId: nativeId, port: '/dev/test', sequence: 1, timestamp: new Date().toISOString(), text, bytes: [...new TextEncoder().encode(text)] });
}

describe('record-driven watches', () => {
  it('detects a brief breach even when the entire chart buffer is overwritten before a render', () => {
    const store = new TelemetrySessionStore({ maxSamplesPerSession: 2 });
    receive(store, [20, 21]);
    const events: TelemetryAlertEvent[] = [];
    const engine = new TelemetryWatchEngine(store, (event) => events.push(event));
    engine.setRules([rule]);
    receive(store, [20, 99, 20, 21, 22, 23]);
    expect(events.map((event) => event.value)).toEqual([99]);
    expect(store.getSnapshot('device').samples.map((sample) => sample.values.temperature.value)).toEqual([22, 23]);
    expect(engine.isBreached(rule.id)).toBe(false);
    engine.dispose();
  });

  it('ignores pre-arming history and re-arms at native reconnect and decoder boundaries', () => {
    const store = new TelemetrySessionStore(); receive(store, [99, 99]);
    const events: TelemetryAlertEvent[] = [];
    const engine = new TelemetryWatchEngine(store, (event) => events.push(event)); engine.setRules([rule]);
    expect(events).toHaveLength(0);
    receive(store, [99]); expect(events).toHaveLength(1);
    receive(store, [99]); expect(events).toHaveLength(1);
    receive(store, [99, 99], 'reconnected'); expect(events).toHaveLength(2);
    store.setDecoderProfile('device'); expect(engine.lastReadings.has(rule.id)).toBe(false);
    receive(store, [99, 99], 'reconnected'); expect(events).toHaveLength(3);
    engine.setRules([]); receive(store, [20, 99]); expect(events).toHaveLength(3);
    engine.dispose();
  });

  it('isolates faulty optional observers from serial parsing and other watches', () => {
    const store = new TelemetrySessionStore();
    store.subscribeRecords('device', () => { throw new Error('observer failed'); });
    const events: TelemetryAlertEvent[] = [];
    const engine = new TelemetryWatchEngine(store, (event) => events.push(event)); engine.setRules([rule]);
    receive(store, [20, 99]);
    expect(events).toHaveLength(1); expect(store.getSnapshot('device').acceptedSampleCount).toBe(2);
    engine.dispose();
  });
});

describe('watch timing and recovery', () => {
  function setup(options: Partial<TelemetryAlertRule> = {}) {
    const store = new TelemetrySessionStore();
    const events: TelemetryAlertEvent[] = [];
    let clock = 0; let sequence = 0;
    const engine = new TelemetryWatchEngine(store, (event) => events.push(event), () => clock);
    const watch = { ...rule, ...options };
    engine.setRules([watch]);
    function reading(time: number, temperature: number, nativeSessionId = 'native') {
      clock = time;
      const text = JSON.stringify({ temperature }) + '\n';
      store.ingestOrderedSerialEvent('device', { sessionId: nativeSessionId, port: '/dev/test', sequence: ++sequence, timestamp: new Date(time).toISOString(), text, bytes: [...new TextEncoder().encode(text)] });
    }
    return { engine, events, reading, store, watch };
  }
  it('requires continuing evidence, ignores short excursions, and does not alert on silence', () => {
    const { engine, events, reading } = setup({ sustainMs: 2000 });
    reading(0, 20); reading(100, 60); reading(1000, 20); expect(events).toHaveLength(0);
    reading(2000, 60); reading(3000, 60); expect(engine.isPending(rule.id)).toBe(true); expect(events).toHaveLength(0);
    reading(4000, 60); expect(events).toHaveLength(1); expect(engine.isBreached(rule.id)).toBe(true);
    reading(5000, 20); expect(engine.isBreached(rule.id)).toBe(false);
    engine.dispose();
  });
  it('breaks sustained evidence at stale gaps, reconnects, decoder changes, and clock reversal', () => {
    const { engine, events, reading, store } = setup({ sustainMs: 2000, staleAfterMs: 1000 });
    reading(0, 20); reading(100, 60); reading(5000, 60); expect(events).toHaveLength(0);
    reading(5500, 60, 'new'); expect(engine.isPending(rule.id)).toBe(true);
    store.setDecoderProfile('device'); expect(engine.isPending(rule.id)).toBe(false);
    reading(6000, 20, 'new'); reading(6200, 60, 'new'); reading(6100, 60, 'new'); expect(events).toHaveLength(0);
    engine.dispose();
  });
  it('keeps a breach latched near the limit and re-arms only after the recovery margin', () => {
    const { engine, events, reading } = setup({ hysteresis: 5 });
    reading(0, 20); reading(100, 60); reading(200, 49); reading(300, 51);
    expect(events).toHaveLength(1); expect(engine.isBreached(rule.id)).toBe(true);
    reading(400, 45); expect(engine.isBreached(rule.id)).toBe(false);
    reading(500, 51); expect(events).toHaveLength(2); engine.dispose();
  });
  it('resets a reconfigured watch without replaying old readings', () => {
    const { engine, events, reading, watch } = setup();
    reading(0, 20); reading(100, 60); expect(events).toHaveLength(1);
    engine.setRules([{ ...watch, threshold: 70, sustainMs: 1000 }]);
    expect(engine.isBreached(rule.id)).toBe(false); expect(engine.lastReadings.has(rule.id)).toBe(false);
    reading(200, 75); expect(events).toHaveLength(1); reading(1200, 75); expect(events).toHaveLength(2); engine.dispose();
  });
  it('isolates a failing alert consumer from other rules in the same sample', () => {
    const store = new TelemetrySessionStore(); const received: string[] = [];
    const engine = new TelemetryWatchEngine(store, (event) => { received.push(event.ruleId); if (event.ruleId === 'watch') throw new Error('failure'); });
    engine.setRules([rule, { ...rule, id: 'second' }]); receive(store, [20, 99]);
    expect(received).toEqual(['watch', 'second']); engine.dispose();
  });
});
