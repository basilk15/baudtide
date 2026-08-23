import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  AxisPointerComponent,
  DataZoomComponent,
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import type { ECharts, EChartsCoreOption as EChartsOption } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import type { TelemetryField, TelemetryGap, TelemetrySample } from '../lib/telemetry';
import {
  alignTelemetryChartData,
  formatTelemetryValue,
  prepareTelemetryCharts,
  TELEMETRY_SERIES_COLORS,
  telemetryYDomain,
} from '../lib/telemetryChart';
import './telemetry-charts.css';

echarts.use([
  AxisPointerComponent,
  CanvasRenderer,
  DataZoomComponent,
  GridComponent,
  LineChart,
  MarkLineComponent,
  TooltipComponent,
]);

export type TelemetryChartsProps = {
  samples: readonly TelemetrySample[];
  fields: readonly TelemetryField[];
  gaps: readonly TelemetryGap[];
  selectedFieldKeys: readonly string[];
  windowMs: number;
  paused: boolean;
};

type TooltipItem = {
  axisValue?: number;
  color?: string;
  seriesName?: string;
  value?: unknown;
};

type AxisPointerLabelParams = {
  value: string | number | Date;
};

function readableFieldName(key: string) {
  return key.replace(/[._-]+/gu, ' ');
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] ?? character);
}

