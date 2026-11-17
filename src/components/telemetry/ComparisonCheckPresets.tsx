import { useId, useRef, useState } from 'react';
import { Bookmark, ChevronDown } from 'lucide-react';
import type { CheckBinding, ComparisonCheckSet } from '../../lib/captures/comparisonChecks';
import { ComparisonPresetReadError, instantiateComparisonPreset, loadComparisonPresets, removeComparisonPreset, saveComparisonPreset, type ComparisonCheckPreset } from '../../lib/captures/comparisonPresets';
import './comparison-presets.css';

const metrics = { min: 'Minimum', max: 'Maximum', mean: 'Mean', deviation: 'Std. deviation' };
const measures = { candidate: 'candidate', difference: 'difference', percent: 'change' };
const signalLabel = (binding: CheckBinding) => `${binding.baselineField} → ${binding.candidateField} · ${binding.unit || 'unspecified unit'}`;

export function ComparisonCheckPresets({ checkSet, binding, canSave, busy, onApply, onReviewChange }: {
  checkSet?: ComparisonCheckSet; binding: CheckBinding | null; canSave: boolean; busy: boolean;
  onApply: (next: ComparisonCheckSet) => void; onReviewChange: (reviewing: boolean) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<ComparisonCheckPreset[]>([]);
  const [unavailable, setUnavailable] = useState(true);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [review, setReview] = useState<{ preset: ComparisonCheckPreset; context: string } | null>(null);
  const context = JSON.stringify([binding, checkSet]);
  const stale = !!review && review.context !== context;
  const unitMismatch = !!review && !!binding && review.preset.checkSet.binding.unit !== binding.unit;
  const focusRow = (presetId?: string) => requestAnimationFrame(() => (presetId && rowButtons.current.get(presetId) || trigger.current)?.focus());
  const fail = (reason: unknown) => {
    setError(reason instanceof Error ? reason.message : 'Check presets could not be updated. Try again.');
    if (reason instanceof ComparisonPresetReadError) setUnavailable(true);
  };
  const reload = () => {
    try { setPresets(loadComparisonPresets()); setUnavailable(false); setError(''); }
    catch (reason) { fail(reason); }
  };
  const endReview = () => { if (review) { setReview(null); onReviewChange(false); } };
  const close = () => { endReview(); setRemoving(null); setOpen(false); trigger.current?.focus(); };
  const beginReview = (preset: ComparisonCheckPreset) => {
    setReview({ preset, context }); setRemoving(null); setError(''); setNotice(''); onReviewChange(true);
    requestAnimationFrame(() => { previewHeading.current?.focus({ preventScroll: true }); previewHeading.current?.scrollIntoView?.({ block: 'nearest' }); });
  };
  const apply = () => {
    if (!review || stale || unitMismatch || !binding || busy || unavailable) return;
    try {
      const latest = loadComparisonPresets(); setPresets(latest);
      if (JSON.stringify(latest.find(preset => preset.id === review.preset.id)) !== JSON.stringify(review.preset)) {
        setError('This preset changed or was removed. Review a saved preset again before applying.'); endReview(); focusRow(); return;
      }
      onApply(instantiateComparisonPreset(review.preset, binding));
      setNotice(`Applied “${review.preset.name}”. Run the comparison to evaluate these checks.`);
      focusRow(review.preset.id); endReview(); setError('');
    } catch (reason) { fail(reason); }
  };
  return <div className="bt-presets">
    <button ref={trigger} type="button" className="bt-presets-trigger sd-secondary-button" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => { if (open) close(); else { reload(); setOpen(true); setNotice(''); } }}><Bookmark size={14} aria-hidden="true" /> Presets <ChevronDown size={14} className={open ? 'is-open' : ''} aria-hidden="true" /></button>
    {open && <section id={`${id}-panel`} aria-label="Saved check presets" className="bt-presets-panel" onKeyDown={event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (removing) { focusRow(removing); setRemoving(null); }
      else if (review) { focusRow(review.preset.id); endReview(); }
      else close();
    }}>
      <div className="bt-presets-intro"><h5>Reusable checks</h5><span>{presets.length} / 24 saved locally</span></div>
      <p className="bt-presets-hint">Save limits once, then review and reuse them on another comparison.</p>
      <form className="bt-presets-save" onSubmit={event => {
        event.preventDefault(); if (!canSave || !checkSet || busy || review || removing || unavailable) return;
        try { setPresets(saveComparisonPreset(name, checkSet)); setName(''); setError(''); setNotice('Preset saved locally.'); }
        catch (reason) { fail(reason); }
      }}>
        <label htmlFor={`${id}-name`}>Preset name<input id={`${id}-name`} maxLength={48} value={name} placeholder="e.g. Calibration limits" disabled={busy || !!review || !!removing || unavailable} onChange={event => { setName(event.target.value); setError(''); }} /></label>
        <button type="submit" className="sd-secondary-button" disabled={!canSave || busy || !!review || !!removing || unavailable || !name.trim() || presets.length >= 24}>Save preset</button>
      </form>
      {!canSave && <p className="bt-presets-hint">Add checks bound to the selected signals to save a preset.</p>}
      {busy && <p className="bt-presets-hint">Finish the current edit or operation to use presets.</p>}
      {error && <p role="alert" className="bt-tool-error">{error} {unavailable && <button type="button" className="sd-secondary-button" onClick={reload}>Retry presets</button>}</p>}
      <p role="status" className="bt-presets-notice">{notice}</p>
      {!unavailable && presets.length === 0 && <p className="bt-presets-empty">No presets yet. Only check definitions are saved; recorded data stays in its capture.</p>}
      {!unavailable && <ul className="bt-presets-list">{presets.map(preset => <li key={preset.id}>
        <div className="bt-presets-row"><div><strong>{preset.name}</strong><span>{preset.checkSet.checks.length} {preset.checkSet.checks.length === 1 ? 'check' : 'checks'} · {preset.checkSet.binding.unit || 'unspecified unit'}</span></div><div className="bt-presets-actions">
          <button ref={element => { if (element) rowButtons.current.set(preset.id, element); else rowButtons.current.delete(preset.id); }} type="button" className="sd-secondary-button" aria-label={`Review preset ${preset.name}`} disabled={busy || !!review || !!removing} onClick={() => beginReview(preset)}>Review</button>
          <button type="button" className="sd-secondary-button" aria-label={`Remove preset ${preset.name}`} disabled={busy || !!review || !!removing} onClick={() => { setRemoving(preset.id); setError(''); setNotice(''); }}>Remove</button>
        </div></div>
        {removing === preset.id && <div className="bt-presets-confirm" role="group" aria-label={`Remove preset ${preset.name}?`}><p>Remove “{preset.name}” from this device? Current checks stay unchanged.</p><div className="bt-presets-actions"><button autoFocus type="button" className="sd-secondary-button" disabled={busy || unavailable} onClick={() => {
          try { setPresets(removeComparisonPreset(preset.id)); setRemoving(null); setNotice('Preset removed.'); setError(''); focusRow(); }
          catch (reason) { fail(reason); }
        }}>Confirm removal</button><button type="button" className="sd-secondary-button" onClick={() => { setRemoving(null); focusRow(preset.id); }}>Cancel removal</button></div></div>}
      </li>)}</ul>}
      {review && <div className="bt-presets-preview" aria-labelledby={`${id}-preview`}>
        <h5 id={`${id}-preview`} ref={previewHeading} tabIndex={-1}>Review “{review.preset.name}”</h5>
        <dl><div><dt>Saved signals</dt><dd>{signalLabel(review.preset.checkSet.binding)}</dd></div><div><dt>Apply to</dt><dd>{binding ? signalLabel(binding) : 'Select comparison signals first'}</dd></div></dl>
        <ul className="bt-presets-limits">{review.preset.checkSet.checks.map(check => <li key={check.id}>{metrics[check.metric]} · {measures[check.measure]} {check.operator === 'lte' ? '≤' : '≥'} <strong>{String(check.limit)}</strong> {check.measure === 'percent' ? '%' : review.preset.checkSet.binding.unit || '(unspecified unit)'}</li>)}</ul>
        <p>Applying replaces all current checks ({checkSet?.checks.length ?? 0}) with {review.preset.checkSet.checks.length} independent {review.preset.checkSet.checks.length === 1 ? 'check' : 'checks'}.</p>
        {binding && (binding.baselineField !== review.preset.checkSet.binding.baselineField || binding.candidateField !== review.preset.checkSet.binding.candidateField) && <p>Signal names differ. Verify that these limits describe the selected quantity.</p>}
        {binding?.unit === '' && !unitMismatch && <p>Both signals have unspecified units. Verify their quantity and scale before applying.</p>}
        {unitMismatch && <p role="alert" className="bt-tool-error">Units must match exactly. Numeric limits are not converted.</p>}
        {stale && <p role="alert" className="bt-tool-error">The selected signals or current checks changed. Cancel and review this preset again.</p>}
        <div className="bt-presets-actions"><button type="button" className="sd-primary-button" disabled={busy || unavailable || !binding || unitMismatch || stale} onClick={apply}>Apply preset</button><button type="button" className="sd-secondary-button" onClick={() => { focusRow(review.preset.id); endReview(); }}>Cancel preview</button></div>
      </div>}
    </section>}
  </div>;
}
