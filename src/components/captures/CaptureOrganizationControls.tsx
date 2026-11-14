import { useEffect, useId, useRef, useState } from 'react';
import { Star, Tags } from 'lucide-react';
import './capture-organization.css';

type Props = { name: string; favorite: boolean; tags: readonly string[]; disabled: boolean; editing: boolean; onEditingChange: (editing: boolean) => void; onFavorite: () => void; onTags: (text: string) => void };
export function CaptureOrganizationControls({ name, favorite, tags, disabled, editing, onEditingChange: setEditing, onFavorite, onTags }: Props) {
  const [draft, setDraft] = useState(() => tags.join(', ')); const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null); const trigger = useRef<HTMLButtonElement>(null); const id = useId();
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  const close = () => { setEditing(false); setError(''); trigger.current?.focus(); };
  return <div className="bt-capture-organize">
    <button type="button" className="bt-capture-favorite" aria-label={`${favorite ? 'Unfavorite' : 'Favorite'} ${name}`} aria-pressed={favorite} title={favorite ? 'Remove from favorites' : 'Add to favorites'} disabled={disabled} onClick={onFavorite}><Star size={16} fill={favorite ? 'currentColor' : 'none'} /></button>
    <div className="bt-capture-tag-list" aria-label={`Tags for ${name}`}>{tags.map(tag => <span key={tag}>{tag}</span>)}</div>
    <button type="button" ref={trigger} className="bt-capture-tags-button" aria-label={`Edit tags for ${name}`} aria-expanded={editing} disabled={disabled} onClick={() => { if (editing) close(); else { setDraft(tags.join(', ')); setError(''); setEditing(true); } }}><Tags size={15} />Tags</button>
    {editing && <form className="bt-capture-tag-editor" aria-label={`Edit tags for ${name}`} onSubmit={event => { event.preventDefault(); if (disabled) return; try { onTags(draft); close(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Tags could not be saved. Try again.'); } }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <label htmlFor={id}>Capture tags</label><input ref={input} id={id} value={draft} maxLength={2000} disabled={disabled} onChange={event => setDraft(event.target.value)} aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} aria-invalid={!!error} placeholder="baseline, firmware v2, bench a" />
      <p id={`${id}-help`}>Separate tags with commas. Up to 8 tags, 24 characters each; saved in lowercase. Local to this installation, excluded from bundles.</p>
      {error && <p className="bt-capture-tag-error" id={`${id}-error`} role="alert">{error}</p>}
      <div><button className="sd-primary-button" type="submit" disabled={disabled}>Save tags</button><button className="sd-secondary-button" type="button" onClick={close}>Cancel</button></div>
    </form>}
  </div>;
}
