// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CaptureViewsControls } from './CaptureViewsControls';
import { loadCaptureViews, saveCaptureView, type CaptureViewFilters } from '../../lib/captures/captureViews';

const filters: CaptureViewFilters = { query: 'motor', fullSearch: true, state: 'completed', sort: 'name', favoritesOnly: true, tag: 'baseline', notebookQuery: 'firmware' };
it('saves explicitly, reapplies all fields, survives remounts, and confirms removal without changing captures', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear();
  const host = document.createElement('div'); document.body.append(host); let root = createRoot(host); const apply = vi.fn();
  const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text)!;
  const typeName = async (text: string) => act(async () => { const input = host.querySelector('input')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
  try {
    await act(async () => root.render(<CaptureViewsControls filters={filters} onApply={apply}><span>Existing filters</span></CaptureViewsControls>));
    expect(apply).not.toHaveBeenCalled(); expect(host.textContent).toContain('Existing filters');
    await act(async () => button('Views').click()); expect(document.activeElement).toBe(host.querySelector('input'));
    expect(host.textContent).toContain('Complete capture search');
    await typeName('Motor baseline');
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(loadCaptureViews()[0]).toMatchObject({ name: 'Motor baseline', filters }); expect(apply).not.toHaveBeenCalled();
    await act(async () => root.unmount()); root = createRoot(host);
    await act(async () => root.render(<CaptureViewsControls filters={{ ...filters, query: '' }} onApply={apply} />));
    expect(apply).not.toHaveBeenCalled();
    const select = host.querySelector('select')!;
    await act(async () => { select.value = loadCaptureViews()[0].id; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(apply).toHaveBeenCalledWith(filters);
    await act(async () => button('Views').click());
    await act(async () => button('Remove').click()); expect(loadCaptureViews()).toHaveLength(1);
    await act(async () => button('Keep view').click()); expect(loadCaptureViews()).toHaveLength(1);
    await act(async () => button('Remove').click());
    await act(async () => button('Remove view').click()); expect(loadCaptureViews()).toHaveLength(0);
    expect(apply).toHaveBeenCalledTimes(1); expect(document.activeElement).toBe(host.querySelector('input'));
    const trigger = button('Views');
    await act(async () => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('form')).toBeNull(); expect(document.activeElement).toBe(trigger);
  } finally { await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); }
});

it('retains failed drafts, blocks damaged storage writes, and supports recovery', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); saveCaptureView('Existing', filters);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text)!;
  try {
    await act(async () => root.render(<CaptureViewsControls filters={filters} onApply={() => {}} />));
    await act(async () => button('Views').click());
    const input = host.querySelector('input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'New view'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    try { await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); } finally { write.mockRestore(); }
    expect(input.value).toBe('New view'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be saved');
    expect(loadCaptureViews()).toHaveLength(1);
    localStorage.setItem('baudtide.capture-views.v1', '{damaged');
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(button('Save view').disabled).toBe(true);
    expect(localStorage.getItem('baudtide.capture-views.v1')).toBe('{damaged');
    localStorage.removeItem('baudtide.capture-views.v1');
    button('Retry saved views').focus();
    await act(async () => button('Retry saved views').click());
    expect(button('Save view').disabled).toBe(false);
    expect(document.activeElement).toBe(input);
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(loadCaptureViews()[0].name).toBe('New view');
  } finally { await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); }
});
