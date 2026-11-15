import { comparisonDelta } from './captureComparison';
import type { ComparisonSummarySnapshot } from './comparisonSummary';

export type ComparisonReportOptions = {
  kind: 'current' | 'saved';
  savedAt?: string;
  paths?: { baseline: string; candidate: string };
  includePaths?: boolean;
  qualityReasons?: readonly string[];
};

/** Literal table/list text: no new blocks, HTML, links, mentions or table separators. */
function literal(value: string) {
  const escaped = value.replace(/[\r\n\t]/gu, ' ').replace(/[\x00-\x1f\x7f]/gu, '').replace(/[&<>\\`*_{}\[\]()#!|~@:]/gu, char =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : `&#${char.charCodeAt(0)};`);
  return escaped.replace(/^ +/u, spaces => '&#32;'.repeat(spaces.length))
    .replace(/^[-+]/u, char => `&#${char.charCodeAt(0)};`).replace(/^(\d+)\.(?=\s|$)/u, '$1&#46;');
}
const number = (value: number | null) => value !== null && Number.isFinite(value) ? String(value) : 'Unavailable';
const signed = (value: number | null) => value !== null && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value}` : 'Unavailable';
const date = (value: number | string) => Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : 'Unavailable';
const range = (value: { start: number; end: number }) => value.end < value.start ? 'No overlapping readings' : `${date(value.start)} — ${date(value.end)}`;
const metrics = [['min', 'Minimum'], ['max', 'Maximum'], ['mean', 'Mean'], ['deviation', 'Std. deviation']] as const;
const metricNames = { min: 'Minimum', max: 'Maximum', mean: 'Mean', deviation: 'Std. deviation' };
const outcomes = { none: 'Not checked', pass: 'Pass', fail: 'Fail', inconclusive: 'Inconclusive' };

export function comparisonReportMarkdown(snapshot: ComparisonSummarySnapshot, options: ComparisonReportOptions): string {
  const { baseline, candidate, evaluation } = snapshot;
  const unit = literal(snapshot.unit || 'Unspecified');
  const lines = ['# BaudTide comparison report', '', `- Outcome: **${outcomes[evaluation?.status ?? 'none']}**`,
    `- Source: ${options.kind === 'saved' ? 'Historical snapshot' : 'Current comparison'}`];
  if (options.kind === 'saved' && options.savedAt) lines.push(`- Saved at: ${date(options.savedAt)}`);
  lines.push(`- Relative interval: ${number(snapshot.startSeconds)} to ${number(snapshot.endSeconds)} seconds`, `- Signal unit: ${unit}`, '', '## Captures', '', '| Context | Baseline | Candidate |', '| --- | --- | --- |');
  const sourceRow = (label: string, a: string, b: string) => lines.push(`| ${label} | ${a} | ${b} |`);
  sourceRow('Name', literal(baseline.name), literal(candidate.name));
  sourceRow('Signal', literal(baseline.field), literal(candidate.field));
  sourceRow('Capture state', literal(baseline.state ?? 'unknown'), literal(candidate.state ?? 'unknown'));
  sourceRow('Receive timing', baseline.timingMode, candidate.timingMode);
  sourceRow('Time zero (UTC)', date(baseline.anchorMs), date(candidate.anchorMs));
  sourceRow('Requested interval (UTC)', range(baseline.requested), range(candidate.requested));
  sourceRow('Used interval (UTC)', range(baseline.effective), range(candidate.effective));
  sourceRow('Readings', number(baseline.statistics.count), number(candidate.statistics.count));
  sourceRow('Different-unit readings excluded', number(baseline.statistics.skippedUnits), number(candidate.statistics.skippedUnits));
  if (options.includePaths && options.paths) sourceRow('Local capture path', literal(options.paths.baseline), literal(options.paths.candidate));
  lines.push('', '## Measurements', '', '| Metric | Baseline | Candidate | Difference | Change |', '| --- | --- | --- | --- | --- |');
  for (const [key, label] of metrics) {
    const delta = comparisonDelta(baseline.statistics[key], candidate.statistics[key]);
    const percent = delta.percent !== null && Number.isFinite(delta.percent) ? `${signed(delta.percent)}%` : 'Unavailable';
    lines.push(`| ${label} | ${number(baseline.statistics[key])} | ${number(candidate.statistics[key])} | ${signed(delta.absolute)} | ${percent} |`);
  }
  lines.push('', '## Acceptance checks', '');
  if (evaluation?.results.length) {
    lines.push('| Metric | Measure | Requirement | Observed | Outcome |', '| --- | --- | --- | --- | --- |');
    for (const result of evaluation.results) {
      const measure = { candidate: 'Candidate', difference: 'Difference', percent: 'Change' }[result.check.measure];
      const checkUnit = result.check.measure === 'percent' ? '%' : unit;
      lines.push(`| ${metricNames[result.check.metric]} | ${measure} | ${result.check.operator === 'lte' ? '≤' : '≥'} ${number(result.check.limit)} ${checkUnit} | ${number(result.observed)} ${checkUnit} | ${outcomes[result.status]} |`);
    }
  } else lines.push('No acceptance checks were configured for this comparison.');
  const reasons = [...(options.qualityReasons ?? []), ...(evaluation?.results.flatMap(result => result.reasons) ?? [])];
  for (const [label, source] of [['Baseline', baseline], ['Candidate', candidate]] as const) {
    if (source.timingMode === 'approximate') reasons.push(`${label} receive timing is approximate.`);
    if (!source.statistics.count) reasons.push(`${label} has no matching readings.`);
    if (source.statistics.skippedUnits) reasons.push(`${label} excluded readings with different units.`);
    if (!['saved', 'disconnected'].includes(source.state ?? 'unknown')) reasons.push(`${label} capture state is ${source.state ?? 'unknown'}; use a complete saved capture.`);
    if (source.requested.start !== source.effective.start || source.requested.end !== source.effective.end) reasons.push(`${label} requested and used intervals differ.`);
  }
  if (reasons.length) lines.push('', '## Evidence notes', '', ...[...new Set(reasons)].map(reason => `- ${literal(reason)}`));
  lines.push('', '## Interpretation', '', 'Values describe recorded data in the selected interval. Differences are candidate minus baseline. Units are not converted. Statistics use the sample mean and population standard deviation.',
    '', 'A pass applies only to the recorded data; it is not a guarantee of device behavior.');
  if (options.kind === 'saved') lines.push('', 'This historical snapshot was retained locally. Captures were not reopened or rechecked when creating this report.');
  lines.push('', 'No raw serial output or capture files are included. Capture names, signal labels and evidence notes remain included; review them before sharing.',
    '', options.includePaths && options.paths ? 'Local capture path fields are included by explicit choice.' : 'Local capture path fields are omitted.', '');
  return lines.join('\n');
}
