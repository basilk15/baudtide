// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ExampleCaptureGallery } from './ExampleCaptureGallery';

it('previews an explicitly selected example, imports its ID, and locks selection while busy', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); const onImport = vi.fn(); const onClose = vi.fn();
  const render = (busy: boolean) => root.render(<ExampleCaptureGallery busy={busy} onImport={onImport} onClose={onClose} />);
  try {
    await act(async () => render(false));
    expect(container.textContent).toContain('Synthetic');
    expect(onImport).not.toHaveBeenCalled();
    const motor = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Motor speed'))!;
    await act(async () => motor.click());
    expect(container.textContent).toContain('Motor columns');
    await act(async () => container.querySelector<HTMLButtonElement>('.bt-examples-import')!.click());
    expect(onImport).toHaveBeenCalledWith('motor-columns');
    await act(async () => render(true));
    expect([...container.querySelectorAll('button')].every(b => b.disabled)).toBe(true);
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
