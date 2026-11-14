// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CaptureOrganizationControls } from './CaptureOrganizationControls';

it('edits tags explicitly, retains failed edits, and cancels with Escape', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const save = vi.fn(() => { throw new Error('Storage full'); }); const favorite = vi.fn();
  function Harness() { const [editing,setEditing]=useState(false); return <CaptureOrganizationControls name="Board" favorite={false} tags={['baseline']} disabled={false} editing={editing} onEditingChange={setEditing} onFavorite={favorite} onTags={save} />; }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Favorite Board"]')!.click());
    expect(favorite).toHaveBeenCalledOnce();
    const edit = host.querySelector<HTMLButtonElement>('[aria-label="Edit tags for Board"]')!;
    await act(async () => edit.click());
    const input = host.querySelector('input')!; expect(document.activeElement).toBe(input);
    expect(edit.getAttribute('aria-controls')).toBe(host.querySelector('form')!.id);
    expect(input.value).toBe('baseline');
    host.querySelector<HTMLButtonElement>('button[type="submit"]')!.focus();
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Storage full');
    expect(document.activeElement).toBe(input);
    expect(host.querySelector('input')).not.toBeNull();
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('input')).toBeNull(); expect(document.activeElement).toBe(edit);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
