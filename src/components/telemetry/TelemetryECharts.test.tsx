// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TelemetryCharts } from './TelemetryECharts';
import type { TelemetrySample } from '../../lib/telemetry/telemetry';

const chart = vi.hoisted(() => ({ setOption: vi.fn(), on: vi.fn(), off: vi.fn(), resize: vi.fn(), dispose: vi.fn(), dispatchAction: vi.fn() }));
vi.mock('echarts/core', async (original) => ({ ...await original<typeof import('echarts/core')>(), init: () => chart }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('coalesces live snapshots per frame, preserves spikes and gaps, and cancels pending work on unmount', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)); };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const start = 1700000000000;
  const samples: TelemetrySample[] = [24, 80, 25].map((value, index) => ({ id: String(index), timestamp: new Date(start + index * 1000).toISOString(), nativeSessionId: 'test', sequence: index, format: 'json', schemaId: 'test', values: { temperature: { value } } }));
  const render = (count: number) => root.render(<TelemetryCharts samples={samples.slice(0, count)} fields={[{ key: 'temperature', formats: ['json'] }]} gaps={[{ id: 'gap', type: 'reconnect', timestamp: new Date(start + 1500).toISOString(), previousNativeSessionId: 'old', nextNativeSessionId: 'test', nextSequence: 2 }]} selectedFieldKeys={['temperature']} windowMs={0} paused={false} />);
  try {
    await act(async () => render(1));
    flush(); chart.setOption.mockClear();
    await act(async () => render(2));
    await act(async () => render(3));
    expect(chart.setOption).not.toHaveBeenCalled();
    flush();
    expect(chart.setOption).toHaveBeenCalledTimes(1);
    const line = chart.setOption.mock.calls[0][0].series[0];
    expect(line.data).toEqual([[start, 24], [start + 1000, 80], [start + 1500 - 0.001, null], [start + 2000, 25]]);
    expect(line.connectNulls).toBe(false);
    expect(line.smooth).toBe(false);
    await act(async () => render(2));
    expect(frames.size).toBeGreaterThan(0);
  } finally { await act(async () => root.unmount()); container.remove(); }
  expect(frames.size).toBe(0);
});

it('enables ordinary wheel zoom and preserves the range navigator', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    const samples: TelemetrySample[] = Array.from({ length: 100 }, (_, second) => ({ id: String(second), timestamp: new Date(1700000000000 + second * 1000).toISOString(), nativeSessionId: 'test', sequence: second, format: 'json', schemaId: 'test', values: { temperature: { value: second } } }));
    await act(async () => root.render(<TelemetryCharts samples={samples} fields={[{ key: 'temperature', formats: ['json'] }]} gaps={[]} selectedFieldKeys={['temperature']} windowMs={0} paused />));
    const option = chart.setOption.mock.calls[chart.setOption.mock.calls.length - 1][0];
    expect(option.dataZoom).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'inside', zoomOnMouseWheel: true, moveOnMouseWheel: false }),
      expect.objectContaining({ type: 'slider' }),
    ]));
    const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    container.querySelector('.bt-telemetry-echarts')!.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    container.querySelector('.bt-telemetry-echarts')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(chart.dispatchAction).toHaveBeenCalledWith({ type: 'dataZoom', start: 0, end: 100 });
  } finally { await act(async () => root.unmount()); container.remove(); }
});
