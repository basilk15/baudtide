import type { CaptureAnalysisIndex, CaptureRange } from './captureAnalysis';
import type { TelemetryField, TelemetrySample } from '../telemetry/telemetry';

export type CaptureComparisonSettings = {
  baselinePath: string; candidatePath: string; baselineField: string; candidateField: string;
  baselineEvent: string; candidateEvent: string; startSeconds: number; endSeconds: number;
};
export function normalizeCaptureComparison(value: unknown): CaptureComparisonSettings | null {
  const v = value as CaptureComparisonSettings | null;
  if (!v || ['baselinePath', 'candidatePath', 'baselineField', 'candidateField', 'baselineEvent', 'candidateEvent'].some((key) =>
    typeof v[key as keyof CaptureComparisonSettings] !== 'string' || String(v[key as keyof CaptureComparisonSettings]).length > 8192
      || String(v[key as keyof CaptureComparisonSettings]).includes('\0'))
    || !Number.isFinite(v.startSeconds) || !Number.isFinite(v.endSeconds) || v.startSeconds >= v.endSeconds
    || Math.abs(v.startSeconds) > 1e9 || Math.abs(v.endSeconds) > 1e9) return null;
  return { baselinePath: v.baselinePath, candidatePath: v.candidatePath, baselineField: v.baselineField, candidateField: v.candidateField,
    baselineEvent: v.baselineEvent, candidateEvent: v.candidateEvent, startSeconds: v.startSeconds, endSeconds: v.endSeconds };
}
export type SignalStatistics = { count: number; min: number | null; max: number | null; mean: number | null; deviation: number | null; skippedUnits: number };
export function compatibleComparisonFields(a: TelemetryField, b: TelemetryField) { return (a.unit ?? '') === (b.unit ?? ''); }

/** Statistics use every recorded reading, independently of the decimated chart. */
export async function signalStatistics(samples: AsyncIterable<TelemetrySample>, field: TelemetryField, signal?: AbortSignal): Promise<SignalStatistics> {
  let count = 0; let min = Infinity; let max = -Infinity; let mean = 0; let m2 = 0; let skippedUnits = 0;
  for await (const sample of samples) {
    signal?.throwIfAborted();
    const reading = sample.values[field.key];
    if (!reading || !Number.isFinite(reading.value)) continue;
    if ((reading.unit ?? field.unit ?? '') !== (field.unit ?? '')) { skippedUnits++; continue; }
    const value = reading.value;
    count++; min = Math.min(min, value); max = Math.max(max, value);
    const delta = value - mean; mean += delta / count; m2 += delta * (value - mean);
  }
  return { count, min: count ? min : null, max: count ? max : null, mean: count ? mean : null,
    deviation: count ? Math.sqrt(Math.max(0, m2 / count)) : null, skippedUnits };
}
export async function compareCaptureSignal(index: CaptureAnalysisIndex, field: TelemetryField, anchorMs: number,
  startSeconds: number, endSeconds: number, selection: CaptureRange, signal: AbortSignal) {
  if (![anchorMs, startSeconds, endSeconds].every(Number.isFinite) || endSeconds <= startSeconds) throw new Error('Choose an interval with an end after its start.');
  const range = { start: Math.max(selection.start, anchorMs + startSeconds * 1000), end: Math.min(selection.end, anchorMs + endSeconds * 1000) };
  const statistics = await signalStatistics(index.samples(range, signal), field, signal);
  signal.throwIfAborted();
  const { snapshot } = await index.query(range, [field.key], signal);
  return { statistics, samples: snapshot.samples, range };
}
export function comparisonDelta(baseline: number | null, candidate: number | null) {
  if (baseline === null || candidate === null) return { absolute: null, percent: null };
  return { absolute: candidate - baseline, percent: baseline === 0 ? null : (candidate - baseline) / Math.abs(baseline) * 100 };
}
