import { describe, expect, it } from 'vitest';
import { comparisonHistoryCsv, loadComparisonHistory, removeComparisonResult, saveComparisonResult, type ComparisonHistoryRecord } from './comparisonHistory';
import { evaluateChecks, type ComparisonCheck } from './comparisonChecks';
import type { SignalStatistics } from './captureComparison';

const baseline: SignalStatistics = { count: 2, min: 20, max: 20, mean: 20, deviation: 0, skippedUnits: 0 };
const candidate: SignalStatistics = { count: 2, min: 24, max: 24, mean: 24, deviation: 0, skippedUnits: 0 };
const check: ComparisonCheck = { id: 'mean', metric: 'mean', measure: 'percent', operator: 'lte', limit: 10 };
const side = (statistics: SignalStatistics, name: string) => ({ name, field: 'temperature', anchorMs: 1000, requested: { start: 1000, end: 2000 }, effective: { start: 1000, end: 2000 }, state: 'disconnected' as const, timingMode: 'recorded' as const, statistics });
const record: ComparisonHistoryRecord = { id: 'result-1', savedAt: '2026-11-12T07:00:00.000Z', baselinePath: '/a.log', candidatePath: '/b.log', snapshot: { baseline: side(baseline, 'A'), candidate: side(candidate, 'B'), unit: 'C', startSeconds: 0, endSeconds: 1, evaluation: evaluateChecks([check], baseline, candidate, []) } };
function memory(initial: string | null = null) { let value = initial; return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; }, raw: () => value }; }

