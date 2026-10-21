import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRightLeft, Download, GitCompareArrows, LoaderCircle } from 'lucide-react';
import type { CaptureAnalysisIndex, CaptureRange } from '../../lib/captures/captureAnalysis';
import type { CaptureEvent } from '../../lib/captures/captureEvents';
import type { TelemetryField, TelemetryGap, TelemetrySample } from '../../lib/telemetry/telemetry';
import { compareCaptureSignal, compatibleComparisonFields, comparisonDelta, type CaptureComparisonSettings } from '../../lib/captures/captureComparison';
import { appendNativeTelemetryExport, beginNativeTelemetryExport, cancelNativeTelemetryExport, finishNativeTelemetryExport } from '../../lib/serial/serial';
import { TelemetryCharts } from './TelemetryECharts';
import { ThemedSelect } from '../ui/ThemedSelect';
import '../../styles/bench-workflows.css';

export type ComparisonSource = { path: string; name: string; index: CaptureAnalysisIndex; selection: CaptureRange; fields: readonly TelemetryField[]; gaps: readonly TelemetryGap[] };
type Reading = Awaited<ReturnType<typeof compareCaptureSignal>>;
type Result = { key: string; baseline: Reading; candidate: Reading; baselineAnchor: number; candidateAnchor: number; unit?: string };
const EPOCH = Date.UTC(2000, 0, 1);
const defaults: CaptureComparisonSettings = { baselinePath: '', candidatePath: '', baselineField: '', candidateField: '', baselineEvent: '', candidateEvent: '', startSeconds: 0, endSeconds: 60 };
const number = (value: number | null) => value === null ? '—' : new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(value);
const signed = (value: number | null) => value === null ? '—' : `${value > 0 ? '+' : ''}${number(value)}`;

