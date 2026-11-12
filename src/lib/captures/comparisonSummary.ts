import type { SavedLog } from '../serial/serial';
import type { CaptureRange } from './captureAnalysis';
import { comparisonDelta, type SignalStatistics } from './captureComparison';
import type { CheckEvaluation } from './comparisonChecks';

type SummarySide = { name: string; field: string; anchorMs: number; requested: CaptureRange; effective: CaptureRange; state: SavedLog['state']; timingMode: 'recorded' | 'approximate'; statistics: SignalStatistics };
export type ComparisonSummarySnapshot = { baseline: SummarySide; candidate: SummarySide; unit: string; startSeconds: number; endSeconds: number; evaluation: CheckEvaluation | null };

/** Quote every CSV cell. User-controlled text receives spreadsheet formula protection. */
export function comparisonCsvCell(value: unknown, userText = false): string {
  let text = String(value ?? '');
  if (userText && (/^[\t\r]/u.test(text) || /^[\s]*[=+\-@]/u.test(text))) text = `'${text}`;
  return `"${text.replace(/"/gu, '""')}"`;
}
export function comparisonSummaryCsv(snapshot: ComparisonSummarySnapshot): string {
  const { baseline: a, candidate: b } = snapshot;
  type Cell = { value: unknown; user?: boolean };
  const rows: Cell[][] = [];
  const row = (...values: unknown[]) => rows.push(values.map((value) => ({ value })));
  const userRow = (name: string, value: string) => rows.push([{ value: name }, { value, user: true }]);
  userRow('baseline', a.name); userRow('candidate', b.name); userRow('baseline_signal', a.field); userRow('candidate_signal', b.field);
  userRow('unit', snapshot.unit || 'unspecified');
  row('baseline_alignment', new Date(a.anchorMs).toISOString()); row('candidate_alignment', new Date(b.anchorMs).toISOString());
  row('interval_seconds', snapshot.startSeconds, snapshot.endSeconds); row('metric', 'baseline', 'candidate', 'candidate_minus_baseline', 'change_percent');
  row('readings', a.statistics.count, b.statistics.count);
  for (const [key, name] of [['min', 'Minimum'], ['max', 'Maximum'], ['mean', 'Mean'], ['deviation', 'Std. deviation']] as const) {
    const delta = comparisonDelta(a.statistics[key], b.statistics[key]);
    row(name, a.statistics[key], b.statistics[key], Number.isFinite(delta.absolute) ? delta.absolute : null, Number.isFinite(delta.percent) ? delta.percent : null);
  }
  if (snapshot.evaluation) {
    row('overall_outcome', snapshot.evaluation.status);
    row('check_metric', 'measure', 'operator', 'limit', 'observed', 'unit', 'outcome', 'reason');
    for (const result of snapshot.evaluation.results) {
      const unit = result.check.measure === 'percent' ? '%' : snapshot.unit || 'unspecified';
      rows.push([{ value: result.check.metric }, { value: result.check.measure }, { value: result.check.operator }, { value: result.check.limit }, { value: result.observed }, { value: unit, user: true }, { value: result.status }, { value: result.reasons.join('; '), user: true }]);
    }
    for (const [prefix, side] of [['baseline', a], ['candidate', b]] as const) {
      row(`${prefix}_requested_range_ms`, side.requested.start, side.requested.end); row(`${prefix}_effective_range_ms`, side.effective.start, side.effective.end);
      row(`${prefix}_capture_state`, side.state); row(`${prefix}_timing`, side.timingMode); row(`${prefix}_readings`, side.statistics.count); row(`${prefix}_skipped_units`, side.statistics.skippedUnits);
    }
    row('note', 'Pass applies only to recorded data. User text beginning with spreadsheet formula characters is prefixed with an apostrophe.');
  }
  return rows.map((cells) => cells.map(({ value, user }) => comparisonCsvCell(value, user)).join(',')).join('\n') + '\n';
}
