import { describe, expect, it } from 'vitest';
import { comparisonReportMarkdown } from './comparisonReport';
import type { ComparisonSummarySnapshot } from './comparisonSummary';

const statistics = { count: 3, min: 10, max: 30, mean: 20, deviation: 8.16496580927726, skippedUnits: 0 };
const side = { name: 'Baseline', field: 'temperature', anchorMs: 1000, requested: { start: 0, end: 3000 }, effective: { start: 0, end: 3000 }, state: 'saved' as const, timingMode: 'recorded' as const, statistics };
const snapshot: ComparisonSummarySnapshot = { baseline: side, candidate: { ...side, name: 'Candidate', statistics: { ...statistics, min: 12, max: 36, mean: 24 } }, unit: 'C', startSeconds: -1, endSeconds: 2,
  evaluation: { status: 'fail', results: [{ check: { id: 'mean', metric: 'mean', measure: 'percent', operator: 'lte', limit: 10 }, observed: 20, status: 'fail', reasons: [] }] } };
describe('Markdown comparison reports', () => {
  it('retains full precision, signed differences, check definitions and UTC provenance', () => {
    const report = comparisonReportMarkdown(snapshot, { kind: 'current' });
    expect(report).toContain('# BaudTide comparison report');
    expect(report).toContain('**Fail**');
    expect(report).toContain('- Relative interval: -1 to 2 seconds');
    expect(report).toContain('1970-01-01T00:00:01.000Z');
    expect(report).toContain('| Mean | 20 | 24 | +4 | +20% |');
    expect(report).toContain('8.16496580927726');
    expect(report).toContain('| Mean | Change | ≤ 10 % | 20 % | Fail |');
    expect(report).toContain('population standard deviation');
    expect(report).not.toContain('Historical snapshot');
    expect(comparisonReportMarkdown(snapshot, { kind: 'current' })).toBe(report);
  });
  it('uses retained history and omits path fields unless explicitly included', () => {
    const options = { kind: 'saved' as const, savedAt: '2026-11-15T04:00:00.000Z', paths: { baseline: '/private/baseline.log', candidate: '/private/candidate.log' } };
    const report = comparisonReportMarkdown(snapshot, options);
    expect(report).toContain('Historical snapshot'); expect(report).toContain(options.savedAt);
    expect(report).not.toContain('/private/'); expect(report).toContain('not reopened or rechecked');
    const included = comparisonReportMarkdown(snapshot, { ...options, includePaths: true });
    expect(included).toContain('/private/baseline.log'); expect(included).toContain('/private/candidate.log');
  });
  it('keeps no-check and uncertain evidence distinct and deduplicates reasons', () => {
    const uncertain = { ...snapshot, baseline: { ...side, timingMode: 'approximate' as const }, evaluation: { status: 'inconclusive' as const, results: [{ ...snapshot.evaluation!.results[0], status: 'inconclusive' as const, observed: null, reasons: ['A gap was found.', 'A gap was found.'] }] } };
    const report = comparisonReportMarkdown(uncertain, { kind: 'current', qualityReasons: ['A gap was found.'] });
    expect(report).toContain('**Inconclusive**'); expect(report).toContain('approximate'); expect(report).toContain('Unavailable');
    expect(report.match(/A gap was found\./g)).toHaveLength(1);
    const unchecked = comparisonReportMarkdown({ ...uncertain, evaluation: null }, { kind: 'current', qualityReasons: ['A gap was found.'] });
    expect(unchecked).toContain('**Not checked**'); expect(unchecked).toContain('No acceptance checks'); expect(unchecked).toContain('A gap was found.');
  });
  it('does not invent zero-baseline percentages or missing readings', () => {
    expect(comparisonReportMarkdown({ ...snapshot, baseline: { ...side, statistics: { ...statistics, mean: 0 } } }, { kind:'current' })).toContain('| Mean | 0 | 24 | +24 | Unavailable |');
    const report = comparisonReportMarkdown({ ...snapshot, baseline: { ...side, statistics: { ...statistics, mean: 0 } }, candidate: { ...side, effective:{ start:2000, end:1000 }, statistics: { count: 0, min: null, max: null, mean: null, deviation: null, skippedUnits: 2 } }, evaluation: null }, { kind: 'current' });
    expect(report).toContain('| Mean | 0 | Unavailable | Unavailable | Unavailable |');
    expect(report).not.toMatch(/NaN|Infinity/); expect(report).toContain('different units');
    expect(report).toContain('No overlapping readings');
  });
  it('renders untrusted labels, reasons and optional paths as literal text', () => {
    const payload = '<img src=x onerror=alert(1)>|[link](https://evil.example)\n# injected @person `code`';
    const report = comparisonReportMarkdown({ ...snapshot, baseline: { ...side, name: payload, field: 'temp|<script>' }, evaluation: { ...snapshot.evaluation!, results: [{ ...snapshot.evaluation!.results[0], reasons: [payload] }] } }, { kind: 'saved', paths: { baseline: payload, candidate: '/ok' }, includePaths: true });
    expect(report).not.toContain('<img'); expect(report).not.toContain('<script>'); expect(report).not.toContain('[link]'); expect(report).not.toContain('@person'); expect(report).not.toContain('\n# injected');
    expect(report).toContain('&#124;'); expect(report).toContain('&lt;img');
  });
  it('keeps leading list markers, thematic rules and indentation literal in evidence notes', () => {
    const report = comparisonReportMarkdown(snapshot, { kind:'current', qualityReasons:['- nested','+ nested','1. nested','2) nested','---','    indented evidence'] });
    expect(report).toContain('- &#45; nested');expect(report).toContain('- &#43; nested');
    expect(report).toContain('- 1&#46; nested');expect(report).toContain('- 2&#41; nested');
    expect(report).toContain('- &#45;--');expect(report).toContain('- &#32;&#32;&#32;&#32;indented evidence');
  });
});
