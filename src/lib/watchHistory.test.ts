import { describe, expect, it } from 'vitest';
import { WatchHistoryJournal, watchHistoryExportChunks, type WatchHistoryStorage, type WatchHistoryRow, type StoredWatchEvent } from './watchHistory';

function event(i: number): WatchHistoryRow {
  return { id: `event-${i}`, ruleId: 'watch', sessionKey: 'source', sampleId: `sample-${i}`, timestamp: new Date(i * 1000).toISOString(), fieldKey: 'voltage', value: i, condition: 'above', threshold: 10, sourceName: 'Board,"A"', occurrence: i + 1, sourceIdentity: 'serial:board', capturePath: '/saved/capture.log', sustainMs: 1000, hysteresis: 2, staleAfterMs: 30000 };
}
function memoryStorage() {
  const rows: StoredWatchEvent[] = [];
  const requested: number[] = [];
  const storage: WatchHistoryStorage = {
    async append(row) { rows.push({ sequence: rows.length + 1, event: row }); },
    async summary() { return { count: rows.length, through: rows[rows.length - 1]?.sequence ?? 0 }; },
    async latest(limit) { return rows.slice(-limit).reverse(); },
    async page(after, through, limit) { requested.push(limit); return rows.filter((row) => row.sequence > after && row.sequence <= through).slice(0, limit); },
  };
  return { storage, rows, requested };
}
async function text(chunks: AsyncIterable<string>) { let result = ''; for await (const chunk of chunks) { expect(chunk.length).toBeLessThan(40000); result += chunk; } return result; }

describe('durable breach history', () => {
  it('retains more than the displayed 100 entries and reloads and exports every saved event', async () => {
    const { storage, requested } = memoryStorage();
    const journal = new WatchHistoryJournal(storage);
    for (let i = 0; i < 1005; i += 1) await journal.append(event(i));
    const reloaded = new WatchHistoryJournal(storage);
    const latest = await reloaded.latest(); expect(latest).toHaveLength(100); expect(latest[0].event.id).toBe('event-1004');
    const json = JSON.parse(await text(watchHistoryExportChunks(reloaded.events(), 'json')));
    expect(json.events).toHaveLength(1005); expect(json.events[0]).toEqual(event(0)); expect(json.events.at(-1)).toEqual(event(1004));
    expect(requested.every((limit) => limit === 256)).toBe(true);
    const csv = await text(watchHistoryExportChunks(reloaded.events(), 'csv'));
    expect(csv.split('\n')).toHaveLength(1007); expect(csv).toContain('"Board,""A"""');
    expect(csv).toContain('1000,2,30000');
  });
  it('exports a fixed snapshot while later live breaches continue to be saved', async () => {
    const { storage } = memoryStorage(); const journal = new WatchHistoryJournal(storage);
    await journal.append(event(1)); const iterator = journal.events();
    expect((await iterator.next()).value?.id).toBe('event-1');
    await journal.append(event(2)); expect((await iterator.next()).done).toBe(true);
    expect((await journal.summary()).count).toBe(2);
  });
  it('surfaces disk errors without poisoning subsequent writes and cancels reading promptly', async () => {
    const { storage } = memoryStorage(); const append = storage.append; let failed = false;
    storage.append = async (row) => { if (!failed) { failed = true; throw new Error('disk full'); } await append(row); };
    const journal = new WatchHistoryJournal(storage);
    await expect(journal.append(event(1))).rejects.toThrow('disk full');
    await journal.append(event(2)); expect((await journal.summary()).count).toBe(1);
    const abort = new AbortController(); abort.abort();
    await expect(journal.events(abort.signal).next()).rejects.toThrow();
  });
  it('bounds pending disk writes and exposes overflow instead of silently claiming it was saved', async () => {
    const { storage } = memoryStorage(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const append = storage.append;
    storage.append = async (row) => { await gate; await append(row); };
    const journal = new WatchHistoryJournal(storage);
    const writes = Array.from({ length: 2048 }, (_, i) => journal.append(event(i)));
    await expect(journal.append(event(2048))).rejects.toThrow('cannot keep up'); release();
    await Promise.all(writes); expect((await journal.summary()).count).toBe(2048);
  });
});
