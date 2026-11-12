// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureBundleReview } from './CaptureBundleReview';

const profiles = [{ id: 'sensor', name: 'Sensor columns' }];
let container: HTMLDivElement;
afterEach(() => { container?.remove(); vi.unstubAllGlobals(); });

describe('capture bundle export review', () => {
  it('explains shared contents and exports only the decoder chosen by the user', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container); const exportBundle = vi.fn();
    await act(async () => root.render(<CaptureBundleReview captureName="Board" sizeBytes={2048} noteCount={2} timing="recorded" profiles={profiles} busy={false} error="" onCancel={() => {}} onExport={exportBundle} />));
    expect(container.textContent).toContain('Board');
    expect(container.textContent).toContain('2 notes');
    expect(container.textContent).toContain('sensitive');
    const select = container.querySelector<HTMLSelectElement>('select')!;
    await act(async () => { select.value = 'sensor'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Export bundle'))!.click());
    expect(exportBundle).toHaveBeenCalledWith('sensor');
    await act(async () => root.unmount());
  });
  it('supports Escape and shows a recoverable export error', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container); const cancel = vi.fn();
    await act(async () => root.render(<CaptureBundleReview captureName="Board" sizeBytes={0} noteCount={0} timing="approximate" profiles={[]} busy={false} error="Disk full" onCancel={cancel} onExport={() => {}} />));
    expect(container.textContent).toContain('Approximate');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Disk full');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(cancel).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
});
