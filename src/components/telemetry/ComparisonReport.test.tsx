// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ComparisonReport } from './ComparisonReport';
import type { ComparisonSummarySnapshot } from '../../lib/captures/comparisonSummary';

const statistics = { count: 2, min: 10, max: 20, mean: 15, deviation: 5, skippedUnits: 0 };
const side = { name: 'Baseline', field: 'temperature', anchorMs: 0, requested: { start: 0, end: 1000 }, effective: { start: 0, end: 1000 }, state: 'saved' as const, timingMode: 'recorded' as const, statistics };
const snapshot: ComparisonSummarySnapshot = { baseline: side, candidate: { ...side, name: 'Candidate' }, unit: 'C', startSeconds: 0, endSeconds: 1, evaluation: null };
const context = { kind: 'saved' as const, savedAt: '2026-11-15T00:00:00Z', paths: { baseline: '/private/a.log', candidate: '/private/b.log' } };

it('previews without copying, includes paths only by choice, and supports selection and Escape focus', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true); const write=vi.fn().mockResolvedValue(undefined); vi.stubGlobal('navigator',{clipboard:{writeText:write}});
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===text)!;
  try {
    await act(async()=>root.render(<ComparisonReport snapshot={snapshot} context={context} />));
    expect(host.querySelector('textarea')).toBeNull();
    const trigger=button('Create report');await act(async()=>trigger.click());
    const preview=host.querySelector('textarea')!;expect(document.activeElement).toBe(preview);
    expect(preview.value).toContain('Historical snapshot');expect(preview.value).not.toContain('/private');expect(write).not.toHaveBeenCalled();
    await act(async()=>host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());
    expect(preview.value).toContain('/private/a.log');
    await act(async()=>button('Copy Markdown').click());expect(write).toHaveBeenCalledWith(preview.value);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('copied');
    await act(async()=>button('Select report').click());expect(preview.selectionStart).toBe(0);expect(preview.selectionEnd).toBe(preview.value.length);
    await act(async()=>preview.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    expect(host.querySelector('textarea')).toBeNull();expect(document.activeElement).toBe(trigger);
    await act(async()=>button('Create report').click());expect(host.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked).toBe(false);
  } finally {await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

it.each(['denied','unavailable'])('keeps a manual-copy fallback when clipboard access is %s', async mode => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('navigator',{clipboard:mode === 'denied' ? {writeText:vi.fn().mockRejectedValue(new Error('denied'))} : undefined});
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  try {
    await act(async()=>root.render(<ComparisonReport snapshot={snapshot} context={{kind:'current'}} />));
    await act(async()=>host.querySelector('button')!.click());
    await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Copy Markdown')!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Select report');
    await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Select report')!.click());
    expect(document.activeElement).toBe(host.querySelector('textarea'));
  } finally {await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

it('prevents duplicate pending copies and ignores stale completion after content changes or unmount', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);let finish!:()=>void;const write=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));vi.stubGlobal('navigator',{clipboard:{writeText:write}});
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  try {
    await act(async()=>root.render(<ComparisonReport snapshot={snapshot} context={{kind:'current'}} />));
    await act(async()=>host.querySelector('button')!.click());
    const copy=[...host.querySelectorAll('button')].find(b=>b.textContent==='Copy Markdown')!;
    await act(async()=>{copy.click();copy.click();});expect(write).toHaveBeenCalledTimes(1);expect(copy.disabled).toBe(true);
    await act(async()=>root.render(<ComparisonReport snapshot={{...snapshot,unit:'V'}} context={{kind:'current'}} />));
    await act(async()=>finish());expect(host.querySelector('[role="status"]')?.textContent).not.toContain('copied');
    await act(async()=>copy.click());expect(write).toHaveBeenCalledTimes(2);
    await act(async()=>root.unmount());await act(async()=>finish());
    expect(host.textContent).toBe('');
  } finally {host.remove();vi.unstubAllGlobals();}
});
