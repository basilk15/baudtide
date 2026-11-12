// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SavedLogsScreen } from './SavedLogsScreen';

const api = vi.hoisted(() => ({ list: vi.fn(), inspect: vi.fn(), exportBundle: vi.fn(), importBundle: vi.fn(), pending: vi.fn(), finish: vi.fn() }));
vi.mock('../../lib/serial/serial', async (original) => ({ ...await original<typeof import('../../lib/serial/serial')>(),
  listNativeSavedLogs: api.list, inspectCaptureBundle: api.inspect, exportCaptureBundle: api.exportBundle,
  importCaptureBundle: api.importBundle, pendingCaptureBundleImports: api.pending, finishCaptureBundleImport: api.finish }));
let container: HTMLDivElement;
afterEach(() => { container?.remove(); localStorage.clear(); vi.unstubAllGlobals(); Object.values(api).forEach((fn) => fn.mockReset()); });
const log = { path: '/logs/board.log', fileName: 'board.log', sessionName: 'Board', sizeBytes: 100, modifiedAt: '2026-01-01T00:00:00.000Z', state: 'saved' as const, metadataAvailable: false };
function button(name: string) { return [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(name))!; }
describe('saved log bundle actions', () => {
  it('reviews and exports a selected completed capture', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); api.list.mockResolvedValue([log]); api.pending.mockResolvedValue([]); api.inspect.mockResolvedValue({ timingMode: 'approximate' }); api.exportBundle.mockResolvedValue({ destination: '/out.btbundle', timingMode: 'approximate' });
    container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    await act(async () => root.render(<SavedLogsScreen nativeEnabled onRequestConnection={() => {}} onReconnectWithSettings={() => {}} onOpenInVisualize={() => {}} />));
    await act(async () => button('Export bundle').click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('sensitive');
    await act(async () => [...container.querySelectorAll('[role="dialog"] button')].find((item) => item.textContent?.includes('Export bundle'))!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(api.exportBundle).toHaveBeenCalledWith(log.path, expect.objectContaining({ name: 'Board', decoder: null, notes: [] }));
    expect(container.textContent).toContain('Exported');
    await act(async () => root.unmount());
  });
  it('imports a bundle and finishes restoration before reporting success', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); api.list.mockResolvedValue([]); api.pending.mockResolvedValue([]); api.finish.mockResolvedValue(undefined);
    api.importBundle.mockResolvedValue({ id: '1234-abcd', capturePath: '/new.log', metadata: { name: 'Board', decoder: null, notes: [{ timestamp: '2026-01-01T00:00:01.000Z', sourceName: 'Board', label: 'Spike', note: '' }] } });
    container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    await act(async () => root.render(<SavedLogsScreen nativeEnabled onRequestConnection={() => {}} onReconnectWithSettings={() => {}} onOpenInVisualize={() => {}} />));
    await act(async () => button('Import bundle').click());
    expect(api.finish).toHaveBeenCalledWith('1234-abcd');
    expect(localStorage.getItem('baudtide.capture-markers.v1')).toContain('/new.log');
    expect(container.textContent).toContain('Imported');
    await act(async () => root.unmount());
  });
  it('keeps a retry action when local notes cannot be restored', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); api.list.mockResolvedValue([]); api.pending.mockResolvedValue([]);
    api.importBundle.mockResolvedValue({ id: '1234-abcd', capturePath: '/new.log', metadata: { name: 'Board', decoder: null, notes: [{ timestamp: '2026-01-01T00:00:01.000Z', sourceName: 'Board', label: 'Spike', note: '' }] } });
    localStorage.setItem('baudtide.capture-markers.v1', '{broken');
    container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    await act(async () => root.render(<SavedLogsScreen nativeEnabled onRequestConnection={() => {}} onReconnectWithSettings={() => {}} onOpenInVisualize={() => {}} />));
    await act(async () => button('Import bundle').click());
    expect(api.finish).not.toHaveBeenCalled(); expect(button('Retry Board')).toBeDefined();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Existing notes are preserved');
    expect(localStorage.getItem('baudtide.capture-markers.v1')).toBe('{broken');
    localStorage.removeItem('baudtide.capture-markers.v1'); api.finish.mockResolvedValue(undefined);
    await act(async () => button('Retry Board').click());
    expect(api.finish).toHaveBeenCalledWith('1234-abcd'); expect(container.textContent).toContain('Restored Board');
    await act(async () => root.unmount());
  });
  it('keeps a new retry action when the initial pending-import scan returns late', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); api.list.mockResolvedValue([]);
    let resolvePending!: (value: unknown[]) => void;
    api.pending.mockReturnValue(new Promise((resolve) => { resolvePending = resolve; }));
    api.importBundle.mockResolvedValue({ id: '1234-abcd', capturePath: '/new.log', metadata: { name: 'Board', decoder: null, notes: [{ timestamp: '2026-01-01T00:00:01.000Z', sourceName: 'Board', label: 'Spike', note: '' }] } });
    localStorage.setItem('baudtide.capture-markers.v1', '{broken');
    container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    await act(async () => root.render(<SavedLogsScreen nativeEnabled onRequestConnection={() => {}} onReconnectWithSettings={() => {}} onOpenInVisualize={() => {}} />));
    await act(async () => button('Import bundle').click());
    await act(async () => resolvePending([]));
    expect(button('Retry Board')).toBeDefined();
    await act(async () => root.unmount());
  });
  it('can finish a pending import without notes only after confirmation', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true); vi.stubGlobal('confirm', confirm);
    const pending = { id: '1234-abcd', capturePath: '/new.log', metadata: { name: 'Board', decoder: null, notes: [{ timestamp: '2026-01-01T00:00:01.000Z', sourceName: 'Board', label: 'Spike', note: '' }] } };
    api.list.mockResolvedValue([]); api.pending.mockResolvedValue([pending]); api.finish.mockResolvedValue(undefined);
    localStorage.setItem('baudtide.capture-markers.v1', '{broken');
    container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    await act(async () => root.render(<SavedLogsScreen nativeEnabled onRequestConnection={() => {}} onReconnectWithSettings={() => {}} onOpenInVisualize={() => {}} />));
    await act(async () => button('Skip note import').click()); expect(api.finish).not.toHaveBeenCalled();
    await act(async () => button('Skip note import').click()); expect(api.finish).toHaveBeenCalledWith('1234-abcd');
    expect(localStorage.getItem('baudtide.capture-markers.v1')).toBe('{broken');
    await act(async () => root.unmount());
  });
});
