import { describe, expect, it } from 'vitest';
import { CaptureAnalysisIndex, type CapturePageStore } from './captureAnalysis';
import { compareCaptureSignal, comparisonDelta, compatibleComparisonFields, normalizeCaptureComparison } from './captureComparison';
import { TelemetrySessionStore, type TelemetryField, type TelemetrySample } from '../telemetry/telemetry';

const field: TelemetryField = { key: 'temperature', unit: 'C', formats: ['json'] };
const origin = Date.parse('2026-10-18T10:00:00Z');
async function index(values: Array<number | { value: number; unit: string }>) {
  const cache = new Map<number, Parameters<CapturePageStore['put']>[2]>();
  const pages: CapturePageStore = { async put(_id, page, value) { cache.set(page, value); }, async get(_id, page) { return cache.get(page)!; }, async release() {} };
  const result = new CaptureAnalysisIndex(pages); result.metadata = new TelemetrySessionStore().getSnapshot('capture');
  for (const [i, value] of values.entries()) result.append({ id: String(i), timestamp: new Date(origin + i * 1000).toISOString(), nativeSessionId: 'capture', sequence: i + 1, format: 'json', schemaId: 'json',
    values: { temperature: typeof value === 'number' ? { value, unit: 'C' } : value } } satisfies TelemetrySample);
  await result.flush(true); return result;
}
describe('full-history run comparison', () => {
  it('calculates exact statistics across pages, independently of the chart overview', async () => {
    const source = await index(Array.from({ length: 2000 }, (_, i) => i));
    const result = await compareCaptureSignal(source, field, origin, 0, 1999, source.range, new AbortController().signal);
    expect(result.statistics).toMatchObject({ count: 2000, min: 0, max: 1999, mean: 999.5 });
    expect(result.samples.length).toBeLessThan(2000);
    expect(result.statistics.deviation).toBeCloseTo(Math.sqrt((2000 ** 2 - 1) / 12));
  });
  it('aligns on an event and includes negative relative time while respecting selected ranges', async () => {
    const source = await index([10, 20, 30, 40, 50]);
    const result = await compareCaptureSignal(source, field, origin + 3000, -2, 1, { start: origin + 2000, end: origin + 4000 }, new AbortController().signal);
    expect(result.statistics).toMatchObject({ count: 3, min: 30, max: 50, mean: 40 });
  });
  it('does not mix units or invent data in an empty interval', async () => {
    const source = await index([10, { value: 100, unit: 'F' }, 30]);
    const result = await compareCaptureSignal(source, field, origin, 0, 3, source.range, new AbortController().signal);
    expect(result.statistics).toMatchObject({ count: 2, mean: 20, skippedUnits: 1 });
    const empty = await compareCaptureSignal(source, field, origin, 10, 20, source.range, new AbortController().signal);
    expect(empty.statistics).toMatchObject({ count: 0, min: null, mean: null });
    expect(compatibleComparisonFields(field, { ...field, unit: 'F' })).toBe(false);
    expect(comparisonDelta(0, 10)).toEqual({ absolute: 10, percent: null });
    expect(comparisonDelta(-10, -5)).toEqual({ absolute: 5, percent: 50 });
  });
  it('cancels work and validates persisted intervals', async () => {
    const source = await index([10, 20]); const abort = new AbortController(); abort.abort();
    await expect(compareCaptureSignal(source, field, origin, 0, 10, source.range, abort.signal)).rejects.toThrow();
    expect(normalizeCaptureComparison({ baselinePath: 'a', candidatePath: 'b', baselineField: 'x', candidateField: 'x', baselineEvent: '', candidateEvent: '', startSeconds: 10, endSeconds: 0 })).toBeNull();
  });
});
