// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryAnalysisWorkspace } from './TelemetryAnalysisWorkspace';
import { putDesktopWatch, removeDesktopWatches, setDesktopWatchDecoder, watchSnapshot, type WatchSnapshot } from '../lib/desktopWatches';
import { listenDesktop } from '../lib/desktop';
import { storeAnalysisWorkspaces, type SavedAnalysisWorkspace } from '../lib/analysisWorkspaces';
import { liveTelemetryStore } from '../lib/telemetry';
import type { TelemetryDecoderProfile } from '../lib/telemetryDecoders';

const renderDecoderPanel = vi.hoisted(() => vi.fn<(props: {
  onApply: (sourceId: string, profile?: TelemetryDecoderProfile) => void;
}) => null>(() => null));
vi.mock('../lib/desktop', () => ({ isDesktopRuntime: () => true, listenDesktop: vi.fn(() => () => {}) }));
vi.mock('../lib/desktopWatches', () => ({ watchSnapshot: vi.fn(), putDesktopWatch: vi.fn(),
  removeDesktopWatches: vi.fn(), setDesktopWatchDecoder: vi.fn(), nativeWatchHistory: {} }));
vi.mock('../lib/serial', async (original) => ({ ...await original<typeof import('../lib/serial')>(), listNativeSavedLogs: async () => [] }));
vi.mock('./TelemetryECharts', () => ({ TelemetryCharts: () => null }));
vi.mock('./TelemetryDecoderPanel', () => ({ TelemetryDecoderPanel: renderDecoderPanel }));
vi.mock('../lib/watchHistory', () => ({ WatchHistoryJournal: class {
  async latest() { return []; }
  async summary() { return { count: 0, through: 0 }; }
} }));

const identity = 'serial:%2Fdev%2FttyTEST:115200:8:none:one:none';
const decoder: TelemetryDecoderProfile = { version: 1, id: 'armed-decoder', name: 'Armed decoder', prefix: 'DATA',
  separator: 'comma', fields: [{ column: 1, name: 'temperature' }], createdAt: 1, updatedAt: 1 };
const workspace: SavedAnalysisWorkspace = { id: 'analysis', name: 'Saved analysis', updatedAt: 1,
  alignment: 'elapsed', chartMode: 'compare', windowMs: 0, replayRate: 1,
  sources: [{ key: 'board', kind: 'live', target: identity, name: 'Board', selectedFields: [],
    decoder: { ...decoder, id: 'old-decoder', name: 'Older decoder', prefix: 'OLD' } }],
  watches: [{ sourceKey: 'board', fieldKey: 'temperature', enabled: true, condition: 'above', threshold: 50 }] };

