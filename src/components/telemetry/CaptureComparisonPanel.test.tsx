// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureComparisonPanel, type ComparisonSource } from './CaptureComparisonPanel';
import { CaptureAnalysisIndex, type CapturePageStore } from '../../lib/captures/captureAnalysis';
import { TelemetrySessionStore } from '../../lib/telemetry/telemetry';
import { normalizeAnalysisWorkspace } from '../../lib/workspaces/analysisWorkspaces';
import type { CaptureComparisonSettings } from '../../lib/captures/captureComparison';
import type { TelemetryChartsProps } from './TelemetryECharts';
const exportsApi = vi.hoisted(() => ({ begin: vi.fn(), append: vi.fn(), finish: vi.fn(), cancel: vi.fn() }));
vi.mock('../../lib/serial/serial', async (original) => ({ ...await original<typeof import('../../lib/serial/serial')>(), beginNativeTelemetryExport: exportsApi.begin, appendNativeTelemetryExport: exportsApi.append, finishNativeTelemetryExport: exportsApi.finish, cancelNativeTelemetryExport: exportsApi.cancel }));
const chart = vi.hoisted(() => vi.fn<(props: TelemetryChartsProps) => null>(() => null));
vi.mock('./TelemetryECharts', () => ({ TelemetryCharts: chart }));

const config: CaptureComparisonSettings = { baselinePath: '/a.log', candidatePath: '/b.log', baselineField: 'temperature', candidateField: 'temperature',
  baselineEvent: 'a-event', candidateEvent: 'b-event', startSeconds: -1, endSeconds: 1 };
