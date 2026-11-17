// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SavedLogsScreen } from './SavedLogsScreen';
import { setCaptureFavorite, setCaptureTags } from '../../lib/captures/captureOrganization';
import { saveCaptureView } from '../../lib/captures/captureViews';
const { list, pending, remove, search, cancelSearch } = vi.hoisted(() => ({ list: vi.fn(), pending: vi.fn(), remove: vi.fn(), search: vi.fn(), cancelSearch: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/serial/serial', async original => ({ ...await original<typeof import('../../lib/serial/serial')>(), listNativeSavedLogs: list, pendingCaptureBundleImports: pending, deleteNativeSavedLog: remove, searchNativeSavedLogs: search, cancelNativeSavedLogSearch: cancelSearch }));
const logs = ['Alpha', 'Beta'].map((name,i) => ({ path:`/${name}.log`, fileName:`${name}.log`, sessionName:name, sizeBytes:100, modifiedAt:'2026-01-01T00:00:00Z', metadataAvailable:false, state:i ? 'interrupted' : 'saved' }));
it('applies a saved view through real library filters without auto-applying it at startup', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); list.mockResolvedValue(logs); pending.mockResolvedValue([]);
  setCaptureFavorite('/Alpha.log',true); setCaptureTags('/Alpha.log','baseline');
  const { saveCaptureNotebook } = await import('../../lib/captures/captureNotebook');
  saveCaptureNotebook('/Alpha.log', { title: 'Alpha', notes: 'firmware v2' });
  saveCaptureView('Baseline checks',{query:'',fullSearch:true,state:'completed',sort:'name',favoritesOnly:true,tag:'baseline',notebookQuery:'firmware v2'});
  const host=document.createElement('div'); document.body.append(host); const root=createRoot(host);
  try {
    await act(async()=>root.render(<SavedLogsScreen nativeEnabled onRequestConnection={()=>{}} onReconnectWithSettings={()=>{}} onOpenInVisualize={()=>{}} />));
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    const select=host.querySelector<HTMLSelectElement>('[aria-label="Saved capture view"]')!;
    await act(async()=>{select.value=[...select.options].find(o=>o.textContent==='Baseline checks')!.value;select.dispatchEvent(new Event('change',{bubbles:true}));});
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(host.querySelector('[role="listitem"]')?.textContent).toContain('Alpha');
    expect(host.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('.bt-library-tools input[type="search"]')!.value).toBe('firmware v2');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Filter captures by tag"]')!.value).toBe('baseline');
    expect(host.querySelector('[aria-label="Sort saved logs"]')?.textContent).toContain('Name A');
    const reset=[...host.querySelectorAll('button')].find(b=>b.textContent==='Reset organization')!;
    await act(async()=>reset.click());expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    expect(select.value).toBe(''); expect(loadViewCount()).toBe(1);
  } finally {await act(async()=>root.unmount());host.remove();localStorage.clear();vi.unstubAllGlobals();}
});
function loadViewCount(){return JSON.parse(localStorage.getItem('baudtide.capture-views.v1')!).views.length;}
it('restores a nonempty view query and runs the saved complete-search scope', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.useFakeTimers();localStorage.clear();list.mockResolvedValue(logs);pending.mockResolvedValue([]);search.mockClear();
  search.mockResolvedValue({results:[{log:logs[0],metadataMatch:true,contentMatchCount:0,contentMatches:[],contentSearchTruncated:false}],fullSearch:true,truncated:false,resultLimitReached:false,scannedLogCount:2,scannedBytes:200,indexedLogCount:2,indexRebuiltLogCount:0,indexFallbackLogCount:0,indexUpdateLimited:false});
  saveCaptureView('Search baseline',{query:'Alpha',fullSearch:true,state:'completed',sort:'oldest',favoritesOnly:false,tag:'',notebookQuery:''});
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  try {
    await act(async()=>root.render(<SavedLogsScreen nativeEnabled onRequestConnection={()=>{}} onReconnectWithSettings={()=>{}} onOpenInVisualize={()=>{}} />));
    expect(search).not.toHaveBeenCalled();
    const select=host.querySelector<HTMLSelectElement>('[aria-label="Saved capture view"]')!;
    await act(async()=>{select.value=select.options[1].value;select.dispatchEvent(new Event('change',{bubbles:true}));});
    expect(host.querySelector<HTMLInputElement>('[name="capture-search"]')!.value).toBe('Alpha');
    await act(async()=>vi.advanceTimersByTimeAsync(221));
    expect(search).toHaveBeenCalledWith('Alpha',true,expect.stringContaining('full-search-'));
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(host.querySelector('[role="listitem"]')?.textContent).toContain('Alpha');
  } finally {await act(async()=>root.unmount());host.remove();localStorage.clear();vi.useRealTimers();vi.unstubAllGlobals();}
});
it('combines favorites, tags, and state filters and resets an empty result', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); list.mockResolvedValue(logs); pending.mockResolvedValue([]);
  setCaptureFavorite('/Alpha.log', true); setCaptureTags('/Alpha.log', 'baseline'); setCaptureTags('/Beta.log', 'candidate');
  const host=document.createElement('div'); document.body.append(host); const root=createRoot(host);
  const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.includes(text))!;
  try {
    await act(async()=>root.render(<SavedLogsScreen nativeEnabled onRequestConnection={()=>{}} onReconnectWithSettings={()=>{}} onOpenInVisualize={()=>{}} />));
    await act(async()=>button('Favorites').click());
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    const select=host.querySelector<HTMLSelectElement>('[aria-label="Filter captures by tag"]')!;
    await act(async()=>{select.value='candidate'; select.dispatchEvent(new Event('change',{bubbles:true}));});
    expect(host.textContent).toContain('No logs match that organization');
    await act(async()=>button('Reset organization').click());
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    await act(async()=>button('Needs attention').click());
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(host.querySelector('[role="listitem"]')?.textContent).toContain('Beta');
  } finally { await act(async()=>root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); }
});

