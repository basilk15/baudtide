// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CaptureNotebook } from './CaptureNotebook';
it('retains a failed save draft and cancels back to the trigger', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  const host=document.createElement('div'); document.body.append(host); const root=createRoot(host);
  try {
    await act(async()=>root.render(<CaptureNotebook name="ESP32" value={{title:'Thermal',notes:'Firmware v2'}} disabled={false} onSave={()=>{throw Error('Disk full');}} />));
    await act(async()=>host.querySelector('button')!.click());
    expect(document.activeElement).toBe(host.querySelector('input'));
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Disk full');
    expect(host.querySelector('textarea')?.value).toBe('Firmware v2');
    await act(async()=>host.querySelector('form')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    expect(host.querySelector('form')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('button'));
  } finally {await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