describe('saved comparison history', () => {
  it('round-trips independent pass, fail and inconclusive snapshots', () => {
    const storage = memory();
    for (const [id, rules, reasons] of [['fail', [check], []], ['pass', [{ ...check, limit: 25 }], []], ['uncertain', [check], ['Timing is approximate.']]] as const) {
      saveComparisonResult({ ...record, id, snapshot: { ...record.snapshot, evaluation: evaluateChecks(rules, baseline, candidate, reasons) } }, storage);
    }
    const loaded = loadComparisonHistory(storage);
    expect(loaded.map((item) => item.snapshot.evaluation?.status)).toEqual(['inconclusive', 'pass', 'fail']);
    expect(loaded[1].snapshot.candidate.statistics.mean).toBe(24);
    loaded[1].snapshot.candidate.statistics.mean = 99;
    expect(loadComparisonHistory(storage)[1].snapshot.candidate.statistics.mean).toBe(24);
  });
  it('preserves unreadable or inconsistent data when an update is attempted', () => {
    for (const raw of ['{bad', JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: [record, record] }), JSON.stringify({ version: 1, records: [{ ...record, snapshot: { ...record.snapshot, evaluation: { ...record.snapshot.evaluation!, status: 'pass' } } }] })]) {
      const storage = memory(raw);
      expect(() => saveComparisonResult(record, storage)).toThrow();
      expect(() => removeComparisonResult('result-1', storage)).toThrow();
      expect(storage.raw()).toBe(raw);
    }
  });
  it('rejects non-finite values, duplicates and full histories rather than replacing prior results', () => {
    const storage = memory(); saveComparisonResult(record, storage); const before = storage.raw();
    expect(() => saveComparisonResult(record, storage)).toThrow();
    expect(() => saveComparisonResult({ ...record, id: 'bad', snapshot: { ...record.snapshot, candidate: { ...record.snapshot.candidate, statistics: { ...candidate, mean: Infinity } } } }, storage)).toThrow();
    expect(storage.raw()).toBe(before);
    for (let n = 2; n <= 50; n++) saveComparisonResult({ ...record, id: `result-${n}` }, storage);
    const full = storage.raw(); expect(() => saveComparisonResult({ ...record, id: '51' }, storage)).toThrow(); expect(storage.raw()).toBe(full);
  });
  it('removes only the selected result and reports unavailable storage', () => {
    const storage = memory(); saveComparisonResult(record, storage); saveComparisonResult({ ...record, id: 'second' }, storage);
    removeComparisonResult('result-1', storage);
    expect(loadComparisonHistory(storage).map((r) => r.id)).toEqual(['second']);
    const failed = { getItem: () => { throw new Error('denied'); }, setItem: () => {} };
    expect(() => loadComparisonHistory(failed)).toThrow(/storage/i);
    const quota = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(() => saveComparisonResult(record, quota)).toThrow(/save/i);
  });
  it('rejects coerced outcome types and a pass from an active capture', () => {
    const passing = evaluateChecks([{ ...check, limit: 25 }], baseline, candidate, []);
    const malformed = { ...record, id: 'array', snapshot: { ...record.snapshot, evaluation: { ...passing, results: [{ ...passing.results[0], status: ['pass'] }] } } };
    const active = { ...record, id: 'active', snapshot: { ...record.snapshot, candidate: { ...record.snapshot.candidate, state: 'capturing' as const }, evaluation: passing } };
    const storage = memory();
    expect(() => saveComparisonResult(malformed as unknown as ComparisonHistoryRecord, storage)).toThrow();
    expect(() => saveComparisonResult(active, storage)).toThrow();
    expect(storage.raw()).toBeNull();
  });

  it('exports the saved timestamp and safely quoted capture paths with the snapshot', () => {
    const csv = comparisonHistoryCsv({ ...record, baselinePath: '=device,"one"\nlog' });
    expect(csv).toContain('"saved_at","2026-11-12T07:00:00.000Z"');
    expect(csv).toContain('"baseline_path","\'=device,""one""\nlog"');
    expect(csv).toContain('"mean","percent","lte","10","20","%","fail"');
    expect(comparisonHistoryCsv({ ...record, savedAt: '+2026-01-01' })).toContain(`"saved_at","'+2026-01-01"`);
  });

  it('rejects timestamp ranges that cannot be displayed without overwriting history', () => {
    const storage = memory();
    const invalid = { ...record, snapshot: { ...record.snapshot, evaluation: evaluateChecks([check], baseline, candidate, ['Interval unavailable.']), baseline: { ...record.snapshot.baseline, requested: { start: 1e99, end: 1e99 } } } };
    expect(() => saveComparisonResult(invalid, storage)).toThrow();
    expect(storage.raw()).toBeNull();
  });

  it('enforces the byte limit without changing an existing history', () => {
    const storage = memory();
    const large = 'é'.repeat(8000);
    let previous = storage.raw(); let failed = false;
    for (let n = 0; n < 50; n++) {
      try { saveComparisonResult({ ...record, id: `large-${n}`, baselinePath: large, candidatePath: large }, storage); previous = storage.raw(); }
      catch { failed = true; break; }
    }
    expect(failed).toBe(true); expect(storage.raw()).toBe(previous);
    expect(loadComparisonHistory(storage).length).toBeLessThan(50);
  });
  it('does not remove anything when writing is denied', () => {
    const original = JSON.stringify({ version: 1, records: [record] });
    const denied = { getItem: () => original, setItem: () => { throw new Error('quota'); } };
    expect(() => removeComparisonResult('result-1', denied)).toThrow(/save/i);
    expect(denied.getItem()).toBe(original);
  });

  it('rejects inconsistent source identity and interval provenance', () => {
    const storage = memory();
    const samePath = { ...record, candidatePath: record.baselinePath };
    const badRange = { ...record, snapshot: { ...record.snapshot, baseline: { ...record.snapshot.baseline, requested: { start: 1200, end: 2000 }, effective: { start: 1200, end: 2000 } } } };
    expect(() => saveComparisonResult(samePath, storage)).toThrow();
    expect(() => saveComparisonResult(badRange, storage)).toThrow();
    expect(storage.raw()).toBeNull();
  });

});