const time = Date.parse('2026-10-18T10:00:00Z');
const events = ['a', 'b'].map((id) => ({ id: `${id}-event`, kind: 'note' as const, capturePath: `/${id}.log`, sourceName: id, timestamp: new Date(time + 1000).toISOString(), label: 'Test started', note: '' }));
async function source(name: string, values: number[]): Promise<ComparisonSource> {
  const pages = new Map<number, Parameters<CapturePageStore['put']>[2]>();
  const index = new CaptureAnalysisIndex({ async put(_id, page, value) { pages.set(page, value); }, async get(_id, page) { return pages.get(page)!; }, async release() {} });
  const store = new TelemetrySessionStore();
  store.subscribeRecords(name, (record) => { if (record.type === 'sample') index.append(record.sample); });
  for (const [second, value] of values.entries()) {
    const text = JSON.stringify({ temperature: value }) + '\n';
    store.ingestOrderedSerialEvent(name, { sessionId: name, port: 'test', sequence: second + 1, timestamp: new Date(time + second * 1000).toISOString(), text, bytes: [...new TextEncoder().encode(text)] });
  }
  await index.flush(true); index.metadata = store.getSnapshot(name); index.timingMode = 'recorded';
  return { name, path: `/${name}.log`, index, selection: index.range, fields: index.metadata.fields, gaps: [], captureState: 'saved', indexedState: 'saved' };
}
describe('run comparison controls and persistence', () => {
  let root: Root; let container: HTMLDivElement; let sources: ComparisonSource[];
  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); chart.mockClear(); Object.values(exportsApi).forEach((fn) => fn.mockReset());
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    sources = await Promise.all([source('a', [10, 20, 30]), source('b', [20, 40, 60])]);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render(settings = config) { await act(async () => root.render(<CaptureComparisonPanel sources={sources} events={events} settings={settings} onChange={() => {}} visible busy={false} nativeEnabled={false} />)); }
  async function compare() { await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Compare interval')!.click()); }
  it('compares event-aligned intervals and plots original values on signed time', async () => {
    await render(); await compare();
    const mean = [...container.querySelectorAll('tr')].find((row) => row.textContent?.startsWith('Mean'))!;
    expect([...mean.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['20', '40', '+20', '+100%']);
    const props = chart.mock.calls[chart.mock.calls.length - 1][0];
    expect(props.absoluteOverlay).toBe(true); expect(props.timeline).toMatchObject({ kind: 'elapsed', signed: true });
    expect(props.samples.map((sample) => Object.values(sample.values)[0].value)).toContain(60);
    expect(Date.parse(props.samples[0].timestamp)).toBe(Date.UTC(2000, 0, 1) - 1000);
    await render({ ...config, endSeconds: 2 });
    expect(container.querySelector('[aria-label="Comparison statistics"]')).toBeNull();
  });
  it('rejects missing alignment events instead of silently aligning to the start', async () => {
    await render({ ...config, baselineEvent: 'missing' }); await compare();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('alignment event is unavailable');
    expect(container.querySelector('[aria-label="Comparison statistics"]')).toBeNull();
  });
  it('keeps both edited interval bounds when they cross the previous interval', async () => {
    function Panel() {
      const [settings, setSettings] = useState({ ...config, startSeconds: 0, endSeconds: 60 });
      return <CaptureComparisonPanel sources={sources} events={events} settings={settings} onChange={setSettings} visible busy={false} nativeEnabled={false} />;
    }
    await act(async () => root.render(<Panel />));
    const [from, to] = container.querySelectorAll<HTMLInputElement>('.bt-comparison-window input');
    const fill = async (element: HTMLInputElement, value: string) => { await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    }); };
    await fill(from, '100'); await fill(to, '120');
    expect([from.value, to.value]).toEqual(['100', '120']);
  });
  it('shows a retryable error if a library capture cannot be loaded', async () => {
    const load = vi.fn().mockRejectedValue(new Error('Capture is unreadable.'));
    await act(async () => root.render(<CaptureComparisonPanel sources={[]} captures={[{ path: '/a.log', name: 'A' }]} onLoadCapture={load}
      events={[]} onChange={() => {}} visible busy={false} nativeEnabled />));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="baseline capture"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[role="option"]')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Capture is unreadable.');
    expect(container.querySelector<HTMLButtonElement>('[aria-label="baseline capture"]')!.disabled).toBe(false);
    expect(container.querySelector('[aria-label="baseline signal"]')?.textContent).toContain('Choose a signal');
  });
  it('persists valid comparison settings without altering legacy analysis workspaces', () => {
    const workspace = { id: 'analysis', name: 'Comparison', updatedAt: 1, sources: [], watches: [], alignment: 'elapsed', chartMode: 'compare', windowMs: 0, replayRate: 1 };
    expect(normalizeAnalysisWorkspace(workspace)).toEqual(workspace);
    expect(normalizeAnalysisWorkspace({ ...workspace, comparison: config })?.comparison).toEqual(config);
    expect(normalizeAnalysisWorkspace({ ...workspace, comparison: { ...config, startSeconds: NaN } })).toBeNull();
  });
  it('evaluates full-history acceptance checks and invalidates a stale comparison', async () => {
    const checkSet = { binding: { baselineField: 'temperature', candidateField: 'temperature', unit: '' }, checks: [
      { id: 'mean', metric: 'mean' as const, measure: 'candidate' as const, operator: 'lte' as const, limit: 40 },
      { id: 'change', metric: 'mean' as const, measure: 'percent' as const, operator: 'lte' as const, limit: 10 },
    ] };
    await render({ ...config, checkSet }); await compare();
    expect(container.textContent).toContain('Observed 40 no unit · Pass');
    expect(container.textContent).toContain('Observed +100 % · Fail');
    await render({ ...config, endSeconds: 2, checkSet });
    expect(container.textContent).not.toContain('Observed +100');
  });

  it('keeps a malformed gap inconclusive instead of crashing the plot', async () => {
    sources[0] = { ...sources[0], gaps: [{ id: 'bad', type: 'reconnect', timestamp: 'invalid', previousNativeSessionId: 'a', nextNativeSessionId: 'b', nextSequence: 1 }] };
    const checkSet = { binding: { baselineField: 'temperature', candidateField: 'temperature', unit: '' }, checks: [{ id: 'mean', metric: 'mean' as const, measure: 'candidate' as const, operator: 'lte' as const, limit: 40 }] };
    await render({ ...config, checkSet }); await compare();
    expect(container.textContent).toContain('Inconclusive');
    expect(container.textContent).toContain('gap');
  });
  it('does not resurrect a previous result after settings change and change back', async () => {
    await render(); await compare();
    expect(container.querySelector('[aria-label="Comparison statistics"]')).not.toBeNull();
    await render({ ...config, endSeconds: 2 });
    await render(config);
    expect(container.querySelector('[aria-label="Comparison statistics"]')).toBeNull();
  });

  it('reopens a stopped capture without changing its signal or alignment', async () => {
    sources[0] = { ...sources[0], indexedState: 'capturing', captureState: 'disconnected' };
    const onChange = vi.fn(); const reopened = { ...sources[0], indexedState: 'disconnected' as const };
    await act(async () => root.render(<CaptureComparisonPanel sources={sources} events={events} settings={config} onChange={onChange} onLoadCapture={async () => reopened} visible busy={false} nativeEnabled />));
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Reopen capture')!.click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('cancels a pending export if comparison inputs change before the dialog returns', async () => {
    let release!: (id: string) => void;
    exportsApi.begin.mockReturnValue(new Promise<string>((resolve) => { release = resolve; }));
    exportsApi.cancel.mockResolvedValue(undefined); exportsApi.append.mockResolvedValue(undefined); exportsApi.finish.mockResolvedValue('/report.csv');
    const draw = async (settings: typeof config) => act(async () => root.render(<CaptureComparisonPanel sources={sources} events={events} settings={settings} onChange={() => {}} visible busy={false} nativeEnabled />));
    await draw(config); await compare();
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save summary')!.click(); });
    await draw({ ...config, endSeconds: 2 });
    await act(async () => release('export-1'));
    expect(exportsApi.cancel).toHaveBeenCalledWith('export-1');
    expect(exportsApi.finish).not.toHaveBeenCalled();
  });

  it('cancels an export when its comparison changes while data is being written', async () => {
    let finishAppend!: () => void;
    exportsApi.begin.mockResolvedValue('export-2');
    exportsApi.append.mockReturnValue(new Promise<void>((resolve) => { finishAppend = resolve; }));
    exportsApi.cancel.mockResolvedValue(undefined); exportsApi.finish.mockResolvedValue('/report.csv');
    const draw = async (settings: typeof config) => act(async () => root.render(<CaptureComparisonPanel sources={sources} events={events} settings={settings} onChange={() => {}} visible busy={false} nativeEnabled />));
    await draw(config); await compare();
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save summary')!.click(); });
    await draw({ ...config, endSeconds: 2 });
    await act(async () => finishAppend());
    expect(exportsApi.cancel).toHaveBeenCalledWith('export-2');
    expect(exportsApi.finish).not.toHaveBeenCalled();
  });

});
