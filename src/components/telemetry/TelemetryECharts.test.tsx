// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TelemetryCharts } from './TelemetryECharts';
import type { TelemetrySample } from '../../lib/telemetry/telemetry';

const chart = vi.hoisted(() => ({ setOption: vi.fn(), on: vi.fn(), off: vi.fn(), resize: vi.fn(), dispose: vi.fn(), dispatchAction: vi.fn() }));
vi.mock('echarts/core', async (original) => ({ ...await original<typeof import('echarts/core')>(), init: () => chart }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

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
