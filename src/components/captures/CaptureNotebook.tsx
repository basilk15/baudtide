import { useEffect, useId, useRef, useState } from 'react';
import { NotebookPen } from 'lucide-react';
import type { CaptureNotebook as Notebook } from '../../lib/captures/captureNotebook';
import './capture-workflows.css';
type Props = { name: string; value?: Notebook; disabled: boolean; onSave: (value: Notebook) => void };
export function CaptureNotebook({ name, value, disabled, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  const close = () => { setEditing(false); setError(''); trigger.current?.focus(); };
  return <div className="bt-capture-notebook">
    <button ref={trigger} className="bt-capture-tags-button" type="button" disabled={disabled} aria-label={`Edit notebook for ${name}`} aria-expanded={editing} aria-controls={editing ? id : undefined} onClick={() => {
      if (editing) close(); else { setTitle(value?.title ?? ''); setNotes(value?.notes ?? ''); setError(''); setEditing(true); }
    }}><NotebookPen size={15} aria-hidden="true" />{value?.notes || value?.title ? 'Edit notebook' : 'Add notebook'}</button>
    {!editing && value?.notes && <p className="bt-notebook-excerpt">{value.notes}</p>}
    {editing && <form id={id} className="bt-library-form" aria-label={`Notebook for ${name}`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }} onSubmit={event => {
      event.preventDefault(); if (disabled) return;
      try { onSave({title, notes}); close(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Notebook could not be saved.'); }
    }}>
      <label>Experiment title<input ref={input} value={title} maxLength={80} disabled={disabled} onChange={event => setTitle(event.target.value)} placeholder={name} /></label>
      <label>Experiment notes<textarea value={notes} maxLength={4000} rows={4} disabled={disabled} onChange={event => setNotes(event.target.value)} placeholder="Firmware version, test conditions, and what you learned…" /></label>
      <p>Saved locally. Notebook titles and notes are excluded from capture bundles.</p>
      {error && <p role="alert">{error}</p>}
      <div><button className="sd-primary-button" type="submit" disabled={disabled}>Save notebook</button><button className="sd-secondary-button" type="button" onClick={close}>Cancel</button></div>
    </form>}
  </div>;
}
