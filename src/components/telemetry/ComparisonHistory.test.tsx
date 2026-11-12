// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComparisonHistory } from './ComparisonHistory';
import { evaluateChecks, type ComparisonCheck } from '../../lib/captures/comparisonChecks';
import type { ComparisonHistoryRecord } from '../../lib/captures/comparisonHistory';

const api = vi.hoisted(() => ({ begin: vi.fn(), append: vi.fn(), finish: vi.fn(), cancel: vi.fn() }));
vi.mock('../../lib/serial/serial', async (original) => ({ ...await original<typeof import('../../lib/serial/serial')>(), beginNativeTelemetryExport: api.begin, appendNativeTelemetryExport: api.append, finishNativeTelemetryExport: api.finish, cancelNativeTelemetryExport: api.cancel }));
const stats = (value: number) => ({ count: 2, min: value, max: value, mean: value, deviation: 0, skippedUnits: 0 });
const check: ComparisonCheck = { id: 'c', metric: 'mean', measure: 'percent', operator: 'lte', limit: 10 };
const side = (name: string, value: number) => ({ name, field: 'temperature', anchorMs: 1000, requested: { start: 1000, end: 2000 }, effective: { start: 1000, end: 2000 }, state: 'saved' as const, timingMode: 'recorded' as const, statistics: stats(value) });
const record: ComparisonHistoryRecord = { id: 'one', savedAt: '2026-11-12T07:00:00.000Z', baselinePath: '/a', candidatePath: '/b', snapshot: { baseline: side('A', 20), candidate: side('B', 24), unit: 'C', startSeconds: 0, endSeconds: 1, evaluation: evaluateChecks([check], stats(20), stats(24), []) } };
let container: HTMLDivElement;
afterEach(() => { container?.remove(); vi.unstubAllGlobals(); Object.values(api).forEach((fn) => fn.mockReset()); });
describe('historical comparison results', () => {
  it('shows saved evidence without needing a capture and confirms removal', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); const root = createRoot(container); const remove = vi.fn(() => true);
    await act(async () => root.render(<ComparisonHistory records={[record]} error="" nativeEnabled onRemove={remove} onRetry={() => {}} />));
    expect(container.textContent).toContain('Historical'); expect(container.textContent).toContain('Fail');
    await act(async () => container.querySelector('summary')!.click());
    expect(container.textContent).toContain('/a'); expect(container.textContent).toContain('20'); expect(container.textContent).toContain('24'); expect(container.textContent).toContain('10');
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!.click());
    expect(remove).not.toHaveBeenCalled(); expect(document.activeElement?.textContent).toBe('Confirm removal');
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click());
    expect(remove).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Confirm removal')!.click());
    expect(remove).toHaveBeenCalledWith('one');
    await act(async () => root.unmount());
  });
  it('exports the retained snapshot and cancels a failed stream', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    api.begin.mockResolvedValue('stream'); api.append.mockResolvedValue(undefined); api.finish.mockResolvedValue('/summary.csv'); api.cancel.mockResolvedValue(undefined);
    await act(async () => root.render(<ComparisonHistory records={[record]} error="" nativeEnabled onRemove={() => true} onRetry={() => {}} />));
    await act(async () => container.querySelector('summary')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Export CSV')!.click());
    expect(api.append.mock.calls[0][1]).toContain('"mean","percent","lte","10","20","%","fail"');
    expect(container.textContent).toContain('/summary.csv');
    api.append.mockRejectedValueOnce(new Error('Disk full'));
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Export CSV')!.click());
    expect(api.cancel).toHaveBeenCalledWith('stream'); expect(container.textContent).toContain('Disk full');
    await act(async () => root.unmount());
  });
  it('offers a retry when history is unreadable', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); const root = createRoot(container); const retry = vi.fn();
    await act(async () => root.render(<ComparisonHistory records={[]} error="History unavailable" nativeEnabled={false} onRemove={() => false} onRetry={retry} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('History unavailable');
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!.click());
    expect(retry).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });

  it('gives repeated source pairs distinct accessible action names', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    await act(async () => root.render(<ComparisonHistory records={[record, { ...record, id: 'two' }]} error="" nativeEnabled onRemove={() => true} onRetry={() => {}} />));
    await act(async () => container.querySelectorAll('summary')[0].click());
    const entries = container.querySelectorAll<HTMLDetailsElement>('.bt-history-entry');
    await act(async () => entries[1].querySelector('summary')!.click());
    const exports = [...container.querySelectorAll('button')].filter((button) => button.textContent === 'Export CSV');
    expect(exports[0].getAttribute('aria-label')).not.toBe(exports[1].getAttribute('aria-label'));
    await act(async () => root.unmount());
  });

  it('cancels an export whose dialog returns after the history closes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    let release!: (id: string) => void; api.begin.mockReturnValue(new Promise<string>((resolve) => { release = resolve; })); api.cancel.mockResolvedValue(undefined);
    await act(async () => root.render(<ComparisonHistory records={[record]} error="" nativeEnabled onRemove={() => true} onRetry={() => {}} />));
    await act(async () => container.querySelector('summary')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Export CSV')!.click());
    await act(async () => root.unmount());
    await act(async () => release('stream'));
    expect(api.cancel).toHaveBeenCalledWith('stream'); expect(api.finish).not.toHaveBeenCalled();
  });

  it('keeps the removal confirmation open when storage refuses deletion', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    await act(async () => root.render(<ComparisonHistory records={[record]} error="" nativeEnabled onRemove={() => false} onRetry={() => {}} />));
    await act(async () => container.querySelector('summary')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Confirm removal')!.click());
    expect(container.querySelector('[aria-label="Confirm result removal"]')).not.toBeNull();
    expect(container.querySelectorAll('.bt-history-entry')).toHaveLength(1);
    await act(async () => root.unmount());
  });

});
