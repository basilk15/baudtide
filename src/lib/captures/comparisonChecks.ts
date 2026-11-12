import type { SavedLog } from '../serial/serial';
import type { TelemetryGap } from '../telemetry/telemetry';
import type { CaptureRange } from './captureAnalysis';
import { comparisonDelta, type SignalStatistics } from './captureComparison';

export type CheckMetric = 'min' | 'max' | 'mean' | 'deviation';
export type CheckMeasure = 'candidate' | 'difference' | 'percent';
export type ComparisonCheck = { id: string; metric: CheckMetric; measure: CheckMeasure; operator: 'lte' | 'gte'; limit: number };
export type CheckBinding = { baselineField: string; candidateField: string; unit: string };
export type ComparisonCheckSet = { binding: CheckBinding; checks: ComparisonCheck[] };
export type CheckResult = { check: ComparisonCheck; status: 'pass' | 'fail' | 'inconclusive'; observed: number | null; reasons: string[] };
export type CheckEvaluation = { status: 'none' | 'pass' | 'fail' | 'inconclusive'; results: CheckResult[] };

type EvidenceSide = { requested: CaptureRange; selection: CaptureRange; indexed: CaptureRange; timingMode: 'recorded' | 'approximate'; gaps: readonly TelemetryGap[]; droppedOverlongLineCount: number; captureState: SavedLog['state']; statistics: SignalStatistics };
export type ComparisonQualityInput = { baseline: EvidenceSide; candidate: EvidenceSide };
const validText = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && (empty || v.length > 0) && v.length <= max && !v.includes('\0');

export function normalizeCheckSet(value: unknown): ComparisonCheckSet | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!v.binding || typeof v.binding !== 'object' || !Array.isArray(v.checks) || !v.checks.length || v.checks.length > 8) return null;
  const b = v.binding as Record<string, unknown>;
  if (!validText(b.baselineField, 256) || !validText(b.candidateField, 256) || !validText(b.unit, 64, true)) return null;
  const checks: ComparisonCheck[] = [];
  for (const item of v.checks) {
    if (!item || typeof item !== 'object') return null;
    const c = item as Record<string, unknown>;
    if (!validText(c.id, 160) || checks.some((prior) => prior.id === c.id) || typeof c.metric !== 'string' || !['min', 'max', 'mean', 'deviation'].includes(c.metric) || typeof c.measure !== 'string' || !['candidate', 'difference', 'percent'].includes(c.measure) || typeof c.operator !== 'string' || !['lte', 'gte'].includes(c.operator) || typeof c.limit !== 'number' || !Number.isFinite(c.limit)) return null;
    checks.push({ id: c.id, metric: c.metric as CheckMetric, measure: c.measure as CheckMeasure, operator: c.operator as 'lte' | 'gte', limit: c.limit });
  }
  return { binding: { baselineField: b.baselineField, candidateField: b.candidateField, unit: b.unit }, checks };
}

export function evaluateChecks(checks: readonly ComparisonCheck[], baseline: SignalStatistics, candidate: SignalStatistics, qualityReasons: readonly string[]): CheckEvaluation {
  const results: CheckResult[] = checks.map((check) => {
    const delta = comparisonDelta(baseline[check.metric], candidate[check.metric]);
    const raw = check.measure === 'candidate' ? candidate[check.metric] : check.measure === 'difference' ? delta.absolute : delta.percent;
    const observed = raw !== null && Number.isFinite(raw) ? raw : null;
    const reasons = [...qualityReasons];
    if (observed === null) reasons.push(check.measure === 'percent' && baseline[check.metric] === 0 ? 'Percent change is unavailable when the baseline is zero.' : 'The requested measurement is unavailable.');
    return { check, observed, reasons, status: reasons.length ? 'inconclusive' : (check.operator === 'lte' ? observed! <= check.limit : observed! >= check.limit) ? 'pass' : 'fail' };
  });
  const status = !results.length ? 'none' : results.some((r) => r.status === 'fail') ? 'fail' : results.some((r) => r.status === 'inconclusive') ? 'inconclusive' : 'pass';
  return { status, results };
}

export function comparisonQualityReasons(input: ComparisonQualityInput): string[] {
  const reasons: string[] = [];
  for (const [label, s] of [['Baseline', input.baseline], ['Candidate', input.candidate]] as const) {
    const start = Math.max(s.selection.start, s.indexed.start); const end = Math.min(s.selection.end, s.indexed.end);
    if (![start, end, s.requested.start, s.requested.end].every(Number.isFinite) || end < start || s.requested.start < start || s.requested.end > end || s.requested.end < s.requested.start) reasons.push(`${label} interval extends beyond recorded readings. Shorten the interval or record longer.`);
    if (!s.statistics.count) reasons.push(`${label} has no matching readings.`);
    if (s.statistics.skippedUnits) reasons.push(`${label} excluded readings with different units.`);
    if (s.timingMode === 'approximate') reasons.push(`${label} receive timing is approximate.`);
    if (s.droppedOverlongLineCount) reasons.push(`${label} discarded overlong lines.`);
    if (!['saved', 'disconnected'].includes(s.captureState)) reasons.push(`${label} capture state is ${s.captureState}; use a complete saved capture.`);
    if (s.gaps.some((gap) => { const time = Date.parse(gap.timestamp); return !Number.isFinite(time) || (time >= s.requested.start && time <= s.requested.end); })) reasons.push(`${label} has a known or undated reconnect gap.`);
  }
  return reasons;
}

export function overlappingRecordedInterval(baseline: { selection: CaptureRange; indexed: CaptureRange; anchorMs: number }, candidate: { selection: CaptureRange; indexed: CaptureRange; anchorMs: number }): { startSeconds: number; endSeconds: number } | null {
  const start = Math.max(baseline.selection.start - baseline.anchorMs, baseline.indexed.start - baseline.anchorMs, candidate.selection.start - candidate.anchorMs, candidate.indexed.start - candidate.anchorMs);
  const end = Math.min(baseline.selection.end - baseline.anchorMs, baseline.indexed.end - baseline.anchorMs, candidate.selection.end - candidate.anchorMs, candidate.indexed.end - candidate.anchorMs);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { startSeconds: start / 1000, endSeconds: end / 1000 } : null;
}
