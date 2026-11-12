import { describe, expect, it } from 'vitest';
import { comparisonQualityReasons, evaluateChecks, normalizeCheckSet, overlappingRecordedInterval } from './comparisonChecks';
import type { SignalStatistics } from './captureComparison';

const stats = (mean: number | null, count = 1): SignalStatistics => ({ count, min: mean, max: mean, mean, deviation: mean === null ? null : 0, skippedUnits: 0 });
const check = { id: 'mean', metric: 'mean' as const, measure: 'percent' as const, operator: 'lte' as const, limit: 10 };
const set = { binding: { baselineField: 'temp', candidateField: 'temp', unit: 'C' }, checks: [check] };
const side = { requested: { start: 0, end: 1000 }, selection: { start: 0, end: 1000 }, indexed: { start: 0, end: 1000 }, timingMode: 'recorded' as const, gaps: [], droppedOverlongLineCount: 0, captureState: 'saved' as const, statistics: stats(20) };

describe('comparison acceptance checks', () => {
  it('rejects malformed or excessive stored rules without losing valid ones', () => {
    expect(normalizeCheckSet(set)).toEqual(set);
    for (const value of [{ ...set, checks: [] }, { ...set, checks: Array(9).fill(check) }, { ...set, checks: [check, check] }, { ...set, checks: [{ ...check, limit: Infinity }] }, { ...set, checks: [{ ...check, operator: ['lte'] }] }, { ...set, checks: [{ ...check, measure: ['percent'] }] }, { ...set, binding: { ...set.binding, unit: '\0' } }]) expect(normalizeCheckSet(value)).toBeNull();
  });
  it('evaluates inclusive limits and signed changes without rounding', () => {
    expect(evaluateChecks([{ ...check, measure: 'candidate', limit: 24 }], stats(20), stats(24), []).status).toBe('pass');
    expect(evaluateChecks([check], stats(20), stats(24), []).results[0]).toMatchObject({ status: 'fail', observed: 20 });
    expect(evaluateChecks([check], stats(-10), stats(-5), []).results[0].observed).toBe(50);
    expect(evaluateChecks([{ ...check, operator: 'gte', limit: 20 }], stats(20), stats(24), []).status).toBe('pass');
    expect(evaluateChecks([], stats(20), stats(24), []).status).toBe('none');
  });
  it('makes undefined or unreliable measurements inconclusive', () => {
    expect(evaluateChecks([check], stats(0), stats(10), []).status).toBe('inconclusive');
    expect(evaluateChecks([{ ...check, measure: 'difference' }], stats(-Number.MAX_VALUE), stats(Number.MAX_VALUE), []).status).toBe('inconclusive');
    expect(evaluateChecks([check], stats(20), stats(24), ['Baseline timing is approximate']).status).toBe('inconclusive');
    expect(evaluateChecks([check, { ...check, id: 'zero', measure: 'percent' }], stats(20), stats(24), []).status).toBe('fail');
  });
  it('finds clipped, incomplete, active and unreliable evidence for each side', () => {
    expect(comparisonQualityReasons({ baseline: side, candidate: side })).toEqual([]);
    for (const patch of [
      { indexed: { start: 0, end: 999 } }, { selection: { start: 1, end: 1000 } },
      { timingMode: 'approximate' as const }, { captureState: 'capturing' as const }, { captureState: 'interrupted' as const },
      { droppedOverlongLineCount: 1 }, { statistics: stats(null, 0) }, { statistics: { ...stats(20), skippedUnits: 1 } },
      { gaps: [{ id: 'x', type: 'reconnect' as const, timestamp: new Date(500).toISOString(), previousNativeSessionId: 'a', nextNativeSessionId: 'b', nextSequence: 1 }] },
      { gaps: [{ id: 'x', type: 'reconnect' as const, timestamp: 'invalid', previousNativeSessionId: 'a', nextNativeSessionId: 'b', nextSequence: 1 }] },
    ]) expect(comparisonQualityReasons({ baseline: { ...side, ...patch }, candidate: side }).join(' ')).toContain('Baseline');
    expect(comparisonQualityReasons({ baseline: { ...side, captureState: 'disconnected' }, candidate: side })).toEqual([]);
  });
  it('proposes only the positive common interval in each run’s relative time', () => {
    expect(overlappingRecordedInterval({ selection: { start: 1000, end: 61000 }, indexed: { start: 1000, end: 60800 }, anchorMs: 1000 }, { selection: { start: 3000, end: 63000 }, indexed: { start: 3000, end: 63000 }, anchorMs: 4000 })).toEqual({ startSeconds: 0, endSeconds: 59 });
    expect(overlappingRecordedInterval({ selection: { start: 0, end: 1 }, indexed: { start: 0, end: 1 }, anchorMs: 0 }, { selection: { start: 2, end: 3 }, indexed: { start: 2, end: 3 }, anchorMs: 0 })).toBeNull();
  });
});
