import { describe, expect, it, vi } from 'vitest';
import { CaptureAnalysisIndex, analyzeNativeCapture, type CapturePageStore } from './captureAnalysis';
import { TelemetrySessionStore } from './telemetry';
import { telemetryExportChunks, type TelemetryExportRow } from './telemetryExport';
import type { CaptureAnalysisChunk, SavedLog } from './serial';

const native = vi.hoisted(() => ({ open: vi.fn(), read: vi.fn(), close: vi.fn() }));
vi.mock('./serial', () => ({ openNativeCaptureAnalysis: native.open, readNativeCaptureAnalysisChunk: native.read, closeNativeCaptureAnalysis: native.close }));

function memoryPages(): CapturePageStore {
  const pages = new Map<string, unknown>();
  return { async put(id, page, value) { pages.set(`${id}:${page}`, value); },
    async get(id, page) { return pages.get(`${id}:${page}`) as Awaited<ReturnType<CapturePageStore['get']>>; },
    async release(id) { for (const key of pages.keys()) if (key.startsWith(`${id}:`)) pages.delete(key); } };
}

describe('complete capture index and export', () => {
  it('preserves the order and latest reading of a burst sharing one receive time and sequence', async () => {
    const index = new CaptureAnalysisIndex(memoryPages());
    const store = new TelemetrySessionStore({ maxSamplesPerSession: 1 });
    store.subscribeRecords('burst', (observation) => { if (observation.type === 'sample') index.append(observation.sample); });
    const text = [20, 999, 21].map((temperature) => JSON.stringify({ temperature })).join('\n') + '\n';
    store.ingestOrderedSerialEvent('burst', { sessionId: 'saved', port: 'saved', sequence: 1, timestamp: new Date(1000).toISOString(), text, bytes: [...new TextEncoder().encode(text)] });
    await index.flush(true); index.metadata = store.getSnapshot('burst');
    const { snapshot } = await index.query();
    expect(snapshot.samples.map((sample) => sample.values.temperature.value)).toEqual([20, 999, 21]);
    expect(snapshot.samples[snapshot.samples.length - 1]?.values.temperature.value).toBe(21);
    const full = []; for await (const sample of index.samples()) full.push(sample.values.temperature.value);
    expect(full).toEqual([20, 999, 21]);
    await index.dispose();
  });

  it('keeps equal-time extrema in capture order across disk pages and selected signals', async () => {
    const index = new CaptureAnalysisIndex(memoryPages());
    const store = new TelemetrySessionStore({ maxSamplesPerSession: 1 });
    store.subscribeRecords('pages', (observation) => { if (observation.type === 'sample') index.append(observation.sample); });
    const text = Array.from({ length: 1030 }, (_, ordinal) => JSON.stringify({ temperature: ordinal === 512 ? 999 : 20, voltage: ordinal === 1000 ? 9 : 3 })).join('\n') + '\n';
    store.ingestOrderedSerialEvent('pages', { sessionId: 'saved', port: 'saved', sequence: 7, timestamp: new Date(1000).toISOString(), text, bytes: [...new TextEncoder().encode(text)] });
    await index.flush(true); index.metadata = store.getSnapshot('pages');
    for (const keys of [['temperature'], ['voltage', 'temperature']]) {
      const { snapshot, matched } = await index.query(index.range, keys);
      const ordinals = snapshot.samples.map((sample) => Number(sample.id.slice(sample.id.lastIndexOf(':') + 1)));
      expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
      expect(matched).toBe(1030);
      expect(ordinals[ordinals.length - 1]).toBe(1030);
      expect(snapshot.samples.some((sample) => sample.values.temperature.value === 999)).toBe(true);
    }
    await index.dispose();
  });

  it('keeps small legacy captures replayable and closes native readers on cancellation', async () => {
    const text = '{"temperature":20}\n{"temperature":21}\n{"temperature":22}\n';
    const log = { path: '/capture.log', fileName: 'capture.log', sessionName: 'Capture', sizeBytes: text.length, modifiedAt: '2026-10-01T00:00:05Z', startedAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:00:05Z', metadataAvailable: true, state: 'saved' } satisfies SavedLog;
    native.open.mockResolvedValue({ id: 'reader', totalBytes: text.length, timingMode: 'approximate' });
    native.close.mockResolvedValue(undefined);
    native.read.mockResolvedValue({ offset: 0, nextOffset: text.length, totalBytes: text.length, rawBase64: btoa(text), timing: null } satisfies CaptureAnalysisChunk);
    const result = await analyzeNativeCapture('legacy', log, { pages: memoryPages() });
    expect(result.index.totalRecords).toBe(3);
    expect(result.index.range.end).toBeGreaterThan(result.index.range.start);
    expect(result.snapshot.samples.map((sample) => sample.values.temperature.value)).toEqual([20, 21, 22]);
    expect(native.close).toHaveBeenCalledWith('reader');
    await result.index.dispose();
    const abort = new AbortController(); abort.abort();
    await expect(analyzeNativeCapture('cancelled', log, { pages: memoryPages(), signal: abort.signal })).rejects.toThrow();
    expect(native.close).toHaveBeenCalledTimes(2);
  });
  it('retains and exports all records beyond 10,000, preserves spikes, and queries arbitrary ranges', async () => {
    const index = new CaptureAnalysisIndex(memoryPages());
    const store = new TelemetrySessionStore({ maxSamplesPerSession: 1 });
    store.subscribeRecords('capture', (observation) => { if (observation.type === 'sample') index.append(observation.sample); });
    for (let i = 0; i < 20005; i += 1) {
      const text = `${JSON.stringify({ temperature: i === 10001 ? 999999 : i })}\n`;
      store.ingestOrderedSerialEvent('capture', { sessionId: 'saved', port: 'saved', sequence: i + 1, timestamp: new Date(i * 10).toISOString(), text, bytes: [...new TextEncoder().encode(text)] });
      if (i % 512 === 0) await index.flush();
    }
    await index.flush(true); index.metadata = store.getSnapshot('capture');
    const full = await index.query();
    expect(index.totalRecords).toBe(20005); expect(full.matched).toBe(20005);
    expect(full.snapshot.samples.length).toBeLessThanOrEqual(256 * 4);
    expect(full.snapshot.samples.some((sample) => sample.values.temperature.value === 999999)).toBe(true);
    expect(full.snapshot.samples[0].values.temperature.value).toBe(0);
    const tail = await index.query({ start: 200000, end: 200040 });
    expect(tail.matched).toBe(5); expect(tail.snapshot.samples[tail.snapshot.samples.length - 1]?.values.temperature.value).toBe(20004);
    async function* rows(): AsyncGenerator<TelemetryExportRow> {
      for await (const sample of index.samples()) yield { source: 'sensor,"A"', sourceType: 'recorded', originalTimestamp: sample.timestamp, alignedTimestamp: sample.timestamp, elapsedMs: Date.parse(sample.timestamp), field: 'temperature', value: sample.values.temperature.value, unit: '', timing: 'recorded' };
    }
    const chunks: string[] = []; for await (const chunk of telemetryExportChunks(rows(), 'json', 'clock')) { expect(chunk.length).toBeLessThan(35000); chunks.push(chunk); }
    const exported = JSON.parse(chunks.join(''));
    expect(exported.rows).toHaveLength(20005); expect(exported.rows[0].value).toBe(0); expect(exported.rows.at(-1).value).toBe(20004);
    const csv: string[] = []; for await (const chunk of telemetryExportChunks(rows(), 'csv', 'clock')) csv.push(chunk);
    expect(csv.join('').split('\n')).toHaveLength(20007);
    expect(csv[0]).toContain('"sensor,""A"""');
    await index.dispose();
  });
});
