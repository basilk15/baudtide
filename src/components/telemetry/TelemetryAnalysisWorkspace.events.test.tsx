// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryAnalysisWorkspace } from './TelemetryAnalysisWorkspace';
import { listNativeSavedLogs, type SavedLog } from '../../lib/serial/serial';
import { analyzeNativeCapture, CaptureAnalysisIndex } from '../../lib/captures/captureAnalysis';
import { readCaptureContext } from '../../lib/captures/captureContext';
import { TelemetrySessionStore } from '../../lib/telemetry/telemetry';
import { loadCaptureMarkers, saveCaptureMarker } from '../../lib/captures/captureEvents';
import type { TelemetryChartsProps } from './TelemetryECharts';

const charts = vi.hoisted(() => vi.fn<(props: TelemetryChartsProps) => null>(() => null));
const timestamp = '2026-10-13T12:00:10.000Z';
vi.mock('../../lib/serial/serial', async (original) => ({ ...await original<typeof import('../../lib/serial/serial')>(), listNativeSavedLogs: vi.fn() }));
vi.mock('../../lib/captures/captureAnalysis', async (original) => ({ ...await original<typeof import('../../lib/captures/captureAnalysis')>(), analyzeNativeCapture: vi.fn() }));
vi.mock('../../lib/captures/captureContext', () => ({ readCaptureContext: vi.fn() }));
vi.mock('./TelemetryECharts', () => ({ TelemetryCharts: charts }));
vi.mock('./TelemetryDecoderPanel', () => ({ TelemetryDecoderPanel: () => null }));
vi.mock('../../lib/telemetry/watchHistory', async (original) => ({ ...await original<typeof import('../../lib/telemetry/watchHistory')>(), WatchHistoryJournal: class {
  async latest() { return [{ sequence: 1, event: { id: 'breach', ruleId: 'rule', fieldKey: 'temperature', condition: 'above', threshold: 50,
    value: 90, timestamp: '2026-10-13T12:00:10.000Z', sessionKey: 'board', sourceName: 'Board', occurrence: 1, capturePath: '/saved/board.log' } }]; }
  async summary() { return { count: 1, through: 1 }; }
} }));
const log: SavedLog = { path: '/saved/board.log', fileName: 'board.log', sessionName: 'Board', modifiedAt: timestamp,
  startedAt: '2026-10-13T12:00:00Z', endedAt: '2026-10-13T12:00:30Z', metadataAvailable: true, sizeBytes: 1000, state: 'saved' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe('capture event workspace', () => {
  let container: HTMLDivElement; let root: Root; let indexes: CaptureAnalysisIndex[];
  beforeEach(() => {
    vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('matchMedia', () => ({ matches: true }));
    HTMLElement.prototype.scrollIntoView = vi.fn();
    localStorage.clear(); indexes = []; container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    vi.mocked(listNativeSavedLogs).mockResolvedValue([log]);
    vi.mocked(readCaptureContext).mockResolvedValue({ lines: [{ timestampMs: Date.parse(timestamp), text: 'fan started', shortened: false }], matched: 1, timingMode: 'recorded' });
    vi.mocked(analyzeNativeCapture).mockImplementation(async (sourceId) => {
      const pages = new Map<number, unknown>();
      const index = new CaptureAnalysisIndex({ async put(_id, page, value) { pages.set(page, value); },
        async get(_id, page) { return pages.get(page) as Awaited<ReturnType<import('../../lib/captures/captureAnalysis').CapturePageStore['get']>>; }, async release() {} });
      index.timingMode = 'recorded';
      const store = new TelemetrySessionStore();
      store.subscribeRecords(sourceId, (record) => { if (record.type === 'sample') index.append(record.sample); });
      for (let second = 0; second <= 30; second++) {
        const text = JSON.stringify({ temperature: second === 10 ? 90 : 20, voltage: 3.3 }) + '\n';
        store.ingestOrderedSerialEvent(sourceId, { sessionId: sourceId, port: 'saved', sequence: second + 1,
          timestamp: new Date(Date.parse(log.startedAt!) + second * 1000).toISOString(), text, bytes: [...new TextEncoder().encode(text)] });
      }
      await index.flush(true); index.metadata = store.getSnapshot(sourceId); indexes.push(index);
      return { index, snapshot: (await index.query()).snapshot };
    });
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render() { await act(async () => root.render(<TelemetryAnalysisWorkspace nativeEnabled workspaceVisible sessions={[]} selectedSessionId={null} onSelectSession={() => {}} onRequestConnection={() => {}} />)); }
  function button(text: string) { return [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === text)!; }
  async function click(text: string) { expect(button(text)).toBeDefined(); await act(async () => button(text).click()); }
  async function input(selector: string, value: string) { await act(async () => {
    const element = container.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }); }
  async function inspect() { await render(); await click('Watch signals'); await click('Inspect breach'); }

  it('offers saved captures directly in comparison before adding them to analysis', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="baseline capture"]')!.click());
    const options = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toContain('Board');
    await act(async () => options.find((option) => option.textContent === 'Board')!.click());
    expect(analyzeNativeCapture).toHaveBeenCalledWith(expect.any(String), log, expect.any(Object));
    expect(container.querySelector('[aria-label="baseline signal"]')?.textContent).toContain('temperature');
  });

  it('opens a notification on the first mount through StrictMode effect replay', async () => {
    const handled = vi.fn();
    await act(async () => root.render(<StrictMode><TelemetryAnalysisWorkspace nativeEnabled workspaceVisible sessions={[]} selectedSessionId={null}
      onSelectSession={() => {}} onRequestConnection={() => {}} onRequestedEventHandled={handled}
      requestedEvent={{ revision: 1, event: { id: 'log-event', kind: 'log', capturePath: log.path, timestamp, sourceName: 'Board', label: 'Panic', note: 'panic in task' } }} /></StrictMode>));
    expect(handled).toHaveBeenCalledOnce();
    expect(readCaptureContext).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-label="Serial output around event"]')?.textContent).toContain('fan started');
    expect(container.querySelector('.bt-event-loading')).toBeNull();
  });

  it('opens a breach at its exact time, selects the breached signal and aligns its chart marker', async () => {
    await inspect();
    expect(readCaptureContext).toHaveBeenCalledWith(log, { start: Date.parse(timestamp) - 10000, end: Date.parse(timestamp) + 10000 }, Date.parse(timestamp), expect.any(AbortSignal));
    expect(container.querySelector('[aria-label="Serial output around event"]')?.textContent).toContain('fan started');
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' });
    expect(document.activeElement?.id).toBe('event-inspection-heading');
    const props = charts.mock.calls[charts.mock.calls.length - 1][0];
    expect(props.selectedFieldKeys).toEqual(['Board · temperature']);
    expect(props.markers).toEqual([expect.objectContaining({ id: 'breach', kind: 'breach', timestampMs: Date.UTC(2000, 0, 1) + 10000, selected: true })]);
    expect(props.samples.every((sample) => Date.parse(sample.timestamp) <= Date.UTC(2000, 0, 1) + 20000)).toBe(true);
    await input('.bt-event-window label:first-child input', '2'); await input('.bt-event-window label:nth-child(2) input', '3');
    await click('Apply window');
    expect(readCaptureContext).toHaveBeenLastCalledWith(log, { start: Date.parse(timestamp) - 2000, end: Date.parse(timestamp) + 3000 }, Date.parse(timestamp), expect.any(AbortSignal));
    expect(charts.mock.calls[charts.mock.calls.length - 1][0].samples.every((sample) => Date.parse(sample.timestamp) >= Date.UTC(2000, 0, 1) + 8000)).toBe(true);
  });
  it('keeps a missing-capture error visible with a retryable window', async () => {
    await render(); await click('Watch signals'); vi.mocked(listNativeSavedLogs).mockResolvedValueOnce([]); await click('Inspect breach');
    expect(container.textContent).toContain('The linked capture is unavailable');
    expect(analyzeNativeCapture).not.toHaveBeenCalled();
    await click('Apply window'); expect(container.textContent).toContain('fan started');
  });
  it('persists a manual marker and restores its title and note after remount', async () => {
    await inspect(); await click('Add marker');
    await input('input[placeholder="e.g. Motor started"]', 'Motor started');
    await act(async () => container.querySelector('form#capture-marker-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(loadCaptureMarkers()).toEqual([expect.objectContaining({ label: 'Motor started', timestamp, capturePath: log.path })]);
    const saved = loadCaptureMarkers()[0]; saveCaptureMarker({ ...saved, note: 'Changed power supply' });
    await act(async () => root.unmount()); root = createRoot(container); await inspect();
    expect(container.querySelector('.bt-event-list')?.textContent).toContain('Motor started');
    expect(container.querySelector('.bt-event-list')?.textContent).toContain('Changed power supply');
  });
  it('cancels context on close and ignores a late result', async () => {
    const context = deferred<Awaited<ReturnType<typeof readCaptureContext>>>(); vi.mocked(readCaptureContext).mockReturnValue(context.promise);
    await inspect();
    const signal = vi.mocked(readCaptureContext).mock.calls[0][3]!;
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close event inspection"]')!.click());
    expect(signal.aborted).toBe(true);
    await act(async () => context.resolve({ lines: [], matched: 0, timingMode: 'recorded' }));
    expect(container.querySelector('.bt-event-inspection')).toBeNull();
  });
});
