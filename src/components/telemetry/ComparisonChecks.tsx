import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, Plus, XCircle } from 'lucide-react';
import type { CheckBinding, CheckEvaluation, CheckMeasure, CheckMetric, ComparisonCheck, ComparisonCheckSet } from '../../lib/captures/comparisonChecks';
import { ThemedSelect } from '../ui/ThemedSelect';
import './comparison-checks.css';

const metricNames: Record<CheckMetric, string> = { min: 'Minimum', max: 'Maximum', mean: 'Mean', deviation: 'Std. deviation' };
const measureNames: Record<CheckMeasure, string> = { candidate: 'candidate', difference: 'difference', percent: 'change' };
const format = (n: number, precision = 6) => new Intl.NumberFormat(undefined, { maximumSignificantDigits: precision }).format(n);
function displayPrecision(limit: number, observed: number | null | undefined) {
  if (observed === null || observed === undefined || observed === limit) return 6;
  let digits = 6;
  while (digits < 17 && Number(limit.toPrecision(digits)) === Number(observed.toPrecision(digits))) digits++;
  return digits;
}
export const checkBindingsMatch = (a: CheckBinding | undefined, b: CheckBinding | null) => Boolean(a && b && a.baselineField === b.baselineField && a.candidateField === b.candidateField && a.unit === b.unit);