function formatChartTime(timestamp: number) {
  const date = new Date(timestamp);
  const base = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
  return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function colorForField(fields: readonly TelemetryField[], fieldKey: string) {
  const index = fields.findIndex((field) => field.key === fieldKey);
  return TELEMETRY_SERIES_COLORS[(index < 0 ? 0 : index) % TELEMETRY_SERIES_COLORS.length];
}

function axisGutter(seriesCount: number) {
  return 58 + Math.max(0, Math.ceil(seriesCount / 2) - 1) * 42;
}

function chartOption({
  fields,
  series,
  aligned,
  gaps,
  startMs,
  endMs,
  isLight,
}: {
  fields: readonly TelemetryField[];
  series: readonly ReturnType<typeof prepareTelemetryCharts>['groups'][number]['series'][number][];
  aligned: ReturnType<typeof alignTelemetryChartData>;
  gaps: readonly { timestampMs: number }[];
  startMs?: number;
  endMs?: number;
  isLight: boolean;
}): EChartsOption {
  const palette = isLight ? {
    axis: 'rgba(55, 81, 99, 0.3)',
    grid: 'rgba(55, 81, 99, 0.13)',
    muted: '#6c8190',
    pointer: '#234959',
    pointerLabel: '#eff8f8',
    navigatorTrack: 'rgba(55, 81, 99, 0.07)',
    navigatorFill: 'rgba(61, 146, 125, 0.16)',
    navigatorLine: 'rgba(55, 81, 99, 0.28)',
    navigatorHandle: '#3b967f',
    tooltipBackground: '#ffffff',
    tooltipBorder: '#c8d5dc',
    tooltipText: '#193140',
  } : {
    axis: 'rgba(122, 154, 171, 0.32)',
    grid: 'rgba(122, 154, 171, 0.14)',
    muted: '#7f98a7',
    pointer: '#dce8ec',
    pointerLabel: '#edf7f8',
    navigatorTrack: 'rgba(122, 154, 171, 0.08)',
    navigatorFill: 'rgba(112, 216, 189, 0.14)',
    navigatorLine: 'rgba(122, 154, 171, 0.3)',
    navigatorHandle: '#70d8bd',
    tooltipBackground: '#10242d',
    tooltipBorder: '#31515e',
    tooltipText: '#eaf5f6',
  };
  const seriesCount = series.length;
  const gutter = axisGutter(seriesCount);
  const chartStartMs = startMs ?? (aligned.timestamps[0] === undefined ? undefined : aligned.timestamps[0] * 1_000);
  const chartEndMs = Math.max(
    endMs ?? Number.NEGATIVE_INFINITY,
    aligned.timestamps.length ? aligned.timestamps[aligned.timestamps.length - 1] * 1_000 : Number.NEGATIVE_INFINITY,
  );
  const hasZoom = aligned.timestamps.length > 80;
  const showPointSymbols = aligned.timestamps.length <= 400;

  const yAxis = series.map((currentSeries, index) => {
    const domain = telemetryYDomain(currentSeries.points) ?? { min: 0, max: 1 };
    const position = index % 2 === 0 ? 'left' : 'right';
    const color = colorForField(fields, currentSeries.key);
    return {
      type: 'value' as const,
      min: domain.min,
      max: domain.max,
      scale: true,
      position,
      offset: Math.floor(index / 2) * 42,
      axisLine: { show: true, lineStyle: { color, width: 1 } },
      axisTick: { show: false },
      axisLabel: {
        color,
        fontFamily: '"DM Mono", ui-monospace, monospace',
        fontSize: 10,
        margin: 8,
        hideOverlap: true,
        formatter: (value: number) => formatTelemetryValue(value),
      },
      splitLine: {
        show: index === 0,
        lineStyle: { color: palette.grid, type: 'dashed' as const, width: 1 },
      },
      name: currentSeries.unit ?? '',
      nameTextStyle: {
        color,
        fontFamily: '"DM Mono", ui-monospace, monospace',
        fontSize: 9,
      },
    };
  });

  const lineSeries = series.map((currentSeries, seriesIndex) => {
    const color = colorForField(fields, currentSeries.key);
    const values = aligned.values[seriesIndex] ?? [];
    return {
      id: currentSeries.key,
      name: currentSeries.key,
      type: 'line' as const,
      yAxisIndex: seriesIndex,
      // Keep point markers on short traces, but let long retained histories
      // render as lines. Thousands of circles per refresh make zoom and live
      // updates compete for the same frame and can look like blinking.
      showSymbol: showPointSymbols,
      showAllSymbol: showPointSymbols,
      symbol: 'circle',
      symbolSize: 3,
      connectNulls: false,
      // Telemetry arrives while dataZoom is also changing the coordinate
      // transform. Animating both at once can leave a line series in a stale
      // intermediate frame, especially when several samples arrive per
      // render tick. A measurement should appear at its actual position.
      animation: false,
      animationDuration: 0,
      animationDurationUpdate: 0,
      animationEasingUpdate: 'linear' as const,
      animationThreshold: 10_000,
      // Keep the full line in one render pass so moving the pointer never
      // restarts progressive drawing underneath the tooltip.
      progressive: 0,
      lineStyle: { color, width: 2 },
      itemStyle: { color },
      // Tooltips and the vertical guide still respond to the pointer, but
      // the plotted traces never dim, thicken, or flash under the hand.
      emphasis: { disabled: true },
      data: aligned.timestamps.map((timestamp, index) => [timestamp * 1_000, values[index] ?? null]),
      markLine: seriesIndex === 0 && gaps.length ? {
        silent: true,
        symbol: 'none',
        lineStyle: { color: 'rgba(239, 183, 120, 0.7)', type: 'dashed', width: 1 },
        label: { show: false },
        data: gaps.map((gap) => ({ xAxis: gap.timestampMs })),
      } : undefined,
    };
  });

  return {
    // Zooming and live data updates both invalidate the whole plot. Keep the
    // canvas in one deterministic frame instead of animating between domains.
    animation: false,
    animationDuration: 0,
    animationDurationUpdate: 0,
    animationEasingUpdate: 'linear',
    stateAnimation: { duration: 0 },
    backgroundColor: 'transparent',
    grid: {
      left: gutter,
      right: gutter,
      top: 20,
      bottom: hasZoom ? 52 : 34,
      containLabel: false,
    },
    xAxis: {
      type: 'time',
      min: chartStartMs,
      max: Number.isFinite(chartEndMs) ? chartEndMs : undefined,
      boundaryGap: false,
      axisLine: { lineStyle: { color: palette.axis, width: 1 } },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontFamily: '"DM Mono", ui-monospace, monospace',
        fontSize: 10,
        hideOverlap: true,
        formatter: (value: number) => formatChartTime(value),
      },
      splitLine: { show: false },
      axisPointer: {
        show: true,
        snap: false,
        animation: false,
        lineStyle: { color: palette.pointer, width: 1, type: 'dashed' },
        label: {
          show: true,
          backgroundColor: isLight ? '#315766' : '#18323d',
          color: palette.pointerLabel,
          padding: [3, 5],
          formatter: (params: AxisPointerLabelParams) => formatChartTime(Number(params.value)),
        },
      },
    },
    yAxis,
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: palette.tooltipBackground,
      borderColor: palette.tooltipBorder,
      borderWidth: 1,
      padding: [10, 12],
      transitionDuration: 0,
      textStyle: {
        color: palette.tooltipText,
        fontFamily: '"DM Mono", ui-monospace, monospace',
        fontSize: 11,
      },
      axisPointer: {
        // The vertical guide follows the hand. A horizontal guide is
        // misleading when every signal owns an independent Y scale.
        type: 'line',
        snap: false,
        animation: false,
        triggerOn: 'mousemove|click',
        lineStyle: { color: palette.pointer, width: 1, type: 'dashed' },
        label: {
          show: true,
          backgroundColor: isLight ? '#315766' : '#18323d',
          color: palette.pointerLabel,
          padding: [3, 5],
        },
      },
      formatter: (params: unknown) => {
        const items = (Array.isArray(params) ? params : [params]) as TooltipItem[];
        const timestamp = Number(items[0]?.axisValue ?? (Array.isArray(items[0]?.value) ? items[0]?.value[0] : NaN));
        const rows = items
          .filter((item) => Array.isArray(item.value) && typeof item.value[1] === 'number')
          .map((item) => {
            const value = (item.value as [number, number])[1];
            const name = escapeHtml(readableFieldName(item.seriesName ?? 'signal'));
            const color = item.color ?? '#9fd6c5';
            return `<div class="bt-telemetry-tooltip-row"><span><i style="background:${color}"></i>${name}</span><strong>${formatTelemetryValue(value)}</strong></div>`;
          })
          .join('');
        return `<div class="bt-telemetry-tooltip-time">${Number.isFinite(timestamp) ? formatChartTime(timestamp) : 'Telemetry'}</div>${rows}`;
      },
    },
    dataZoom: [
      { id: 'telemetry-inside-zoom', type: 'inside', xAxisIndex: 0, filterMode: 'none', throttle: 40 },
      ...(hasZoom ? [{
        id: 'telemetry-range-zoom',
        type: 'slider' as const,
        xAxisIndex: 0,
        height: 12,
        bottom: 6,
        left: gutter,
        right: gutter,
        borderColor: 'transparent',
        borderWidth: 0,
        borderRadius: 0,
        backgroundColor: palette.navigatorTrack,
        fillerColor: palette.navigatorFill,
        showDetail: false,
        showDataShadow: true,
        brushSelect: false,
        handleIcon: 'path://M-4,-10 L4,-10 L4,10 L-4,10 Z',
        handleSize: '100%',
        handleStyle: {
          color: palette.navigatorHandle,
          borderColor: palette.navigatorHandle,
          borderWidth: 0,
          shadowBlur: 0,
        },
        moveHandleSize: 0,
        moveHandleStyle: { opacity: 0 },
        dataBackground: {
          lineStyle: { color: palette.navigatorLine, width: 1, opacity: 0.55 },
          areaStyle: { color: 'transparent', opacity: 0 },
        },
        selectedDataBackground: {
          lineStyle: { color: palette.navigatorLine, width: 1, opacity: 0.8 },
          areaStyle: { color: palette.navigatorFill, opacity: 0.45 },
        },
        emphasis: {
          handleStyle: {
            color: palette.navigatorHandle,
            borderColor: palette.navigatorHandle,
            borderWidth: 0,
          },
          moveHandleStyle: { opacity: 0 },
        },
      }] : []),
    ],
    series: lineSeries,
  };
}