export function CaptureComparisonPanel({ sources, captures, onLoadCapture, events, settings, onChange, visible, busy, nativeEnabled }: {
  sources: ComparisonSource[]; events: readonly CaptureEvent[]; settings?: CaptureComparisonSettings;
  captures?: readonly Pick<ComparisonSource, 'path' | 'name'>[];
  onLoadCapture?: (path: string) => Promise<ComparisonSource>;
  onChange: (settings: CaptureComparisonSettings) => void; visible: boolean; busy: boolean; nativeEnabled: boolean;
}) {
  const config = settings ?? defaults;
  const [open, setOpen] = useState(false);
  const baseline = sources.find((s) => s.path === config.baselinePath);
  const candidate = sources.find((s) => s.path === config.candidatePath);
  const baselineField = baseline?.fields.find((field) => field.key === config.baselineField);
  const candidateField = candidate?.fields.find((field) => field.key === config.candidateField);
  const [start, setStart] = useState(String(config.startSeconds));
  const [end, setEnd] = useState(String(config.endSeconds));
  const [result, setResult] = useState<Result | null>(null);
  const [working, setWorking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadingCapture, setLoadingCapture] = useState(false);
  const captureRequest = useRef(0);
  const selectingCapture = useRef(false);
  const currentConfig = useRef(config); currentConfig.current = config;
  const operation = useRef<AbortController | null>(null);
  const exportingRef = useRef(false);
  useEffect(() => { setStart(String(config.startSeconds)); setEnd(String(config.endSeconds)); }, [config.startSeconds, config.endSeconds]);
  const key = JSON.stringify([config, start, end, baseline?.index.id, baseline?.selection, candidate?.index.id, candidate?.selection]);
  useEffect(() => { operation.current?.abort(); setWorking(false); setError(''); }, [key]);
  useEffect(() => { if (busy) operation.current?.abort(); }, [busy]);
  useEffect(() => () => { operation.current?.abort(); captureRequest.current += 1; }, []);
  const update = (patch: Partial<CaptureComparisonSettings>) => { onChange({ ...currentConfig.current, ...patch }); setNotice(''); };
  const selectSource = async (path: string, side: 'baseline' | 'candidate') => {
    if (selectingCapture.current) return;
    selectingCapture.current = true;
    const request = ++captureRequest.current;
    setLoadingCapture(true); setError('');
    try {
      const source = sources.find((s) => s.path === path) ?? await onLoadCapture?.(path);
      if (request !== captureRequest.current) return;
      if (!source) throw new Error('This capture could not be opened. Choose it again to retry.');
      const otherField = side === 'baseline' ? candidateField : baselineField;
      const field = source.fields.find((f) => f.key === otherField?.key && compatibleComparisonFields(f, otherField))
        ?? source.fields.find((f) => !otherField || compatibleComparisonFields(f, otherField));
      update(side === 'baseline' ? { baselinePath: path, baselineField: field?.key ?? '', baselineEvent: '' }
        : { candidatePath: path, candidateField: field?.key ?? '', candidateEvent: '' });
    } catch (e) { if (request === captureRequest.current) setError(e instanceof Error ? e.message : 'Could not open the capture. Choose it again to retry.'); }
    finally { if (request === captureRequest.current) { selectingCapture.current = false; setLoadingCapture(false); } }
  };
  const anchor = (source: ComparisonSource, eventId: string) => {
    if (!eventId) return source.index.range.start;
    const event = events.find((e) => e.id === eventId && e.capturePath === source.path);
    if (!event) throw new Error('The selected alignment event is unavailable. Load older events or choose another alignment point.');
    return Date.parse(event.timestamp);
  };
  const run = async () => {
    if (working || exporting || busy) return;
    setError(''); setNotice('');
    if (!baseline || !candidate || baseline.path === candidate.path || !baselineField || !candidateField) { setError('Choose two different saved captures and a signal from each.'); return; }
    if (!compatibleComparisonFields(baselineField, candidateField)) { setError('Choose signals with the same unit. Unit conversion is not applied.'); return; }
    const from = start.trim() ? Number(start) : NaN; const to = end.trim() ? Number(end) : NaN;
    if (![from, to].every(Number.isFinite) || to <= from || Math.max(Math.abs(from), Math.abs(to)) > 1e9) { setError('Enter a finite interval with its end after its start. Negative seconds include time before the event.'); return; }
    const abort = new AbortController(); operation.current?.abort(); operation.current = abort; setWorking(true);
    try {
      const a = anchor(baseline, config.baselineEvent); const b = anchor(candidate, config.candidateEvent);
      const [left, right] = await Promise.all([
        compareCaptureSignal(baseline.index, baselineField, a, from, to, baseline.selection, abort.signal),
        compareCaptureSignal(candidate.index, candidateField, b, from, to, candidate.selection, abort.signal),
      ]);
      abort.signal.throwIfAborted();
      setResult({ key, baseline: left, candidate: right, baselineAnchor: a, candidateAnchor: b, unit: baselineField.unit });
    } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'Could not compare the captures.'); }
    finally { if (operation.current === abort) setWorking(false); }
  };
  const current = result?.key === key ? result : null;
  const plot = useMemo(() => {
    if (!current || !baselineField || !candidateField) return { samples: [], fields: [], gaps: [] };
    const samples: TelemetrySample[] = []; const gaps: TelemetryGap[] = [];
    for (const [side, field, source, time] of [
      ['Baseline', baselineField, baseline!, current.baselineAnchor], ['Candidate', candidateField, candidate!, current.candidateAnchor],
    ] as const) {
      const value = side === 'Baseline' ? current.baseline : current.candidate;
      for (const sample of value.samples) {
        const reading = sample.values[field.key];
        if (reading && (reading.unit ?? field.unit ?? '') === (field.unit ?? '')) samples.push({ ...sample, id: `${side}:${sample.id}`,
          timestamp: new Date(EPOCH + Date.parse(sample.timestamp) - time).toISOString(), values: { [side]: reading } });
      }
      for (const gap of source.gaps) gaps.push({ ...gap, id: `${side}:${gap.id}`, fieldKeys: [side], timestamp: new Date(EPOCH + Date.parse(gap.timestamp) - time).toISOString() });
    }
    return { samples: samples.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)), gaps,
      fields: [{ ...baselineField, key: 'Baseline' }, { ...candidateField, key: 'Candidate' }] };
  }, [current, baselineField, candidateField, baseline, candidate]);
  const metrics = current ? (['min', 'max', 'mean', 'deviation'] as const).map((metric) => ({
    name: ({ min: 'Minimum', max: 'Maximum', mean: 'Mean', deviation: 'Std. deviation' })[metric],
    baseline: current.baseline.statistics[metric], candidate: current.candidate.statistics[metric],
    delta: comparisonDelta(current.baseline.statistics[metric], current.candidate.statistics[metric]),
  })) : [];
  const exportSummary = async () => {
    if (!current || exportingRef.current) return;
    exportingRef.current = true; setExporting(true); setError('');
    let id: string | null = null;
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    try {
      id = await beginNativeTelemetryExport('csv', 'baudtide-run-comparison.csv');
      if (!id) return;
      const rows: unknown[][] = [['baseline', baseline?.name], ['candidate', candidate?.name], ['baseline_signal', baselineField?.key], ['candidate_signal', candidateField?.key],
        ['unit', current.unit ?? 'unspecified'], ['baseline_alignment', new Date(current.baselineAnchor).toISOString()], ['candidate_alignment', new Date(current.candidateAnchor).toISOString()],
        ['interval_seconds', start, end], ['metric', 'baseline', 'candidate', 'candidate_minus_baseline', 'change_percent'],
        ['readings', current.baseline.statistics.count, current.candidate.statistics.count], ...metrics.map((m) => [m.name, m.baseline, m.candidate, m.delta.absolute, m.delta.percent])];
      await appendNativeTelemetryExport(id, rows.map((row) => row.map(cell).join(',')).join('\n') + '\n');
      const path = await finishNativeTelemetryExport(id); id = null; setNotice(`Comparison saved to ${path}.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not export comparison.'); }
    finally { if (id) await cancelNativeTelemetryExport(id).catch(() => undefined); exportingRef.current = false; setExporting(false); }
  };
  const sourceOptions = [...new Map([...sources, ...(captures ?? [])].map((source) => [source.path, { value: source.path, label: source.name }])).values()];
  const disabled = busy || working || exporting || loadingCapture;
  const commitInterval = () => {
    const from = start.trim() ? Number(start) : NaN; const to = end.trim() ? Number(end) : NaN;
    if ([from, to].every(Number.isFinite) && from < to && Math.max(Math.abs(from), Math.abs(to)) <= 1e9)
      update({ startSeconds: from, endSeconds: to });
  };
  return <details className="bt-comparison" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><GitCompareArrows size={17} /><span>Compare test runs</span><small>Baseline → candidate</small></summary>
    <div className="bt-comparison-body">
      <header className="bt-tool-heading"><div><h3>Measure the change</h3><p>Compare original readings over the same relative interval. Statistics include every recorded sample in the selected capture ranges.</p></div></header>
      {sourceOptions.length < 2 ? <p className="bt-comparison-guidance">{sourceOptions.length === 0 ? 'No saved captures yet.' : 'One saved capture available.'} Record and disconnect two sessions to compare their signals here.</p>
        : <p className="bt-comparison-guidance">Choose any two captures from your library. Each capture opens automatically when selected.</p>}
      {loadingCapture && <p className="bt-comparison-loading" role="status"><LoaderCircle className="sd-spin" size={15} /> Opening capture…</p>}
      <div className="bt-comparison-pair">
        {(['baseline', 'candidate'] as const).map((side) => {
          const source = side === 'baseline' ? baseline : candidate;
          const field = side === 'baseline' ? baselineField : candidateField;
          const other = side === 'baseline' ? candidateField : baselineField;
          const eventId = side === 'baseline' ? config.baselineEvent : config.candidateEvent;
          return <section key={side} className={`bt-comparison-source is-${side}`}><h4><i aria-hidden="true" />{side === 'baseline' ? 'Baseline' : 'Candidate'}</h4>
            <label>Saved capture<ThemedSelect label={`${side} capture`} value={source?.path ?? (side === 'baseline' ? config.baselinePath : config.candidatePath)} options={sourceOptions} placeholder={sourceOptions.length ? 'Choose a capture' : 'No saved captures'} disabled={disabled || !sourceOptions.length} onChange={(path) => void selectSource(path, side)} /></label>
            <label>Signal<ThemedSelect label={`${side} signal`} value={field?.key ?? ''} options={(source?.fields ?? []).map((f) => ({ value: f.key, label: `${f.key}${f.unit ? ` · ${f.unit}` : ' · no unit'}` }))} placeholder="Choose a signal" disabled={disabled || !source} onChange={(key) => update(side === 'baseline' ? { baselineField: key } : { candidateField: key })} /></label>
            {field && other && !compatibleComparisonFields(field, other) && <p className="bt-tool-warning">Units differ. Choose a compatible signal.</p>}
            <label>Time zero<ThemedSelect label={`${side} alignment event`} value={eventId} options={[{ value: '', label: 'First telemetry reading' }, ...events.filter((e) => e.capturePath === source?.path).map((e) => ({ value: e.id, label: `${e.label} · ${new Date(e.timestamp).toLocaleTimeString()}` }))]} placeholder={eventId ? 'Event unavailable · choose again' : 'First telemetry reading'} disabled={disabled || !source} onChange={(id) => update(side === 'baseline' ? { baselineEvent: id } : { candidateEvent: id })} /></label>
          </section>;
        })}
        <div className="bt-comparison-connector" aria-hidden="true"><ArrowRightLeft size={18} /></div>
      </div>
      <form className="bt-comparison-window" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <label>From time zero (seconds)<input type="number" step="any" value={start} onChange={(e) => setStart(e.target.value)} onBlur={commitInterval} disabled={disabled} /></label>
        <label>To time zero (seconds)<input type="number" step="any" value={end} onChange={(e) => setEnd(e.target.value)} onBlur={commitInterval} disabled={disabled} /></label>
        <button type="submit" className="sd-primary-button" disabled={disabled || sources.length < 2}>{working ? <LoaderCircle className="sd-spin" size={15} /> : <GitCompareArrows size={15} />}{working ? 'Comparing…' : 'Compare interval'}</button>
        {working && <button type="button" className="sd-secondary-button" onClick={() => { operation.current?.abort(); setWorking(false); }}>Cancel</button>}
      </form>
      <p className="bt-tool-footnote">Negative seconds include time before the chosen event. Each run uses its selected capture range. Differences are candidate minus baseline; units are not converted.</p>
      {(baseline?.index.timingMode === 'approximate' || candidate?.index.timingMode === 'approximate') && <p className="bt-tool-warning">A selected capture has approximate receive timing. Event alignment and interval boundaries are estimates.</p>}
      {error && <p className="bt-tool-error" role="alert">{error}</p>}
      {current && <div className="bt-comparison-result">
        <div className="bt-comparison-result-heading"><strong>{baselineField?.key} {baselineField?.key !== candidateField?.key ? `→ ${candidateField?.key}` : ''}<span>{current.unit || 'No unit specified'}</span></strong>
          <button type="button" className="sd-secondary-button" disabled={disabled || !nativeEnabled} onClick={() => void exportSummary()}><Download size={14} />{exporting ? 'Saving…' : 'Save summary'}</button></div>
        <div className="bt-comparison-table" role="region" tabIndex={0} aria-label="Comparison statistics"><table><caption>All recorded readings in the interval · sample mean and population standard deviation</caption><thead><tr><th scope="col">Metric</th><th scope="col">Baseline</th><th scope="col">Candidate</th><th scope="col">Difference</th><th scope="col">Change</th></tr></thead><tbody>
          <tr><th scope="row">Readings</th><td>{current.baseline.statistics.count.toLocaleString()}</td><td>{current.candidate.statistics.count.toLocaleString()}</td><td>—</td><td>—</td></tr>
          {metrics.map((m) => <tr key={m.name}><th scope="row">{m.name}</th><td>{number(m.baseline)}</td><td>{number(m.candidate)}</td><td>{signed(m.delta.absolute)}</td><td>{m.delta.percent === null ? '—' : `${signed(m.delta.percent)}%`}</td></tr>)}
        </tbody></table></div>
        {(!current.baseline.statistics.count || !current.candidate.statistics.count) && <p className="bt-tool-warning">One run has no matching readings in this interval. Adjust the range, signal, or alignment point.</p>}
        {current.baseline.statistics.skippedUnits + current.candidate.statistics.skippedUnits > 0 && <p className="bt-tool-warning">Readings with a different unit were excluded.</p>}
        <TelemetryCharts samples={plot.samples} fields={plot.fields} gaps={plot.gaps} selectedFieldKeys={['Baseline', 'Candidate']} windowMs={0} paused mode="compare" absoluteOverlay visible={visible && open}
          timeline={{ kind: 'elapsed', originMs: EPOCH, signed: true }} markers={[{ id: 'zero', kind: 'note', label: 'Time zero', timestampMs: EPOCH }]} />
        <p className="bt-tool-footnote">Chart uses a bounded overview; statistics use the full sample history. Percent change is unavailable when the baseline is zero. Lower or higher values are not automatically classified as better.</p>
      </div>}
      {notice && <p className="bt-tool-footnote" role="status">{notice}</p>}
    </div>
  </details>;
}
