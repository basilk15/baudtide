import { describe, expect, it, vi } from 'vitest';
import { DesktopLogRuntime, type LogRule, type LogMatchEvent } from './logRules';
import { stableTerminalSessionIdentity } from '../workspaces/sessionWorkspaces';
import type { StartedSerialSession } from './serial';

const info: StartedSerialSession = { id: 'native', port: '/dev/test', baudRate: 115200, sessionName: 'Board', logPath: '/board.log', state: 'connected',
  settings: { dataBits: 8, parity: 'none', stopBits: 'one', flowControl: 'none' } };
const rule: LogRule = { id: 'panic', identity: stableTerminalSessionIdentity(info), sourceName: 'Board', name: 'Firmware panic', pattern: 'panic',
  enabled: true, caseSensitive: false, desktopAlert: true, cooldownMs: 1000 };
function fixture(rules = [rule]) {
  let time = 1000; let sequence = 0;
  const events: LogMatchEvent[] = [];
  const persist = vi.fn();
  const runtime = new DesktopLogRuntime(rules, persist, (event) => events.push(event), () => {}, () => time);
  const feed = (text: string, skipped = 0, session = info) => {
    sequence += 1 + skipped;
    runtime.feed({ info: session, data: { sessionId: session.id, port: session.port, sequence, timestamp: new Date(time).toISOString(), text, bytes: [...new TextEncoder().encode(text)] } });
  };
  return { runtime, events, persist, feed, advance: () => { time += 1000; } };
}
describe('native log event rules', () => {
  it('assembles split lines, observes case and cooldown, and retains capture context', () => {
    const f = fixture();
    f.feed('PAN'); f.feed('IC in task\r'); f.feed('\nPANIC again\n');
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ kind: 'log', label: rule.name, capturePath: '/board.log', note: 'PANIC in task' });
    f.advance(); f.feed('panic later\n'); expect(f.events).toHaveLength(2);
    f.runtime.put({ ...rule, enabled: false }); f.advance(); f.feed('panic\n'); expect(f.events).toHaveLength(2);
    expect(f.persist).toHaveBeenCalled();
  });
  it('never combines fragments across dropped data, disconnects, or rule edits', () => {
    const f = fixture(); f.feed('pa'); f.feed('nic\n', 1); expect(f.events).toHaveLength(0);
    f.feed('pa'); f.runtime.status({ sessionId: info.id, port: info.port, status: 'disconnected', message: '' }); f.feed('nic\n');
    f.feed('pa'); f.runtime.put(rule); f.feed('nic\n'); expect(f.events).toHaveLength(0);
    f.feed('panic\n'); expect(f.events).toHaveLength(1);
  });
  it('ignores duplicate chunks and pauses ambiguous device identities', () => {
    const f = fixture(); f.feed('panic\n'); f.advance();
    const text = 'panic\n';
    f.runtime.feed({ info, data: { sessionId: info.id, port: info.port, sequence: 1, timestamp: new Date().toISOString(), text, bytes: [...new TextEncoder().encode(text)] } });
    f.feed(text, 0, { ...info, id: 'other' }); f.feed(text); expect(f.events).toHaveLength(1);
    expect(f.runtime.snapshot().interruption).toContain('ambiguous');
  });
  it('keeps plain-text matching literal and rejects invalid settings without overwriting rules', () => {
    const f = fixture([{ ...rule, pattern: 'panic.*', caseSensitive: true }]);
    f.feed('panic now\n'); f.feed('panic.*\n'); expect(f.events).toHaveLength(1);
    expect(() => f.runtime.put({ ...rule, cooldownMs: NaN })).toThrow('cooldown');
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().rules[0].pattern).toBe('panic.*');
  });
  it('continues matching when history persistence fails', () => {
    const notify = vi.fn();
    const runtime = new DesktopLogRuntime([rule], () => {}, () => { throw new Error('Full'); }, notify);
    const text = 'panic\n'; runtime.feed({ info, data: { sessionId: info.id, port: info.port, sequence: 1, timestamp: new Date().toISOString(), text, bytes: [...new TextEncoder().encode(text)] } });
    expect(notify).toHaveBeenCalledOnce(); expect(runtime.snapshot().error).toContain('could not be saved');
  });
});
