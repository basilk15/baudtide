import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Bookmark, X } from 'lucide-react';
import { captureViewMatches, CaptureViewsReadError, loadCaptureViews, removeCaptureView, saveCaptureView, type CaptureView, type CaptureViewFilters } from '../../lib/captures/captureViews';
import './capture-views.css';

type Props = { filters: CaptureViewFilters; onApply: (filters: CaptureViewFilters) => void; filtersUnavailable?: boolean; children?: ReactNode };
const states = { all: 'All captures', active: 'Active', completed: 'Completed', attention: 'Needs attention' };
const sorts = { newest: 'Newest first', oldest: 'Oldest first', largest: 'Largest first', name: 'Name A–Z' };

function describe(filters: CaptureViewFilters) {
  const query = filters.query.length > 80 ? `${filters.query.slice(0, 80)}…` : filters.query;
  return [states[filters.state], filters.favoritesOnly && 'Favorites', filters.tag && `Tag: ${filters.tag}`, sorts[filters.sort],
    (filters.fullSearch || query) && (filters.fullSearch ? 'Complete capture search' : 'Quick search'), query && `Search: “${query}”`].filter(Boolean).join(' · ');
}

export function CaptureViewsControls({ filters, onApply, filtersUnavailable = false, children }: Props) {
  const [views, setViews] = useState<CaptureView[]>([]);
  const [unavailable, setUnavailable] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingRemoval, setPendingRemoval] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const removeTrigger = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const matched = views.find(view => captureViewMatches(view, filters));

  function report(reason: unknown) {
    setError(reason instanceof Error ? reason.message : 'Saved views are unavailable. Try again.');
    if (reason instanceof CaptureViewsReadError) setUnavailable(true);
  }
  function reload() {
    try { setViews(loadCaptureViews()); setUnavailable(false); setError(''); setPendingRemoval(''); }
    catch (reason) { report(reason); }
  }
  useEffect(() => { reload(); }, []);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  function close() { setOpen(false); setPendingRemoval(''); trigger.current?.focus(); }
  function apply(view: CaptureView) { onApply({ ...view.filters }); setNotice(`Applied view “${view.name}”.`); }
  const errorMessage = error && <div id={`${id}-error`} className="bt-capture-views-error" role="alert"><span>{error}</span>{unavailable && <button type="button" className="sd-secondary-button" onClick={() => { reload(); (open ? input.current : trigger.current)?.focus(); }}>Retry saved views</button>}</div>;

  return <div className="bt-capture-local-filters" role="group" aria-label="Local capture filters">
    <div className="bt-capture-view-picker">
      <label>View<select aria-label="Saved capture view" disabled={unavailable || filtersUnavailable || !views.length} value={matched?.id ?? ''} onChange={event => {
        const view = views.find(item => item.id === event.target.value); if (view) apply(view);
      }}><option value="" disabled>Current filters</option>{views.map(view => <option value={view.id} key={view.id}>{view.name}</option>)}</select></label>
      <button ref={trigger} type="button" className="sd-secondary-button" aria-expanded={open} aria-controls={open ? `${id}-panel` : undefined} onClick={() => open ? close() : setOpen(true)}><Bookmark size={15} aria-hidden="true" />Views</button>
    </div>
    {children}
    <span>Tags and favorites stay local to this installation.</span>
    {!open && errorMessage}
    {open && <section id={`${id}-panel`} className="bt-capture-views-panel" aria-labelledby={`${id}-title`} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
      <header><div><h2 id={`${id}-title`}>Saved capture views</h2><p>Keep useful filter combinations on this installation. Views do not copy captures or travel in bundles.</p></div><button type="button" className="sd-secondary-button" aria-label="Close saved views" onClick={close}><X size={17} aria-hidden="true" /></button></header>
      <form onSubmit={event => {
        event.preventDefault(); if (unavailable) return;
        try { const next = saveCaptureView(name, filters); setViews(next); setName(''); setError(''); setNotice(`Saved view “${next[next.length - 1].name}”.`); }
        catch (reason) { report(reason); input.current?.focus(); }
      }}>
        <div className="bt-capture-view-current"><strong>Current filters</strong><p title={filters.query}>{describe(filters)}</p></div>
        <div className="bt-capture-view-save"><label htmlFor={`${id}-name`}>View name<input ref={input} id={`${id}-name`} name="capture-view-name" autoComplete="off" maxLength={48} value={name} onChange={event => setName(event.target.value)} placeholder="Baseline checks" aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} /></label><button type="submit" className="sd-primary-button" disabled={unavailable}>Save view</button></div>
        {errorMessage}
        <p id={`${id}-help`}>Up to 24 views, with unique names of 48 characters or fewer. Applying a view restores its search scope too.</p>
      </form>
      {views.length ? <ul className="bt-capture-views-list" aria-label="Saved views">{views.map(view => <li key={view.id}>
        <div className="bt-capture-view-row"><div><strong>{view.name}</strong><p title={view.filters.query}>{describe(view.filters)}</p></div><div className="bt-capture-view-actions"><button type="button" className="sd-secondary-button" disabled={unavailable || filtersUnavailable} onClick={() => apply(view)}>Apply<span className="bt-capture-view-sr"> {view.name}</span></button><button type="button" className="sd-secondary-button" aria-label={`Remove saved view ${view.name}`} aria-expanded={pendingRemoval === view.id} disabled={unavailable} onClick={event => { removeTrigger.current = event.currentTarget; setPendingRemoval(pendingRemoval === view.id ? '' : view.id); }}>Remove</button></div></div>
        {pendingRemoval === view.id && <div className="bt-capture-view-confirm"><p>Remove “{view.name}”? Captures and current filters stay intact.</p><button type="button" className="sd-secondary-button" onClick={() => {
          try { setViews(removeCaptureView(view.id)); setPendingRemoval(''); setError(''); setNotice(`Removed view “${view.name}”.`); input.current?.focus(); }
          catch (reason) { report(reason); }
        }} disabled={unavailable}>Remove view</button><button type="button" className="sd-secondary-button" onClick={() => { setPendingRemoval(''); removeTrigger.current?.focus(); }}>Keep view</button></div>}
      </li>)}</ul> : <p className="bt-capture-views-empty">No saved views yet. Set your filters, then give this view a name.</p>}
      <p className="bt-capture-view-notice" role="status">{notice}</p>
    </section>}
  </div>;
}
