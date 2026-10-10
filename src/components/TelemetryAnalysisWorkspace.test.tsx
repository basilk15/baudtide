// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryAnalysisWorkspace, type TelemetryAnalysisWorkspaceProps } from './TelemetryAnalysisWorkspace';
import { listNativeSavedLogs, type SavedLog } from '../lib/serial';
import { analyzeNativeCapture, CaptureAnalysisIndex } from '../lib/captureAnalysis';
import { storeAnalysisWorkspaces, type SavedAnalysisWorkspace } from '../lib/analysisWorkspaces';
import { TelemetrySessionStore } from '../lib/telemetry';

vi.mock('../lib/serial', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/serial')>(),
  listNativeSavedLogs: vi.fn(),
}));
vi.mock('../lib/captureAnalysis', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/captureAnalysis')>(),
  analyzeNativeCapture: vi.fn(),
}));
// Canvas rendering and disk history are independent of capture-library refreshes.
vi.mock('./TelemetryECharts', () => ({ TelemetryCharts: () => null }));
vi.mock('./TelemetryDecoderPanel', () => ({ TelemetryDecoderPanel: () => null }));
vi.mock('../lib/watchHistory', () => ({
  WatchHistoryJournal: class {
    async latest() { return []; }
    async summary() { return { count: 0, through: 0 }; }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const capture: SavedLog = {
  path: '/saved/returned.log', fileName: 'returned.log', sessionName: 'Returned capture',
  sizeBytes: 100, modifiedAt: '2026-10-10T12:00:00Z', metadataAvailable: true, state: 'saved',
};
function workspace(log = capture): SavedAnalysisWorkspace {
  return { id: log.path, name: log.sessionName, updatedAt: 1000, alignment: 'elapsed', chartMode: 'lanes', windowMs: 0, replayRate: 1,
    sources: [{ key: 'capture', kind: 'recorded', target: log.path, name: log.sessionName, selectedFields: [] }], watches: [] };
}

describe('linked analysis capture-library refresh', () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: TelemetryAnalysisWorkspaceProps;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    props = { nativeEnabled: true, workspaceVisible: true, sessions: [], selectedSessionId: null,
      onSelectSession: vi.fn(), onRequestConnection: vi.fn(), onRequestedAnalysisRestored: vi.fn() };
    vi.mocked(listNativeSavedLogs).mockResolvedValue([]);
    vi.mocked(analyzeNativeCapture).mockImplementation(async (sourceId) => {
      const index = new CaptureAnalysisIndex({
        async put() {}, async get() { throw new Error('Empty capture has no pages.'); }, async release() {},
      });
      index.metadata = new TelemetrySessionStore().getSnapshot(sourceId);
      return { index, snapshot: (await index.query()).snapshot };
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(next: Partial<TelemetryAnalysisWorkspaceProps> = {}) {
    props = { ...props, ...next };
    await act(async () => root.render(<TelemetryAnalysisWorkspace {...props} />));
  }

  it('waits for fresh logs before restoring a capture unavailable at the previous visit', async () => {
    await render();
    storeAnalysisWorkspaces({ version: 1, activeId: null, workspaces: [workspace()] });
    const refresh = deferred<SavedLog[]>();
    vi.mocked(listNativeSavedLogs).mockReturnValueOnce(refresh.promise);
    await render({ requestedAnalysis: { id: capture.path, revision: 1 } });
    expect(listNativeSavedLogs).toHaveBeenCalledTimes(2);
    expect(props.onRequestedAnalysisRestored).not.toHaveBeenCalled();
    expect(analyzeNativeCapture).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Unavailable captures');

    await act(async () => refresh.resolve([capture]));
    expect(analyzeNativeCapture).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzeNativeCapture).mock.calls[0][1]).toEqual(capture);
    expect(props.onRequestedAnalysisRestored).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="tab"]')?.textContent).toContain(capture.sessionName);
    expect(container.textContent).not.toContain('Unavailable captures');

    // The parent may retain the request while navigation starts another scan.
    await render({ workspaceVisible: false });
    expect(analyzeNativeCapture).toHaveBeenCalledTimes(1);
    expect(props.onRequestedAnalysisRestored).toHaveBeenCalledTimes(1);
  });

  it('ignores a superseded scan and restores only the newest requested analysis', async () => {
    await render();
    const newer = { ...capture, path: '/saved/newer.log', sessionName: 'Newer capture' };
    storeAnalysisWorkspaces({ version: 1, activeId: null, workspaces: [workspace(), workspace(newer)] });
    const oldRefresh = deferred<SavedLog[]>();
    const newRefresh = deferred<SavedLog[]>();
    vi.mocked(listNativeSavedLogs).mockReturnValueOnce(oldRefresh.promise).mockReturnValueOnce(newRefresh.promise);
    await render({ requestedAnalysis: { id: capture.path, revision: 1 } });
    await render({ requestedAnalysis: { id: newer.path, revision: 2 } });
    await act(async () => oldRefresh.resolve([capture]));
    expect(analyzeNativeCapture).not.toHaveBeenCalled();
    expect(props.onRequestedAnalysisRestored).not.toHaveBeenCalled();
    await act(async () => newRefresh.resolve([newer]));
    expect(analyzeNativeCapture).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzeNativeCapture).mock.calls[0][1]).toEqual(newer);
    expect(props.onRequestedAnalysisRestored).toHaveBeenCalledTimes(1);
  });

  it('keeps the request pending when the refresh fails and allows a new request to retry', async () => {
    await render();
    storeAnalysisWorkspaces({ version: 1, activeId: null, workspaces: [workspace()] });
    vi.mocked(listNativeSavedLogs).mockRejectedValueOnce(new Error('Capture library is unavailable.'));
    await render({ requestedAnalysis: { id: capture.path, revision: 1 } });
    expect(props.onRequestedAnalysisRestored).not.toHaveBeenCalled();
    expect(analyzeNativeCapture).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Capture library is unavailable.');
    vi.mocked(listNativeSavedLogs).mockResolvedValueOnce([capture]);
    await render({ requestedAnalysis: { id: capture.path, revision: 2 } });
    expect(analyzeNativeCapture).toHaveBeenCalledTimes(1);
    expect(props.onRequestedAnalysisRestored).toHaveBeenCalledTimes(1);
  });

  it('does not let a late restore completion acknowledge a newer pending request', async () => {
    await render();
    const newer = { ...capture, path: '/saved/newer.log', sessionName: 'Newer capture' };
    storeAnalysisWorkspaces({ version: 1, activeId: null, workspaces: [workspace(), workspace(newer)] });
    const analyze = vi.mocked(analyzeNativeCapture).getMockImplementation()!;
    const oldAnalysis = deferred<Awaited<ReturnType<typeof analyzeNativeCapture>>>();
    vi.mocked(analyzeNativeCapture).mockReturnValueOnce(oldAnalysis.promise);
    vi.mocked(listNativeSavedLogs).mockResolvedValueOnce([capture]);
    await render({ requestedAnalysis: { id: capture.path, revision: 1 } });
    expect(analyzeNativeCapture).toHaveBeenCalledTimes(1);

    const refresh = deferred<SavedLog[]>();
    vi.mocked(listNativeSavedLogs).mockReturnValueOnce(refresh.promise);
    await render({ requestedAnalysis: { id: newer.path, revision: 2 } });
    await act(async () => oldAnalysis.resolve(await analyze('recorded:' + capture.path, capture)));
    expect(props.onRequestedAnalysisRestored).not.toHaveBeenCalled();
    await act(async () => refresh.resolve([newer]));
    expect(analyzeNativeCapture).toHaveBeenCalledTimes(2);
    expect(vi.mocked(analyzeNativeCapture).mock.calls[1][1]).toEqual(newer);
    expect(props.onRequestedAnalysisRestored).toHaveBeenCalledTimes(1);
  });
});