function EChartsSurface({ option, structureKey, ariaLabel }: { option: EChartsOption; structureKey: string; ariaLabel: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const pendingOptionRef = useRef<EChartsOption>(option);
  const pendingStructureKeyRef = useRef('');
  const structureKeyRef = useRef('');
  const zoomingRef = useRef(false);
  const zoomIdleTimerRef = useRef<number | undefined>(undefined);

  const applyOption = useCallback((nextOption: EChartsOption, structureKey: string) => {
    const chart = chartRef.current;
    if (!chart) return;
    const structureChanged = structureKeyRef.current !== structureKey;
    chart.setOption(nextOption, {
      // Apply the snapshot before the next pointer/dataZoom event so ECharts
      // never merges a queued live frame with a partially applied zoom.
      lazyUpdate: false,
      // Only replace component collections when their shape changes. Doing
      // this for every live sample recreates the plotted components and makes
      // the canvas visibly blink while it is being refreshed.
      replaceMerge: structureChanged ? ['series', 'yAxis'] : undefined,
    });
    structureKeyRef.current = structureKey;
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    // Dirty-rectangle rendering is not safe for this surface: a dataZoom
    // gesture changes the position of every trace, axis, pointer, and slider
    // at once. Repainting the full canvas prevents stale fragments and the
    // disappearing-trace state that can otherwise occur mid-gesture.
    const chart = echarts.init(host, undefined, { renderer: 'canvas', useDirtyRect: false });
    chartRef.current = chart;
    const handleDataZoom = () => {
      // Let ECharts own the gesture until it settles. Live samples continue
      // accumulating in the store, and the newest option is applied once the
      // pointer has stopped so a stream update cannot interrupt the gesture.
      zoomingRef.current = true;
      if (zoomIdleTimerRef.current !== undefined) window.clearTimeout(zoomIdleTimerRef.current);
      zoomIdleTimerRef.current = window.setTimeout(() => {
        zoomIdleTimerRef.current = undefined;
        zoomingRef.current = false;
        applyOption(pendingOptionRef.current, pendingStructureKeyRef.current);
      }, 160);
    };
    chart.on('datazoom', handleDataZoom);
    const resizeObserver = new ResizeObserver(() => chart.resize());
    const preventPageScroll = (event: WheelEvent) => {
      // ECharts consumes this wheel gesture for inside dataZoom. Keep the
      // same event from scrolling the document or reaching the app-level
      // Ctrl/⌘+wheel shell zoom handler.
      event.preventDefault();
      event.stopPropagation();
    };
    host.addEventListener('wheel', preventPageScroll, { passive: false });
    resizeObserver.observe(host);
    chart.resize();
    return () => {
      host.removeEventListener('wheel', preventPageScroll);
      chart.off('datazoom', handleDataZoom);
      if (zoomIdleTimerRef.current !== undefined) window.clearTimeout(zoomIdleTimerRef.current);
      resizeObserver.disconnect();
      chart.dispose();
      if (chartRef.current === chart) chartRef.current = null;
    };
  }, [applyOption]);

  useEffect(() => {
    pendingOptionRef.current = option;
    pendingStructureKeyRef.current = structureKey;
    if (zoomingRef.current) return;
    applyOption(option, structureKey);
  }, [applyOption, option, structureKey]);

  return <div ref={hostRef} className="bt-telemetry-echarts" role="img" aria-label={ariaLabel} />;
}

export function TelemetryCharts({ samples, fields, gaps, selectedFieldKeys, windowMs, paused }: TelemetryChartsProps) {
  const prepared = useMemo(() => prepareTelemetryCharts({
    samples,
    fields,
    gaps,
    selectedFieldKeys,
    windowMs,
    maxPointsPerSeries: Math.max(4, samples.length),
  }), [fields, gaps, samples, selectedFieldKeys, windowMs]);
  const selectedSeries = useMemo(() => prepared.groups.flatMap((group) => group.series), [prepared.groups]);
  const aligned = useMemo(() => alignTelemetryChartData(selectedSeries), [selectedSeries]);
  const isLight = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light';
  const option = useMemo(() => selectedSeries.length && aligned.timestamps.length
    ? chartOption({ fields, series: selectedSeries, aligned, gaps: prepared.gaps, startMs: prepared.startMs, endMs: prepared.endMs, isLight })
    : null, [aligned, fields, isLight, prepared.endMs, prepared.gaps, prepared.startMs, selectedSeries]);

  if (!fields.length) {
    return <section className="bt-telemetry-view bt-telemetry-view-empty" role="status">
      <strong>Waiting for repeatable numeric data</strong>
      <span>Send a consistent JSON, key/value, CSV, or TSV record to create a signal.</span>
    </section>;
  }

  if (!selectedFieldKeys.length) {
    return <section className="bt-telemetry-view bt-telemetry-view-empty" role="status">
      <strong>Select a field to chart</strong>
      <span>Choose a signal from the left to bring its retained history onto the canvas.</span>
    </section>;
  }

  if (!option || !selectedSeries.length) {
    return <section className="bt-telemetry-view bt-telemetry-view-empty" role="status">
      <strong>No chartable points in this window</strong>
      <span>Keep the serial stream running or choose a longer display window.</span>
    </section>;
  }

  return <section className="bt-telemetry-view" aria-label="Live telemetry charts" data-paused={paused || undefined}>
    <header className="bt-telemetry-legend-bar">
      <div className="bt-telemetry-scale-note">
        <strong>Independent scales</strong>
        <span>Each signal keeps its own range so small changes stay readable.</span>
      </div>
      <ul className="bt-telemetry-legend" aria-label="Selected signal values">
        {selectedSeries.map((series) => {
          const color = colorForField(fields, series.key);
          return <li key={series.key}>
            <i aria-hidden="true" style={{ backgroundColor: color }} />
            <span title={series.key}>{readableFieldName(series.key)}</span>
            <strong>{series.latest ? formatTelemetryValue(series.latest.value) : '—'}</strong>
            {series.unit ? <small>{series.unit}</small> : null}
          </li>;
        })}
      </ul>
    </header>
    <div className="bt-telemetry-plot-frame">
      <EChartsSurface
        option={option}
        structureKey={selectedSeries.map((series) => series.key).join('\u0000')}
        ariaLabel={`Live telemetry for ${selectedSeries.map((series) => readableFieldName(series.key)).join(', ')}`}
      />
    </div>
    <footer className="bt-telemetry-view-footer">
      <span><strong>{aligned.timestamps.length.toLocaleString()}</strong> records on canvas</span>
      <span>{selectedSeries.length} independent scales</span>
      {prepared.gaps.length ? <span>{prepared.gaps.length} reconnect marker{prepared.gaps.length === 1 ? '' : 's'}</span> : null}
    </footer>
  </section>;
}