it('keeps storage errors visible on refresh, supports retry, and preserves favorite state on write failure', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); localStorage.setItem('baudtide.capture-organization.v1','{bad'); list.mockResolvedValue(logs); pending.mockResolvedValue([]);
  const host=document.createElement('div'); document.body.append(host); const root=createRoot(host);
  const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.includes(text))!;
  try {
    await act(async()=>root.render(<SavedLogsScreen nativeEnabled onRequestConnection={()=>{}} onReconnectWithSettings={()=>{}} onOpenInVisualize={()=>{}} />));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Favorite Alpha"]')!.disabled).toBe(true);
    await act(async()=>button('Refresh').click());
    expect(host.textContent).toContain('Existing data is preserved');
    localStorage.removeItem('baudtide.capture-organization.v1');
    await act(async()=>button('Retry organization').click());
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Favorite Alpha"]')!.click());
    const spy=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('full');});
    try { await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Unfavorite Alpha"]')!.click()); }
    finally { spy.mockRestore(); }
    expect(host.querySelector('[aria-label="Unfavorite Alpha"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).toContain('could not be saved');
    localStorage.setItem('baudtide.capture-organization.v1','{bad');
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Unfavorite Alpha"]')!.click());
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Unfavorite Alpha"]')!.disabled).toBe(true);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Filter captures by tag"]')!.disabled).toBe(true);
  } finally { await act(async()=>root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); }
});

it('opens only one editor and moves focus to the tag filter when a saved edit hides its row', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true); localStorage.clear(); list.mockResolvedValue(logs); pending.mockResolvedValue([]);
  setCaptureTags('/Alpha.log','baseline'); setCaptureTags('/Beta.log','baseline');
  const host=document.createElement('div'); document.body.append(host); const root=createRoot(host);
  try {
    await act(async()=>root.render(<SavedLogsScreen nativeEnabled onRequestConnection={()=>{}} onReconnectWithSettings={()=>{}} onOpenInVisualize={()=>{}} />));
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Edit tags for Alpha"]')!.click());
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Edit tags for Beta"]')!.click());
    expect(host.querySelectorAll('.bt-capture-tag-editor')).toHaveLength(1);
    const filter=host.querySelector<HTMLSelectElement>('[aria-label="Filter captures by tag"]')!;
    await act(async()=>{filter.value='baseline';filter.dispatchEvent(new Event('change',{bubbles:true}));});
    const input=host.querySelector<HTMLInputElement>('.bt-capture-tag-editor input')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'candidate');input.dispatchEvent(new Event('input',{bubbles:true}));});
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(document.activeElement).toBe(filter);
  } finally {await act(async()=>root.unmount());host.remove();localStorage.clear();vi.unstubAllGlobals();}
});

it('cleans explicit deletions and reports metadata cleanup failure without claiming the raw deletion failed', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true); localStorage.clear(); list.mockResolvedValue(logs); pending.mockResolvedValue([]); remove.mockResolvedValue(undefined);
  setCaptureTags('/Alpha.log','baseline'); setCaptureTags('/Beta.log','candidate');
  const host=document.createElement('div'); document.body.append(host); const root=createRoot(host);
  const confirm=()=>[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()==='Delete log')!;
  try {
    await act(async()=>root.render(<SavedLogsScreen nativeEnabled onRequestConnection={()=>{}} onReconnectWithSettings={()=>{}} onOpenInVisualize={()=>{}} />));
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Delete Alpha.log"]')!.click());
    await act(async()=>confirm().click());
    expect(localStorage.getItem('baudtide.capture-organization.v1')).not.toContain('/Alpha.log');
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Delete Beta.log"]')!.click());
    const spy=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('full');});
    try { await act(async()=>confirm().click()); } finally { spy.mockRestore(); }
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(0);
    expect(host.textContent).toContain('Capture deleted, but local tags and favorites could not be cleaned up');
    expect(remove).toHaveBeenCalledWith('/Beta.log');
  } finally { await act(async()=>root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); }
});

it('returns focus to a surviving filter when a notebook edit hides its capture', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true); localStorage.clear(); list.mockResolvedValue(logs); pending.mockResolvedValue([]);
  const {saveCaptureNotebook}=await import('../../lib/captures/captureNotebook');
  saveCaptureNotebook('/Alpha.log',{title:'Thermal',notes:'initial'});
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const change=async(el:HTMLInputElement,text:string)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}));});
  try {
    await act(async()=>root.render(<SavedLogsScreen nativeEnabled onRequestConnection={()=>{}} onReconnectWithSettings={()=>{}} onOpenInVisualize={()=>{}} />));
    const query=host.querySelector<HTMLInputElement>('.bt-library-tools input[type="search"]')!;
    await change(query,'Thermal');
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Edit notebook for Alpha"]')!.click());
    await change(host.querySelector<HTMLInputElement>('.bt-capture-notebook input')!,'Motor');
    await act(async()=>host.querySelector('.bt-capture-notebook form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(0);
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Filter captures by tag"]'));
  } finally {await act(async()=>root.unmount());host.remove();localStorage.clear();vi.unstubAllGlobals();}
});