type Draft = Omit<ComparisonCheck, 'limit'> & { limit: string };
export function ComparisonChecks({ checkSet, binding, evaluation, busy, onChange, onDraftChange }: {
  checkSet?: ComparisonCheckSet; binding: CheckBinding | null; evaluation: CheckEvaluation | null; busy: boolean;
  onChange: (next: ComparisonCheckSet | undefined) => void; onDraftChange: (editing: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null); const [error, setError] = useState(''); const [confirmRebind, setConfirmRebind] = useState(false); const [removing, setRemoving] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null); const limitRef = useRef<HTMLInputElement>(null); const draftBinding = useRef<CheckBinding | null>(null); const rowEdits = useRef(new Map<string, HTMLButtonElement>());
  const matches = !checkSet || checkBindingsMatch(checkSet.binding, binding);
  useEffect(() => { if (draft) limitRef.current?.focus(); }, [draft?.id]);
  const focusRow = (id?: string) => requestAnimationFrame(() => { const target = (id && rowEdits.current.get(id)) || (!addRef.current?.disabled && addRef.current) || rowEdits.current.values().next().value; target?.focus(); });
  const finish = (id?: string) => { const target = id ?? draft?.id; setDraft(null); setError(''); onDraftChange(false); focusRow(target); };
  const edit = (check?: ComparisonCheck) => {
    setConfirmRebind(false); setError(''); draftBinding.current = binding ? { ...binding } : null;
    setDraft(check ? { ...check, limit: String(check.limit) } : { id: crypto.randomUUID(), metric: 'mean', measure: 'candidate', operator: 'lte', limit: '' }); onDraftChange(true);
  };
  const save = () => {
    if (!draft || !binding || !checkBindingsMatch(draftBinding.current ?? undefined, binding)) { setError('The selected signal changed. Cancel this edit and review the checks.'); return; }
    const limit = draft.limit.trim() ? Number(draft.limit) : NaN;
    if (!Number.isFinite(limit)) { setError('Enter a finite numeric limit.'); limitRef.current?.focus(); return; }
    const check: ComparisonCheck = { ...draft, limit };
    const previous = checkSet?.checks ?? [];
    const checks = previous.some((item) => item.id === check.id) ? previous.map((item) => item.id === check.id ? check : item) : [...previous, check];
    onChange({ binding: checkSet?.binding ?? binding, checks }); finish(check.id);
  };
  const remove = (id: string) => {
    if (!checkSet) return;
    const checks = checkSet.checks.filter((item) => item.id !== id);
    onChange(checks.length ? { ...checkSet, checks } : undefined); setRemoving(null); onDraftChange(false); focusRow(checks[0]?.id);
  };
  const unit = (measure: CheckMeasure) => measure === 'percent' ? '%' : (checkSet?.binding.unit ?? binding?.unit) || 'no unit';
  return <section className="bt-checks" aria-labelledby="bt-checks-title">
    <div className="bt-checks-heading"><div><h4 id="bt-checks-title">Acceptance checks</h4><p>Set optional limits for this comparison. Results apply to recorded data.</p></div><button ref={addRef} type="button" className="sd-secondary-button" disabled={busy || !!draft || !!removing || !binding || !matches || (checkSet?.checks.length ?? 0) >= 8} onClick={() => edit()}><Plus size={14} /> Add check</button></div>
    {!checkSet && !draft && <p className="bt-checks-empty">No checks configured. Add a limit to assess this comparison.</p>}
    {checkSet && !matches && <div className="bt-checks-warning"><AlertTriangle size={16} /><div><strong>Checks suspended</strong><p>The selected signals or units differ from the saved checks. Rebind them before evaluating.</p>{binding && !confirmRebind && <button type="button" className="sd-secondary-button" disabled={busy || !!draft} onClick={() => setConfirmRebind(true)}>Rebind checks</button>}{confirmRebind && binding && <div><p>Change unit from {checkSet.binding.unit || 'unspecified'} to {binding.unit || 'unspecified'}? Numeric limits remain unchanged and are not converted.</p><button autoFocus type="button" className="sd-secondary-button" onClick={() => { onChange({ ...checkSet, binding }); setConfirmRebind(false); }}>Confirm rebind</button> <button type="button" className="sd-secondary-button" onClick={() => setConfirmRebind(false)}>Cancel</button></div>}</div></div>}
    {checkSet && <><div className="bt-checks-overall" aria-live="polite"><strong>{evaluation ? ({ pass: 'Pass', fail: 'Fail', inconclusive: 'Inconclusive', none: 'No checks configured' })[evaluation.status] : matches ? 'Run comparison to evaluate' : 'Evaluation suspended'}</strong><span>{checkSet.checks.length} / 8 checks</span></div><ul className="bt-checks-list">{checkSet.checks.map((check, index) => {
      const result = evaluation?.results.find((item) => item.check.id === check.id);
      const precision = displayPrecision(check.limit, result?.observed);
      const Icon = result?.status === 'pass' ? CheckCircle2 : result?.status === 'fail' ? XCircle : CircleHelp;
      return <li key={check.id}><Icon size={17} className={`bt-checks-icon is-${result?.status ?? 'pending'}`} aria-hidden="true" /><div className="bt-checks-detail"><strong>{metricNames[check.metric]} · {measureNames[check.measure]} {check.operator === 'lte' ? '≤' : '≥'} {format(check.limit, 17)} {unit(check.measure)}</strong><span title={result?.observed === null || result?.observed === undefined ? undefined : String(result.observed)}>{result ? `Observed ${result.observed === null ? 'unavailable' : `${result.observed > 0 && check.measure !== 'candidate' ? '+' : ''}${format(result.observed, precision)} ${unit(check.measure)}`} · ${result.status === 'pass' ? 'Pass' : result.status === 'fail' ? 'Fail' : 'Inconclusive'}` : 'Not evaluated'}</span>{result?.reasons.map((reason) => <small key={reason}>{reason}</small>)}</div><div className="bt-checks-actions"><button ref={(element) => { if (element) rowEdits.current.set(check.id, element); else rowEdits.current.delete(check.id); }} type="button" className="sd-secondary-button" disabled={busy || !!draft || !!removing || !binding} aria-label={`Edit ${metricNames[check.metric]} check ${index + 1}`} onClick={() => edit(check)}>Edit</button><button type="button" className="sd-secondary-button" disabled={busy || !!draft || !!removing} aria-label={`Remove ${metricNames[check.metric]} check ${index + 1}`} onClick={() => { setRemoving(check.id); onDraftChange(true); }}>Remove</button></div>{removing === check.id && <div className="bt-checks-confirm" role="group" aria-label="Confirm removal"><strong>Remove this check?</strong><button autoFocus type="button" className="sd-secondary-button" onClick={() => remove(check.id)}>Confirm removal</button><button type="button" className="sd-secondary-button" onClick={() => { setRemoving(null); onDraftChange(false); focusRow(check.id); }}>Cancel removal</button></div>}</li>;
    })}</ul>{checkSet.checks.length >= 8 && <p className="bt-checks-empty">Up to eight checks can be added.</p>}</>}
    {draft && <div className="bt-checks-editor" role="group" aria-label="Edit acceptance check"><div className="bt-checks-fields"><label><span>Metric</span><ThemedSelect placeholder="Choose metric" label="Check metric" value={draft.metric} options={Object.entries(metricNames).map(([value, label]) => ({ value, label }))} onChange={(v) => setDraft({ ...draft, metric: v as CheckMetric })} /></label><label><span>Measure</span><ThemedSelect placeholder="Choose measure" label="Check measure" value={draft.measure} options={[{ value: 'candidate', label: 'Candidate value' }, { value: 'difference', label: 'Difference' }, { value: 'percent', label: 'Percent change' }]} onChange={(v) => setDraft({ ...draft, measure: v as CheckMeasure })} /></label><label><span>Limit type</span><ThemedSelect placeholder="Choose limit type" label="Check limit type" value={draft.operator} options={[{ value: 'lte', label: 'At most (≤)' }, { value: 'gte', label: 'At least (≥)' }]} onChange={(v) => setDraft({ ...draft, operator: v as 'lte' | 'gte' })} /></label><label><span>Limit · {unit(draft.measure)}</span><input ref={limitRef} aria-label="Limit" aria-invalid={Boolean(error)} aria-describedby={error ? 'bt-check-limit-error' : undefined} type="number" step="any" value={draft.limit} onChange={(event) => { setDraft({ ...draft, limit: event.target.value }); setError(''); }} onKeyDown={(event) => { if (event.key === 'Escape') finish(); }} /></label></div>{error && <p id="bt-check-limit-error" role="alert" className="bt-tool-error">{error}</p>}<div className="bt-checks-editor-actions"><button type="button" className="sd-primary-button" onClick={save} disabled={busy}>Save check</button><button type="button" className="sd-secondary-button" onClick={() => finish()}>Cancel</button></div></div>}
  </section>;
}
