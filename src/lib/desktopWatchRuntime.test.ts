import { describe, expect, it } from 'vitest';
import { DesktopWatchRuntime, type DesktopWatch, type WatchFeedEvent } from './desktopWatchRuntime';
import { stableTerminalSessionIdentity } from './sessionWorkspaces';
import type { StartedSerialSession } from './serial';
import type { WatchHistoryRow } from './watchHistory';
import type { TelemetryDecoderProfile } from './telemetryDecoders';

const info: StartedSerialSession = { id: 'native', port: '/dev/ttyTEST', baudRate: 115200, sessionName: 'Board', logPath: '/capture.log', state: 'connected',
  settings: { dataBits: 8, parity: 'none', stopBits: 'one', flowControl: 'none' } };
const identity = stableTerminalSessionIdentity(info);
const watch: DesktopWatch = { sourceName: 'Board', rule: { id: 'watch', sessionKey: identity, fieldKey: 'temperature', condition: 'above', threshold: 50, enabled: true } };
function fixture(saved: DesktopWatch[] = []) {
  let configuration = saved;
  let time = 10000; let sequence = 0;
  const events: WatchHistoryRow[] = [];
  const runtime = new DesktopWatchRuntime(saved, (next) => { configuration = next; }, (event) => { events.push(event); return events.length; }, () => {}, () => time);
  function feed(values: number[], session = info, advance = 100, skipped = 0) {
    time += advance;
    sequence += 1 + skipped;
    const text = values.map((temperature) => JSON.stringify({ temperature })).join('\n') + '\n';
    const event: WatchFeedEvent = { info: session, data: { sessionId: session.id, port: session.port, sequence,
      timestamp: new Date(time).toISOString(), text, bytes: [...new TextEncoder().encode(text)] } };
    runtime.feed(event); return event;
  }
  return { runtime, events, feed, configuration: () => configuration };
}

describe('application-owned watches', () => {
  it('records a brief breach without a renderer and survives renderer reattachment without re-arming', () => {
    const f = fixture(); f.feed([20, 21]); f.runtime.put(watch);
    f.feed([20, 99, 20]); // No UI subscriptions, mounts, or renderer replay needed.
    expect(f.events.map((event) => event.value)).toEqual([99]);
    expect(f.events[0].capturePath).toBe(info.logPath);
    expect(f.runtime.put({ ...watch, rule: { ...watch.rule, id: 'restored-copy' } })).toBe('watch');
    const event = f.feed([99]); f.runtime.feed(event); f.feed([99]);
    expect(f.events.map((event) => event.value)).toEqual([99, 99]);
    expect(f.runtime.snapshot().watches).toHaveLength(1);
    expect(f.configuration()).toHaveLength(1); f.runtime.dispose();
  });
  it('reloads persisted unsaved rules, resets evidence at disconnect, and follows the next physical capture', () => {
    const f = fixture([watch]); f.feed([20, 99]);
    f.runtime.status({ sessionId: info.id, port: info.port, status: 'disconnected', message: '' });
    expect(f.runtime.snapshot().watches[0].nativeSessionId).toBeUndefined();
    f.feed([20, 99], { ...info, id: 'reconnected', logPath: '/next.log' });
    expect(f.events.map((event) => event.capturePath)).toEqual(['/capture.log', '/next.log']); f.runtime.dispose();
  });
  it('does not combine sustained evidence across a missing sequence', () => {
    const f = fixture([{ ...watch, rule: { ...watch.rule, sustainMs: 1000 } }]);
    f.feed([20, 21]); f.feed([99]); f.feed([99], info, 500);
    f.feed([99], info, 100, 5);
    f.feed([99], info, 600);
    expect(f.events).toHaveLength(0); expect(f.runtime.snapshot().interruption).toContain('missed');
    f.feed([99], info, 600); expect(f.events).toHaveLength(1); f.runtime.dispose();
  });
  it('does not re-arm or discard sustained evidence when the same decoder is restored', () => {
    const f = fixture([watch]); f.feed([20, 99]);
    f.runtime.decoder(identity); f.feed([99]);
    expect(f.events).toHaveLength(1); expect(f.runtime.snapshot().watches[0].breached).toBe(true);
    f.runtime.dispose();
    const sustained = fixture([{ ...watch, rule: { ...watch.rule, sustainMs: 1000 } }]);
    sustained.feed([20, 21]); sustained.feed([99]); sustained.feed([99], info, 500);
    sustained.runtime.decoder(identity); sustained.feed([99], info, 500);
    expect(sustained.events).toHaveLength(1); sustained.runtime.dispose();
  });
  it('keeps the armed parser when an older analysis adds another watched signal', () => {
    const decoder: TelemetryDecoderProfile = { version: 1, id: 'armed', name: 'Board decoder', prefix: 'DATA',
      separator: 'comma', fields: [{ column: 1, name: 'temperature' }, { column: 2, name: 'voltage' }], createdAt: 1, updatedAt: 1 };
    const f = fixture([{ ...watch, decoder }]);
    f.runtime.put({ sourceName: 'Board', decoder: { ...decoder, id: 'old', prefix: 'OLD' },
      rule: { ...watch.rule, id: 'voltage', fieldKey: 'voltage', threshold: 5 } });
    const text = 'DATA 20,3\nDATA 99,9\n';
    f.runtime.feed({ info, data: { sessionId: info.id, port: info.port, sequence: 1, timestamp: new Date().toISOString(), text, bytes: [...new TextEncoder().encode(text)] } });
    expect(f.runtime.snapshot().watches.map((entry) => entry.decoder?.id)).toEqual(['armed', 'armed']);
    expect(f.events.map((event) => event.fieldKey)).toEqual(['temperature', 'voltage']); f.runtime.dispose();
  });
  it('preserves rules if persistence fails and isolates history failure from other watches', () => {
    const events: WatchHistoryRow[] = [];
    const runtime = new DesktopWatchRuntime([watch], () => { throw new Error('disk full'); }, () => { throw new Error('disk full'); }, (event) => events.push(event));
    expect(() => runtime.remove(['watch'])).toThrow('disk full');
    const text = '{"temperature":20}\n{"temperature":99}\n';
    runtime.feed({ info, data: { sessionId: info.id, port: info.port, sequence: 1, timestamp: new Date().toISOString(), text, bytes: [...new TextEncoder().encode(text)] } });
    expect(events).toHaveLength(1); expect(runtime.snapshot().historyError).toContain('not saved'); runtime.dispose();
  });
  it('pauses ambiguous identities instead of applying a watch to another adapter', () => {
    const f = fixture([watch]); f.feed([20, 21]); f.feed([99], { ...info, id: 'duplicate' });
    expect(f.events).toHaveLength(0); expect(f.runtime.snapshot().interruption).toContain('same device identity'); f.runtime.dispose();
  });
});
