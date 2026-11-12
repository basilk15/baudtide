import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleHelp, Download, History, XCircle } from 'lucide-react';
import { comparisonHistoryCsv, type ComparisonHistoryRecord } from '../../lib/captures/comparisonHistory';
import { appendNativeTelemetryExport, beginNativeTelemetryExport, cancelNativeTelemetryExport, finishNativeTelemetryExport } from '../../lib/serial/serial';
import './comparison-history.css';

const number = (value: number | null) => value === null ? '—' : new Intl.NumberFormat(undefined, { maximumSignificantDigits: 17 }).format(value);
const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
const date = (value: string | number) => { const time = new Date(value); return dateFormat.formatToParts(time).map((part) => part.type === 'second' ? `${part.value}.${String(time.getMilliseconds()).padStart(3, '0')}` : part.value).join(''); };
const metrics = [['min', 'Minimum'], ['max', 'Maximum'], ['mean', 'Mean'], ['deviation', 'Std. deviation']] as const;
const names = { min: 'Minimum', max: 'Maximum', mean: 'Mean', deviation: 'Std. deviation' } as const;
const measures = { candidate: 'candidate', difference: 'difference', percent: 'change' } as const;

export function ComparisonHistory({ records, error, nativeEnabled, onRemove, onRetry }: {
  records: readonly ComparisonHistoryRecord[]; error: string; nativeEnabled: boolean; onRemove: (id: string) => boolean; onRetry: () => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [message, setMessage] = useState(''); const [exportError, setExportError] = useState('');
  const epoch = useRef(0); const exportLock = useRef(false); const headingRef = useRef<HTMLHeadingElement>(null); const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => () => { epoch.current += 1; }, []);
  const cancelRemoval = (id: string) => { setRemoving(null); requestAnimationFrame(() => removeButtons.current.get(id)?.focus()); };
  const exportRecord = async (record: ComparisonHistoryRecord) => {
    if (exportLock.current) return;
    exportLock.current = true; setExporting(record.id); setMessage(''); setExportError('');
    const current = epoch.current; let id: string | null = null;
    const ensureMounted = () => { if (current !== epoch.current) throw new Error('Export was interrupted.'); };
    try {
      id = await beginNativeTelemetryExport('csv', 'baudtide-saved-comparison.csv');
      if (!id) return;
      ensureMounted(); await appendNativeTelemetryExport(id, comparisonHistoryCsv(record)); ensureMounted();
      const path = await finishNativeTelemetryExport(id); id = null;
      if (current === epoch.current) setMessage(`Saved result exported to ${path}.`);
    } catch (reason) { if (current === epoch.current) setExportError(reason instanceof Error ? reason.message : 'Could not export this result.'); }
    finally { if (id) await cancelNativeTelemetryExport(id).catch(() => undefined); exportLock.current = false; if (current === epoch.current) setExporting(null); }
  };
  return <section className="bt-history" aria-labelledby="bt-history-title">
    <header className="bt-history-heading"><div><h4 ref={headingRef} tabIndex={-1} id="bt-history-title"><History size={16} aria-hidden="true" /> Saved results</h4><p>Historical snapshots saved on this computer. They do not recheck the captures.</p></div><span>{records.length} / 50</span></header>
    {error && <div className="bt-history-error" role="alert"><span>{error}</span><button type="button" className="sd-secondary-button" onClick={onRetry}>Retry</button></div>}
    {exportError && <p className="bt-tool-error" role="alert">{exportError}</p>}
    {message && <p className="bt-history-notice" role="status">{message}</p>}
    {records.length >= 50 && <p className="bt-history-empty">Result history is full. Remove a result to save another.</p>}
    {!error && !records.length && <p className="bt-history-empty">No saved results yet. Run a comparison with checks, then choose Save result.</p>}
    {records.length > 0 && <div className="bt-history-list">{records.map((record, index) => {
      const { snapshot } = record; const status = snapshot.evaluation?.status ?? 'inconclusive';
      const Icon = status === 'pass' ? CheckCircle2 : status === 'fail' ? XCircle : CircleHelp;
      return <details className="bt-history-entry" key={record.id}>
        <summary aria-label={`Saved result ${index + 1}: ${snapshot.baseline.name} to ${snapshot.candidate.name}, ${status}, ${date(record.savedAt)}`}><Icon className={`bt-history-icon is-${status}`} size={17} aria-hidden="true" /><span className="bt-history-row"><strong>{snapshot.baseline.name} <span aria-hidden="true">→</span> {snapshot.candidate.name}</strong><small>{snapshot.baseline.field}{snapshot.baseline.field !== snapshot.candidate.field ? ` → ${snapshot.candidate.field}` : ''} · <time dateTime={record.savedAt}>{date(record.savedAt)}</time></small></span><b>{status === 'pass' ? 'Pass' : status === 'fail' ? 'Fail' : 'Inconclusive'}</b></summary>
        <div className="bt-history-detail"><p className="bt-history-context">Historical result saved {date(record.savedAt)}. Values and outcomes reflect the recorded comparison at that time. Relative interval: {number(snapshot.startSeconds)} to {number(snapshot.endSeconds)} seconds.</p>
          <div className="bt-history-sources">{([['Baseline', snapshot.baseline, record.baselinePath], ['Candidate', snapshot.candidate, record.candidatePath]] as const).map(([label, source, path]) => <section key={label} aria-label={`${label} capture details`}><h5>{label} · {source.name}</h5><details className="bt-history-path"><summary>Capture path</summary><code>{path}</code></details><dl><div><dt>Signal</dt><dd>{source.field} · {snapshot.unit || 'no unit'}</dd></div><div><dt>Time zero</dt><dd>{date(source.anchorMs)}</dd></div><div><dt>Requested</dt><dd>{date(source.requested.start)} – {date(source.requested.end)}</dd></div><div><dt>Used</dt><dd>{date(source.effective.start)} – {date(source.effective.end)}</dd></div><div><dt>Capture</dt><dd>{source.state} · {source.timingMode} timing</dd></div><div><dt>Readings</dt><dd>{source.statistics.count.toLocaleString()} · {source.statistics.skippedUnits.toLocaleString()} different-unit excluded</dd></div></dl></section>)}</div>
          <div className="bt-history-table" role="region" tabIndex={0} aria-label={`Saved statistics for ${snapshot.baseline.name} and ${snapshot.candidate.name}`}><table><thead><tr><th scope="col">Metric</th><th scope="col">Baseline</th><th scope="col">Candidate</th></tr></thead><tbody>{metrics.map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{number(snapshot.baseline.statistics[key])}</td><td>{number(snapshot.candidate.statistics[key])}</td></tr>)}</tbody></table></div>
          <h5>Acceptance checks</h5><ul className="bt-history-checks">{snapshot.evaluation?.results.map((result) => <li key={result.check.id}><strong>{names[result.check.metric]} · {measures[result.check.measure]} {result.check.operator === 'lte' ? '≤' : '≥'} {number(result.check.limit)} {result.check.measure === 'percent' ? '%' : snapshot.unit || 'no unit'}</strong><span>Observed {result.observed !== null && result.observed > 0 && result.check.measure !== 'candidate' ? '+' : ''}{number(result.observed)} {result.check.measure === 'percent' ? '%' : snapshot.unit || 'no unit'} · {result.status === 'pass' ? 'Pass' : result.status === 'fail' ? 'Fail' : 'Inconclusive'}</span>{result.reasons.map((reason) => <small key={reason}>{reason}</small>)}</li>)}</ul>
          <div className="bt-history-actions"><button type="button" className="sd-secondary-button" aria-label={`Export saved result ${index + 1} as CSV`} disabled={!nativeEnabled || Boolean(exporting) || Boolean(removing)} onClick={() => void exportRecord(record)}><Download size={14} />{exporting === record.id ? 'Exporting…' : 'Export CSV'}</button><button ref={(element) => { if (element) removeButtons.current.set(record.id, element); else removeButtons.current.delete(record.id); }} type="button" className="sd-secondary-button" disabled={Boolean(exporting) || Boolean(removing)} aria-label={`Remove saved result ${index + 1}: ${snapshot.baseline.name} to ${snapshot.candidate.name}, ${date(record.savedAt)}`} onClick={() => setRemoving(record.id)}>Remove</button></div>
          {removing === record.id && <div className="bt-history-confirm" role="group" aria-label="Confirm result removal" onKeyDown={(event) => { if (event.key === 'Escape') cancelRemoval(record.id); }}><strong>Remove this saved result?</strong><span>Captures stay on this computer.</span><button autoFocus type="button" className="sd-secondary-button" onClick={() => { if (onRemove(record.id)) { setRemoving(null); requestAnimationFrame(() => headingRef.current?.focus()); } }}>Confirm removal</button><button type="button" className="sd-secondary-button" onClick={() => cancelRemoval(record.id)}>Cancel</button></div>}
        </div>
      </details>;
    })}</div>}
  </section>;
}