describe('desktop watch reattachment', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    window.localStorage.clear();
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    liveTelemetryStore.removeSession('watch-ui-test'); vi.unstubAllGlobals();
  });
  async function render(connected = true) {
    await act(async () => root.render(<TelemetryAnalysisWorkspace nativeEnabled workspaceVisible
      sessions={connected ? [{ id: 'native', uiKey: 'watch-ui-test', identity, sessionName: 'Board', port: '/dev/ttyTEST', connectionState: 'connected' }] : []}
      selectedSessionId={null} onSelectSession={() => {}} onRequestConnection={() => {}} />));
  }

  it('waits for worker configuration and keeps the armed decoder when restoring an older analysis', async () => {
    storeAnalysisWorkspaces({ version: 1, activeId: workspace.id, workspaces: [workspace] });
    let resolve!: (snapshot: WatchSnapshot) => void;
    vi.mocked(watchSnapshot).mockReturnValue(new Promise((done) => { resolve = done; }));
    await render();
    expect(putDesktopWatch).not.toHaveBeenCalled();
    expect(liveTelemetryStore.getSnapshot('watch-ui-test').decoderProfile).toBeUndefined();
    await act(async () => resolve({ historyCount: 1, historyError: '', interruption: '', watches: [{
      rule: { id: 'armed', sessionKey: identity, fieldKey: 'temperature', enabled: true, condition: 'above', threshold: 50 },
      decoder, sourceName: 'Board', nativeSessionId: 'native', breached: false, pending: false, occurrence: 1,
    }] }));
    expect(liveTelemetryStore.getSnapshot('watch-ui-test').decoderProfile?.id).toBe(decoder.id);
    expect(putDesktopWatch).toHaveBeenCalledOnce();
    expect(vi.mocked(putDesktopWatch).mock.calls[0][0].decoder?.id).toBe(decoder.id);
    expect(container.textContent).toContain('1 armed');
  });

  it('keeps retry accessible when the monitor fails before any signals or history exist', async () => {
    vi.mocked(watchSnapshot).mockRejectedValueOnce(new Error('Monitor unavailable'));
    await render(false);
    const toggle = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Watch signals');
    expect(toggle).toBeDefined();
    await act(async () => toggle!.click());
    expect(container.textContent).toContain('Monitor unavailable');
    vi.mocked(watchSnapshot).mockResolvedValue({ watches: [], historyCount: 0, historyError: '', interruption: '' });
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry monitoring');
    await act(async () => retry!.click());
    expect(container.textContent).not.toContain('Monitor unavailable');
    expect(watchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('restores an analysis without watches and allows chart decoding when monitoring fails', async () => {
    storeAnalysisWorkspaces({ version: 1, activeId: workspace.id, workspaces: [{ ...workspace, watches: [] }] });
    vi.mocked(watchSnapshot).mockRejectedValue(new Error('Monitor unavailable'));
    vi.mocked(setDesktopWatchDecoder).mockRejectedValue(new Error('Monitor unavailable'));
    await render();
    expect(container.textContent).not.toContain('Waiting for saved devices: Board');
    expect(container.querySelector('[role="tab"]')?.textContent).toContain('/dev/ttyTEST');
    expect(liveTelemetryStore.getSnapshot('watch-ui-test').decoderProfile?.id).toBe('old-decoder');
    await act(async () => renderDecoderPanel.mock.calls[renderDecoderPanel.mock.calls.length - 1][0].onApply('live:watch-ui-test', decoder));
    expect(liveTelemetryStore.getSnapshot('watch-ui-test').decoderProfile?.id).toBe(decoder.id);
    expect(setDesktopWatchDecoder).not.toHaveBeenCalled();
    expect(putDesktopWatch).not.toHaveBeenCalled();
  });

  it('keeps a rejected watch removal visible across healthy snapshots until a successful retry', async () => {
    const snapshot: WatchSnapshot = { historyCount: 0, historyError: '', interruption: '', watches: [{
      rule: { id: 'armed', sessionKey: identity, fieldKey: 'temperature', enabled: true, condition: 'above', threshold: 50 },
      sourceName: 'Board', nativeSessionId: 'native', breached: false, pending: false, occurrence: 0,
    }] };
    vi.mocked(watchSnapshot).mockResolvedValue(snapshot);
    await render();
    const toggle = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Watches · 1');
    await act(async () => toggle!.click());
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove watch for temperature"]');
    vi.mocked(removeDesktopWatches).mockRejectedValueOnce(new Error('Watch configuration could not be saved'));
    await act(async () => remove!.click());
    const receiveState = vi.mocked(listenDesktop).mock.calls.find(([name]) => name === 'watch-state')![1];
    await act(async () => receiveState(snapshot));
    expect(container.textContent).toContain('Watch configuration could not be saved');
    expect(container.querySelector('[aria-label="Remove watch for temperature"]')).not.toBeNull();
    vi.mocked(removeDesktopWatches).mockResolvedValue();
    vi.mocked(watchSnapshot).mockResolvedValue({ ...snapshot, watches: [] });
    await act(async () => remove!.click());
    expect(container.textContent).not.toContain('Watch configuration could not be saved');
    expect(container.querySelector('[aria-label="Remove watch for temperature"]')).toBeNull();
  });
});
