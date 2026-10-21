import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopWatchService } from './watch-service.mjs';
import { BenchJournal } from './bench-journal.mjs';

const services = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.stop())); });
const info = { id: 'native', port: '/dev/test', baudRate: 115200, sessionName: 'Board', logPath: '/capture.log', state: 'connected',
  settings: { dataBits: 8, parity: 'none', stopBits: 'one', flowControl: 'none' } };
const rule = { id: 'panic', identity: 'serial:%2Fdev%2Ftest:115200:8:none:one:none', sourceName: 'Board', name: 'Panic detected', pattern: 'panic',
  enabled: true, caseSensitive: false, desktopAlert: true, cooldownMs: 1000 };
async function start(directory, events) {
  const service = new DesktopWatchService(directory, (name, payload) => events.push({ name, payload }));
  services.push(service); await service.start(); return service;
}
describe('persistent log rules and capture results', () => {
  it('records log matches without a renderer and restores their rules and events after restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'baudtide-bench-test-'));
    const events = []; let monitor = await start(directory, events);
    await monitor.invoke('log_rule_put', { rule });
    const text = 'Guru meditation: PANIC\n';
    monitor.feed({ info, data: { sessionId: info.id, port: info.port, sequence: 1, timestamp: new Date().toISOString(), text, bytes: [...new TextEncoder().encode(text)] } });
    const page = await monitor.invoke('bench_events_list', { capturePath: info.logPath, limit: 100 });
    expect(page.events).toHaveLength(1); expect(page.events[0].label).toBe(rule.name);
    expect(events.find((e) => e.name === 'log-event')?.payload.desktopAlert).toBe(true);
    expect((await monitor.invoke('watch_history_summary')).count).toBe(0);
    await monitor.stop(); monitor = await start(directory, events);
    expect((await monitor.invoke('log_rules_snapshot')).rules).toEqual([rule]);
    expect((await monitor.invoke('bench_events_list', { capturePath: info.logPath, limit: 100 })).events).toEqual(page.events);
    const command = { id: 'step', kind: 'command', capturePath: info.logPath, sourceName: 'Board', timestamp: new Date().toISOString(), label: 'Read sensor passed', note: 'Matched OK' };
    await monitor.invoke('bench_event_append', { event: command });
    expect((await monitor.invoke('bench_events_list', { capturePath: info.logPath, limit: 100 })).events).toHaveLength(2);
    await expect(monitor.invoke('bench_event_append', { event: { ...command, kind: 'log' } })).rejects.toThrow('Only command');
  });
  it('pages events by capture with no omissions, and rejects invalid writes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'baudtide-bench-pages-'));
    const journal = new BenchJournal(directory);
    try {
      for (let i = 0; i < 205; i++) journal.append({ id: String(i), kind: 'command', capturePath: '/a.log', sourceName: 'Board', timestamp: new Date().toISOString(), label: 'Step passed', note: String(i) });
      journal.append({ id: 'other', kind: 'command', capturePath: '/b.log', sourceName: 'Other', timestamp: new Date().toISOString(), label: 'Step passed', note: '' });
      const events = []; let before;
      do { const page = journal.list({ capturePath: '/a.log', before, limit: 100 }); events.push(...page.events); before = page.nextBefore; } while (before);
      expect(events).toHaveLength(205); expect(new Set(events.map((e) => e.id)).size).toBe(205);
      expect(() => journal.append({ id: 'invalid', kind: 'command' })).toThrow('Invalid');
      expect(() => journal.list({ capturePath: '/a.log', before: -1 })).toThrow('Invalid');
      expect(journal.list({ capturePath: '/b.log' }).events).toHaveLength(1);
    } finally { journal.close(); }
  });
});
