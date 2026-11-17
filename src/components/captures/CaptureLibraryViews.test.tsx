// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect,it,vi } from 'vitest';
import { CaptureLibraryViews } from './CaptureLibraryViews';
import { saveCaptureView, type CaptureViewFilters } from '../../lib/captures/captureViews';
it('restores all filters and requires explicit confirmation to remove a view',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);localStorage.clear();
  const filters:CaptureViewFilters={query:'panic',fullSearch:true,state:'attention',sort:'oldest',favorites:true,tag:'old tag',notebookQuery:'firmware'};
  saveCaptureView('Investigation',filters);
  const onApply=vi.fn();const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const button=(name:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===name)!;
  try {
    await act(async()=>root.render(<CaptureLibraryViews filters={filters} onApply={onApply}/>));
    await act(async()=>{const select=host.querySelector('select')!;select.value='Investigation';select.dispatchEvent(new Event('change',{bubbles:true}));});
    await act(async()=>button('Apply view').click());expect(onApply).toHaveBeenCalledWith(filters);
    await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Remove selected view"]')!.click());
    expect(host.textContent).toContain('Captures and notebooks stay');
    await act(async()=>button('Remove view').click());
    expect(host.querySelectorAll('option')).toHaveLength(1);
  } finally {await act(async()=>root.unmount());host.remove();localStorage.clear();vi.unstubAllGlobals();}
});
