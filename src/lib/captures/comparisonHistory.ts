import { evaluateChecks, normalizeCheckSet, type CheckEvaluation, type CheckResult } from './comparisonChecks';
import type { SignalStatistics } from './captureComparison';
import { comparisonCsvCell, comparisonSummaryCsv, type ComparisonSummarySnapshot } from './comparisonSummary';

export type ComparisonHistoryRecord = { id: string; savedAt: string; baselinePath: string; candidatePath: string; snapshot: ComparisonSummarySnapshot };
export type ComparisonHistoryStorage = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'baudtide.comparison-results.v1';
const MAX_BYTES = 512 * 1024;
const MAX_RESULTS = 50;
const damaged = 'Saved results could not be read. Existing history is preserved; restore its local storage before making changes.';
const obj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && (empty || v.length > 0) && v.length <= max && !v.includes('\0');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const range = (v: unknown): boolean => obj(v) && finite(v.start) && finite(v.end) && Math.abs(v.start) <= 8.64e15 && Math.abs(v.end) <= 8.64e15;
function statistics(value: unknown): value is SignalStatistics {
  if (!obj(value) || !Number.isSafeInteger(value.count) || (value.count as number) < 0 || !Number.isSafeInteger(value.skippedUnits) || (value.skippedUnits as number) < 0) return false;
  const values = [value.min, value.max, value.mean, value.deviation];
  if (value.count === 0) return values.every((v) => v === null);
  return values.every(finite) && (value.min as number) <= (value.max as number) && (value.deviation as number) >= 0;
}
function side(value: unknown): boolean {
  return obj(value) && text(value.name, 200) && text(value.field, 256) && finite(value.anchorMs) && Math.abs(value.anchorMs) <= 8.64e15
    && range(value.requested) && range(value.effective) && typeof value.state === 'string'
    && ['capturing', 'disconnected', 'error', 'quota-reached', 'interrupted', 'saved', 'unknown'].includes(value.state)
    && (value.timingMode === 'recorded' || value.timingMode === 'approximate') && statistics(value.statistics);
}
function validEvaluation(value: unknown, snapshot: ComparisonSummarySnapshot): value is CheckEvaluation {
  if (!obj(value) || !Array.isArray(value.results) || !value.results.length || value.results.length > 8) return false;
  const parsed = normalizeCheckSet({ binding: { baselineField: snapshot.baseline.field, candidateField: snapshot.candidate.field, unit: snapshot.unit }, checks: value.results.map((result: unknown) => obj(result) ? result.check : null) });
  if (!parsed) return false;
  const results: CheckResult[] = [];
  for (let i = 0; i < value.results.length; i++) {
    const result: unknown = value.results[i];
    if (!obj(result) || !Array.isArray(result.reasons) || result.reasons.length > 16 || result.reasons.some((reason: unknown) => !text(reason, 400))
      || !(result.observed === null || finite(result.observed)) || typeof result.status !== 'string' || !['pass', 'fail', 'inconclusive'].includes(result.status)) return false;
    const derived = evaluateChecks([parsed.checks[i]], snapshot.baseline.statistics, snapshot.candidate.statistics, result.reasons as string[]).results[0];
    if (derived.observed !== result.observed || derived.status !== result.status || (derived.observed === null && result.reasons.length === 0)) return false;
    results.push(result as CheckResult);
  }
  const incomplete = [snapshot.baseline, snapshot.candidate].some((source) => !['saved', 'disconnected'].includes(source.state)
    || source.timingMode === 'approximate' || !source.statistics.count || source.statistics.skippedUnits > 0
    || source.requested.start !== source.effective.start || source.requested.end !== source.effective.end);
  if (incomplete && results.some((result) => result.status !== 'inconclusive')) return false;
  const overall = results.some((result) => result.status === 'fail') ? 'fail' : results.some((result) => result.status === 'inconclusive') ? 'inconclusive' : 'pass';
  return value.status === overall;
}
function validRecord(value: unknown): value is ComparisonHistoryRecord {
  if (!obj(value) || !text(value.id, 160) || !text(value.savedAt, 40) || !Number.isFinite(Date.parse(value.savedAt))
    || !text(value.baselinePath, 8192) || !text(value.candidatePath, 8192) || value.baselinePath === value.candidatePath || !obj(value.snapshot)) return false;
  const s = value.snapshot;
  if (!side(s.baseline) || !side(s.candidate) || !text(s.unit, 64, true) || !finite(s.startSeconds) || !finite(s.endSeconds)
    || s.startSeconds >= s.endSeconds || Math.max(Math.abs(s.startSeconds), Math.abs(s.endSeconds)) > 1e9) return false;
  const snapshot = s as ComparisonSummarySnapshot;
  for (const source of [snapshot.baseline, snapshot.candidate]) {
    if (source.requested.start !== source.anchorMs + snapshot.startSeconds * 1000 || source.requested.end !== source.anchorMs + snapshot.endSeconds * 1000) return false;
    if (source.effective.start <= source.effective.end && (source.effective.start < source.requested.start || source.effective.end > source.requested.end)) return false;
  }
  return validEvaluation(s.evaluation, snapshot);
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function read(storage: ComparisonHistoryStorage): ComparisonHistoryRecord[] {
  let raw: string | null;
  try { raw = storage.getItem(KEY); } catch { throw new Error('Local storage is unavailable. Check storage access and try again.'); }
  if (raw === null) return [];
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new Error(damaged);
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Error(damaged); }
  if (!obj(data) || data.version !== 1 || !Array.isArray(data.records) || data.records.length > MAX_RESULTS || !data.records.every(validRecord)
    || new Set(data.records.map((record: ComparisonHistoryRecord) => record.id)).size !== data.records.length) throw new Error(damaged);
  return data.records as ComparisonHistoryRecord[];
}
function write(records: ComparisonHistoryRecord[], storage: ComparisonHistoryStorage) {
  const contents = JSON.stringify({ version: 1, records });
  if (new TextEncoder().encode(contents).byteLength > MAX_BYTES) throw new Error('Saved results are full. Remove a result before saving another.');
  try { storage.setItem(KEY, contents); } catch { throw new Error('Could not save results locally. Check storage access and free space, then retry.'); }
}
export function loadComparisonHistory(storage: ComparisonHistoryStorage = localStorage): ComparisonHistoryRecord[] { return read(storage); }
export function saveComparisonResult(record: ComparisonHistoryRecord, storage: ComparisonHistoryStorage = localStorage): ComparisonHistoryRecord[] {
  const records = read(storage);
  if (!validRecord(record)) throw new Error('This result cannot be saved because its measurements or checks are invalid.');
  if (records.length >= MAX_RESULTS) throw new Error('Saved results are full. Remove a result before saving another.');
  if (records.some((item) => item.id === record.id)) throw new Error('This result was already saved.');
  const next = [clone(record), ...records]; write(next, storage); return next;
}
export function removeComparisonResult(id: string, storage: ComparisonHistoryStorage = localStorage): ComparisonHistoryRecord[] {
  const records = read(storage);
  if (!records.some((record) => record.id === id)) throw new Error('That saved result is no longer available.');
  const next = records.filter((record) => record.id !== id); write(next, storage); return next;
}

/** Include identifying context while retaining the original saved summary. */
export function comparisonHistoryCsv(record: ComparisonHistoryRecord): string {
  const rows: Array<[string, string, boolean]> = [['saved_at', record.savedAt, true], ['baseline_path', record.baselinePath, true], ['candidate_path', record.candidatePath, true]];
  return rows.map(([key, value, user]) => `${comparisonCsvCell(key)},${comparisonCsvCell(value, user)}\n`).join('') + comparisonSummaryCsv(record.snapshot);
}
