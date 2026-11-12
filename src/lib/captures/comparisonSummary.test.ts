import { describe, expect, it } from 'vitest';
import { comparisonSummaryCsv, type ComparisonSummarySnapshot } from './comparisonSummary';
const stat = { count: 2, min: 10, max: 30, mean: 20, deviation: 10, skippedUnits: 0 };
const snapshot: ComparisonSummarySnapshot = {
  baseline: { name: '=unsafe', field: 'temp,"board"', anchorMs: 0, requested: { start: 0, end: 1000 }, effective: { start: 0, end: 1000 }, state: 'saved', timingMode: 'recorded', statistics: stat },
  candidate: { name: 'candidate\nrun', field: 'temp', anchorMs: 0, requested: { start: 0, end: 1000 }, effective: { start: 0, end: 1000 }, state: 'saved', timingMode: 'recorded', statistics: { ...stat, mean: 24 } },
  unit: 'C', startSeconds: 0, endSeconds: 1,
  evaluation: { status: 'fail', results: [{ check: { id: 'c', metric: 'mean', measure: 'percent', operator: 'lte', limit: 10 }, observed: 20, status: 'fail', reasons: [] }] },
};
describe('comparison summary CSV', () => {
  it('escapes spreadsheet formulas and CSV content while preserving numeric results and provenance', () => {
    const csv = comparisonSummaryCsv(snapshot);
    expect(csv).toContain('"baseline","\'=unsafe"');
    expect(csv).toContain('"temp,""board"""');
    expect(csv).toContain('"candidate\nrun"');
    expect(csv).toContain('"overall_outcome","fail"');
    expect(csv).toContain('"mean","percent","lte","10","20","%","fail"');
    expect(csv).toContain('"baseline_capture_state","saved"');
    expect(csv).toContain('"baseline_effective_range_ms","0","1000"');
  });
  it('does not append check rows when no checks are present', () => {
    expect(comparisonSummaryCsv({ ...snapshot, evaluation: null })).not.toContain('overall_outcome');
  });
});
