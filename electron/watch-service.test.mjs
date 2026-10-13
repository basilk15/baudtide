import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopWatchService } from './watch-service.mjs';
import { WatchJournal } from './watch-journal.mjs';

const info = { id: 'native', port: '/dev/ttyTEST', baudRate: 115200, sessionName: 'Board', logPath: '/capture.log', state: 'connected',
  settings: { dataBits: 8, parity: 'none', stopBits: 'one', flowControl: 'none' } };
const watch = { sourceName: 'Board', rule: { id: 'watch', sessionKey: 'serial:%2Fdev%2FttyTEST:115200:8:none:one:none',
  fieldKey: 'temperature', condition: 'above', threshold: 50, enabled: true } };
const services = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.stop())); });
async function service(directory, options) {
  const events = [];
  const monitor = new DesktopWatchService(directory, (name, event) => { if (name === 'watch-event') events.push(event); }, options);
  services.push(monitor); await monitor.start();
  return { monitor, events };
}
function feed(monitor, sequence, values) {
  const text = values.map((temperature) => JSON.stringify({ temperature })).join('\n') + '\n';
  monitor.feed({ info, data: { sessionId: info.id, port: info.port, sequence,
    timestamp: new Date().toISOString(), text, bytes: [...new TextEncoder().encode(text)] } });
}

describe('desktop watch worker and journal', () => {
  it('keeps monitoring without UI subscribers, returns persisted history after reattachment, and restores unsaved rules after restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'baudtide-watch-test-'));
    const { monitor, events } = await service(directory);
    feed(monitor, 1, [20, 21]); await monitor.invoke('watch_put', { watch });
    feed(monitor, 2, [20, 99, 20]);
    const snapshot = await monitor.invoke('watch_snapshot');
    expect(snapshot.watches).toHaveLength(1); expect(snapshot.historyCount).toBe(1); expect(events).toHaveLength(1);
    feed(monitor, 2, [20, 99, 20]);
    expect((await monitor.invoke('watch_history_summary')).count).toBe(1);
    await monitor.stop();
    const restarted = (await service(directory)).monitor;
    expect((await restarted.invoke('watch_snapshot')).watches[0].rule.id).toBe('watch');
    expect((await restarted.invoke('watch_history_latest', { limit: 100 }))[0].event.id).toBe(events[0].id);
    feed(restarted, 3, [20, 99]);
    expect((await restarted.invoke('watch_history_summary')).count).toBe(2);
    await restarted.invoke('watch_remove', { ids: ['watch'] });
    feed(restarted, 4, [20, 99]); expect((await restarted.invoke('watch_history_summary')).count).toBe(2);
  });

  it('reports a bounded-feed interruption instead of silently claiming continuous monitoring', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'baudtide-watch-overload-'));
    const { monitor } = await service(directory, { maxFeedBytes: 10 });
    await monitor.invoke('watch_put', { watch }); feed(monitor, 1, [20, 99]);
    const snapshot = await monitor.invoke('watch_snapshot');
    expect(snapshot.interruption).toContain('missed'); expect(snapshot.historyCount).toBe(0);
  });

  it('reports worker failure and resumes persisted watches only with fresh evidence after retry', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'baudtide-watch-retry-'));
    const states = [];
    const monitor = new DesktopWatchService(directory, (name, state) => { if (name === 'watch-state') states.push(state); });
    services.push(monitor); await monitor.start();
    feed(monitor, 1, [20, 21]); await monitor.invoke('watch_put', { watch });
    feed(monitor, 2, [99]);
    expect((await monitor.invoke('watch_snapshot')).watches[0].breached).toBe(true);
    await monitor.worker.terminate();
    expect(states.some((state) => state.unavailable && state.interruption.includes('Raw capture continues'))).toBe(true);
    const resumed = await monitor.invoke('watch_snapshot');
    expect(resumed.interruption).toContain('restarted'); expect(resumed.historyCount).toBe(1);
    expect(resumed.watches[0].rule.id).toBe(watch.rule.id); expect(resumed.watches[0].nativeSessionId).toBeUndefined();
    feed(monitor, 3, [20, 99]);
    expect((await monitor.invoke('watch_history_summary')).count).toBe(2);
  });

  it('copies legacy history idempotently and exports a fixed paginated snapshot while new breaches append', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'baudtide-watch-journal-'));
    const journal = new WatchJournal(directory);
    try {
      const events = Array.from({ length: 1005 }, (_, i) => ({ id: `legacy-${i}`, ruleId: 'legacy', sessionKey: 'old-device',
        sourceName: 'Old board', fieldKey: 'voltage', value: 99, condition: 'above', threshold: 50,
        timestamp: new Date(i * 1000).toISOString(), occurrence: i + 1 }));
      for (let i = 0; i < events.length; i += 256) journal.import(events.slice(i, i + 256));
      journal.import(events.slice(0, 256));
      const { through, count } = journal.summary(); expect(count).toBe(1005);
      journal.append({ ...events[0], id: 'new-breach' });
      let after = 0; const exported = [];
      while (after < through) {
        const page = journal.page(after, through, 256); exported.push(...page); after = page.at(-1).sequence;
      }
      expect(exported).toHaveLength(1005); expect(journal.summary().count).toBe(1006);
      expect(() => journal.page(-1, through, 256)).toThrow('cursor');
      expect(() => journal.import([{ ...events[0], id: 'bad-event', value: null }])).toThrow('Invalid');
      expect(journal.summary().count).toBe(1006);
    } finally { journal.close(); }
    // These isolated fixtures are retained; no existing application data is touched.
  });
});
