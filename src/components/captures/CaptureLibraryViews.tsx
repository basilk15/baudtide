import { useEffect, useRef, useState } from 'react';
import { Bookmark, Trash2 } from 'lucide-react';
import { deleteCaptureView, loadCaptureViews, saveCaptureView, type CaptureView, type CaptureViewFilters } from '../../lib/captures/captureViews';
type Props = { filters: CaptureViewFilters; onApply: (filters: CaptureViewFilters) => void };
export function CaptureLibraryViews({filters,onApply}:Props) {
  const [views,setViews]=useState<CaptureView[]>([]);
  const [selected,setSelected]=useState('');
  const [editing,setEditing]=useState(false);
  const [name,setName]=useState('');
  const [error,setError]=useState('');
  const [unavailable,setUnavailable]=useState(true);
  const [removing,setRemoving]=useState(false);
  const input=useRef<HTMLInputElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  const reload=()=>{try{setViews(loadCaptureViews());setError('');setUnavailable(false);}catch(reason){setError((reason as Error).message);setUnavailable(true);}};
  useEffect(reload,[]);
  useEffect(()=>{if(editing)input.current?.focus();},[editing]);
  const close=()=>{setEditing(false);trigger.current?.focus();};
  return <section className="bt-library-tools" aria-label="Saved library views">
    <label>Saved view<select value={selected} disabled={unavailable} onChange={event=>{setSelected(event.target.value);setRemoving(false);}}>
      <option value="">Choose a view</option>{views.map(v=><option key={v.name} value={v.name}>{v.name}</option>)}
    </select></label>
    <button type="button" className="sd-secondary-button" disabled={!selected || unavailable} onClick={()=>{const view=views.find(v=>v.name===selected);if(view)onApply(view.filters);}}>Apply view</button>
    <button ref={trigger} type="button" className="sd-secondary-button" disabled={unavailable} aria-expanded={editing} onClick={()=>{setEditing(!editing);setName('');setError('');}}><Bookmark size={15} /> Save current view</button>
    <button type="button" className="sd-secondary-button" disabled={!selected || unavailable} aria-label="Remove selected view" onClick={()=>setRemoving(!removing)}><Trash2 size={15} /></button>
    {removing && <div className="bt-library-form"><strong>Remove “{selected}”?</strong><p>This removes only the saved filters. Captures and notebooks stay in your library.</p><div><button type="button" className="sd-secondary-button" onClick={()=>{try{setViews(deleteCaptureView(selected));setSelected('');setRemoving(false);trigger.current?.focus();}catch(reason){setError((reason as Error).message);}}}>Remove view</button><button type="button" className="sd-secondary-button" onClick={()=>setRemoving(false)}>Cancel</button></div></div>}
    {editing && <form className="bt-library-form" aria-label="Save library view" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();close();}}} onSubmit={event=>{event.preventDefault();try{setViews(saveCaptureView(name,filters));setSelected(name.trim());setError('');close();}catch(reason){setError((reason as Error).message);}}}>
      <label>View name<input ref={input} value={name} maxLength={60} onChange={event=>setName(event.target.value)} placeholder="Firmware investigation" /></label><p>Saves all search and organization filters on this computer. Applying a view never connects a device.</p><div><button type="submit" className="sd-primary-button">Save view</button><button type="button" className="sd-secondary-button" onClick={close}>Cancel</button></div>
    </form>}
    {error && <p role="alert">{error} {unavailable && <button type="button" className="sd-secondary-button" onClick={reload}>Retry saved views</button>}</p>}
  </section>;
}
