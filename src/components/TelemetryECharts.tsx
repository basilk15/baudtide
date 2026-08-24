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
  dataIndex?: number;
  seriesIndex?: number;
  seriesName?: string;
  value?: unknown;
};

type AxisPointerLabelParams = {
  value: string | number | Date;
};

type ChartMode = 'lanes' | 'compare';

type NumericRange = {
  min: number;
  max: number;
};

const MAX_RENDERED_POINTS_PER_SERIES = 1_200;
const CHART_DATA_FONT = '"Ubuntu Mono", "Noto Sans Mono", ui-monospace, monospace';

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

function formatChartTime(timestamp: number, includeMilliseconds = false) {
  const date = new Date(timestamp);
  const base = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
  return includeMilliseconds ? `${base}.${String(date.getMilliseconds()).padStart(3, '0')}` : base;
}

function colorForField(fields: readonly TelemetryField[], fieldKey: string) {
  const index = fields.findIndex((field) => field.key === fieldKey);
  return TELEMETRY_SERIES_COLORS[(index < 0 ? 0 : index) % TELEMETRY_SERIES_COLORS.length];
}

function formatAxisTime(timestamp: number, startMs?: number, endMs?: number) {
  if (startMs !== undefined && endMs !== undefined && endMs > startMs && endMs - startMs <= 90_000) {
    const seconds = Math.max(0, Math.round((timestamp - startMs) / 1_000));
    return `+${seconds}s`;
  }
  return formatChartTime(timestamp);
}

function numericRange(points: readonly { value: number }[]): NumericRange | undefined {
  if (!points.length) return undefined;
  let min = points[0].value;
  let max = points[0].value;
  for (let index = 1; index < points.length; index += 1) {
    min = Math.min(min, points[index].value);
    max = Math.max(max, points[index].value);
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : undefined;
}

function normalizeValue(value: number, range: NumericRange | undefined) {
  if (!range || range.min === range.max) return 50;
  return Math.max(0, Math.min(100, ((value - range.min) / (range.max - range.min)) * 100));
}

function tupleValue(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || typeof value[0] !== 'number' || typeof value[1] !== 'number') return undefined;
  return [value[0], value[1]];
}

function chartOption({
  fields,
  series,
  aligned,
  gaps,
  startMs,
  endMs,
  isLight,
  mode,
}: {
  fields: readonly TelemetryField[];
  series: readonly ReturnType<typeof prepareTelemetryCharts>['groups'][number]['series'][number][];
  aligned: ReturnType<typeof alignTelemetryChartData>;
  gaps: readonly { timestampMs: number }[];
  startMs?: number;
  endMs?: number;
  isLight: boolean;
  mode: ChartMode;
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
  const seriesCount = Math.max(1, series.length);
  const chartStartMs = startMs ?? (aligned.timestamps[0] === undefined ? undefined : aligned.timestamps[0] * 1_000);
  const chartEndMs = Math.max(
    endMs ?? Number.NEGATIVE_INFINITY,
    aligned.timestamps.length ? aligned.timestamps[aligned.timestamps.length - 1] * 1_000 : Number.NEGATIVE_INFINITY,
  );
  const hasZoom = aligned.timestamps.length > 80;
  const isLanes = mode === 'lanes';
  const lastSeriesIndex = Math.max(0, series.length - 1);
  const rawRanges = series.map((currentSeries) => numericRange(currentSeries.points));

  const laneTop = 4;
  const laneBottom = hasZoom ? 16 : 10;
  const laneGap = series.length > 1 ? Math.min(3.5, 14 / series.length) : 0;
  const laneHeight = (100 - laneTop - laneBottom - laneGap * Math.max(0, series.length - 1)) / seriesCount;

  const grid = isLanes
    ? series.map((_currentSeries, index) => ({
      left: 72,
      right: 20,
      top: `${laneTop + index * (laneHeight + laneGap)}%`,
      height: `${laneHeight}%`,
      containLabel: false,
    }))
    : {
      left: 24,
      right: 20,
      top: 18,
      bottom: hasZoom ? 62 : 40,
      containLabel: true,
    };

  const yAxis = isLanes
    ? series.map((currentSeries, index) => {
      const domain = telemetryYDomain(currentSeries.points) ?? { min: 0, max: 1 };
      const color = colorForField(fields, currentSeries.key);
      return {
        type: 'value' as const,
        gridIndex: index,
        min: domain.min,
        max: domain.max,
        scale: true,
        splitNumber: 3,
        position: 'left' as const,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color,
          fontFamily: CHART_DATA_FONT,
          fontSize: 10,
          margin: 9,
          hideOverlap: true,
          formatter: (value: number) => formatTelemetryValue(value),
        },
        splitLine: {
          show: true,
          lineStyle: { color: palette.grid, type: 'dashed' as const, width: 1 },
        },
      };
    })
    : {
      type: 'value' as const,
      min: 0,
      max: 100,
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontFamily: CHART_DATA_FONT,
        fontSize: 10,
        formatter: (value: number) => `${Math.round(value)}%`,
      },
      splitLine: {
        show: true,
        lineStyle: { color: palette.grid, type: 'dashed' as const, width: 1 },
      },
    };

  const xAxis = isLanes
    ? series.map((_currentSeries, index) => ({
      type: 'time' as const,
      gridIndex: index,
      min: chartStartMs,
      max: Number.isFinite(chartEndMs) ? chartEndMs : undefined,
      boundaryGap: false,
      axisLine: { show: index === lastSeriesIndex, lineStyle: { color: palette.axis, width: 1 } },
      axisTick: { show: false },
      axisLabel: {
        show: index === lastSeriesIndex,
        color: palette.muted,
        fontFamily: CHART_DATA_FONT,
        fontSize: 10,
        hideOverlap: true,
        margin: 10,
        formatter: (value: number) => formatAxisTime(value, chartStartMs, chartEndMs),
      },
      splitLine: { show: false },
      axisPointer: {
        show: true,
        snap: false,
        animation: false,
        lineStyle: { color: palette.pointer, width: 1, type: 'dashed' as const },
        label: {
          show: index === lastSeriesIndex,
          backgroundColor: isLight ? '#315766' : '#18323d',
          color: palette.pointerLabel,
          padding: [3, 5],
          formatter: (params: AxisPointerLabelParams) => formatAxisTime(Number(params.value), chartStartMs, chartEndMs),
        },
      },
    }))
    : {
      type: 'time' as const,
      min: chartStartMs,
      max: Number.isFinite(chartEndMs) ? chartEndMs : undefined,
      boundaryGap: false,
      axisLine: { lineStyle: { color: palette.axis, width: 1 } },
      axisTick: { show: false },
      axisLabel: {
        color: palette.muted,
        fontFamily: CHART_DATA_FONT,
        fontSize: 10,
        hideOverlap: true,
        margin: 10,
        formatter: (value: number) => formatAxisTime(value, chartStartMs, chartEndMs),
      },
      splitLine: { show: false },
      axisPointer: {
        show: true,
        snap: false,
        animation: false,
        lineStyle: { color: palette.pointer, width: 1, type: 'dashed' as const },
        label: {
          show: true,
          backgroundColor: isLight ? '#315766' : '#18323d',
          color: palette.pointerLabel,
          padding: [3, 5],
          formatter: (params: AxisPointerLabelParams) => formatAxisTime(Number(params.value), chartStartMs, chartEndMs),
        },
      },
    };

  const lineSeries = series.map((currentSeries, seriesIndex) => {
    const color = colorForField(fields, currentSeries.key);
    const values = aligned.values[seriesIndex] ?? [];
    const normalizedValues = values.map((value) => typeof value === 'number' ? normalizeValue(value, rawRanges[seriesIndex]) : null);
    return {
      id: currentSeries.key,
      name: currentSeries.key,
      type: 'line' as const,
      xAxisIndex: isLanes ? seriesIndex : 0,
      yAxisIndex: isLanes ? seriesIndex : 0,
      // A small curve removes the angular, bead-like appearance without
      // hiding fast telemetry changes behind aggressive smoothing.
      smooth: isLanes ? 0.14 : 0.1,
      showSymbol: false,
      showAllSymbol: false,
      symbol: 'circle',
      symbolSize: 6,
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
      lineStyle: { color, width: isLanes ? 2.4 : 2.1 },
      itemStyle: { color },
      emphasis: {
        focus: 'series' as const,
        lineStyle: { width: isLanes ? 3 : 2.8 },
      },
      data: aligned.timestamps.map((timestamp, index) => [
        timestamp * 1_000,
        isLanes ? values[index] ?? null : normalizedValues[index],
      ]),
      markLine: gaps.length && (isLanes || seriesIndex === 0) ? {
        silent: true,
        symbol: 'none',
        lineStyle: { color: TELEMETRY_SERIES_COLORS[2], type: 'dashed', width: 1, opacity: 0.62 },
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
    grid,
    xAxis,
    yAxis,
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
      triggerOn: 'mousemove|click',
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      renderMode: 'html',
      className: 'bt-telemetry-tooltip',
      backgroundColor: palette.tooltipBackground,
      borderColor: palette.tooltipBorder,
      borderWidth: 1,
      padding: [10, 12],
      transitionDuration: 0,
      textStyle: {
        color: palette.tooltipText,
        fontFamily: CHART_DATA_FONT,
        fontSize: 11,
      },
      axisPointer: {
        // The vertical guide follows the hand. A horizontal guide is
        // misleading when every signal owns an independent Y scale.
        type: 'line',
        snap: false,
        animation: false,
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
        const timestamp = Number(items[0]?.axisValue ?? tupleValue(items[0]?.value)?.[0] ?? NaN);
        const rows = items
          .map((item) => {
            const pair = tupleValue(item.value);
            if (!pair) return '';
            const seriesIndex = Number.isInteger(item.seriesIndex)
              ? item.seriesIndex!
              : series.findIndex((currentSeries) => currentSeries.key === item.seriesName);
            const dataIndex = Number.isInteger(item.dataIndex) ? item.dataIndex! : 0;
            const rawValue = aligned.values[seriesIndex]?.[dataIndex];
            const value = typeof rawValue === 'number' ? rawValue : pair[1];
            const currentSeries = series[seriesIndex];
            const name = escapeHtml(readableFieldName(item.seriesName ?? 'signal'));
            const color = item.color ?? '#9fd6c5';
            const unit = currentSeries?.unit ? `<small>${escapeHtml(currentSeries.unit)}</small>` : '';
            const relative = mode === 'compare' ? `<small>${Math.round(pair[1])}% range</small>` : '';
            return `<div class="bt-telemetry-tooltip-row"><span><i style="background:${color}"></i>${name}</span><strong>${formatTelemetryValue(value)}${unit}${relative}</strong></div>`;
          })
          .filter(Boolean)
          .join('');
        return `<div class="bt-telemetry-tooltip-time">${Number.isFinite(timestamp) ? formatChartTime(timestamp, true) : 'Telemetry'}</div>${rows}`;
      },
    },
    dataZoom: [
      {
        id: 'telemetry-inside-zoom',
        type: 'inside',
        xAxisIndex: 'all',
        filterMode: 'none',
        throttle: 40,
        zoomOnMouseWheel: 'shift',
        moveOnMouseWheel: false,
        moveOnMouseMove: true,
      },
      ...(hasZoom ? [{
        id: 'telemetry-range-zoom',
        type: 'slider' as const,
        xAxisIndex: 'all' as const,
        height: 14,
        bottom: 5,
        left: isLanes ? 72 : 24,
        right: 20,
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
      replaceMerge: structureChanged ? ['grid', 'series', 'xAxis', 'yAxis', 'dataZoom'] : undefined,
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
      // Shift+wheel is the deliberate chart-zoom gesture. Leave an ordinary
      // wheel available for page scrolling, especially in the taller lane
      // view with several selected signals.
      if (!event.shiftKey) return;
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
    maxPointsPerSeries: MAX_RENDERED_POINTS_PER_SERIES,
  }), [fields, gaps, samples, selectedFieldKeys, windowMs]);
  const selectedSeries = useMemo(() => prepared.groups.flatMap((group) => group.series), [prepared.groups]);
  const aligned = useMemo(() => alignTelemetryChartData(selectedSeries), [selectedSeries]);
  const isLight = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light';
  const plots = useMemo(() => selectedSeries.map((series) => {
    const plotAligned = alignTelemetryChartData([series]);
    const option = plotAligned.timestamps.length
      ? chartOption({
        fields,
        series: [series],
        aligned: plotAligned,
        gaps: prepared.gaps,
        startMs: prepared.startMs,
        endMs: prepared.endMs,
        isLight,
        mode: 'lanes',
      })
      : null;
    return { series, aligned: plotAligned, option };
  }), [fields, isLight, prepared.endMs, prepared.gaps, prepared.startMs, selectedSeries]);
  const chartablePlots = plots.filter((plot) => plot.option && plot.aligned.timestamps.length);

  if (!fields.length) {
    return <section className="bt-telemetry-view bt-telemetry-view-empty" role="status">
      <strong>Waiting for repeatable numeric data</strong>
      <span>Send repeated JSON objects or batches, key/value pairs, or header-based CSV/TSV records to create a signal.</span>
    </section>;
  }

  if (!selectedFieldKeys.length) {
    return <section className="bt-telemetry-view bt-telemetry-view-empty" role="status">
      <strong>Select a field to chart</strong>
      <span>Choose a signal from the left to bring its retained history onto the canvas.</span>
    </section>;
  }

  if (!chartablePlots.length) {
    return <section className="bt-telemetry-view bt-telemetry-view-empty" role="status">
      <strong>No chartable points in this window</strong>
      <span>Keep the serial stream running or choose a longer display window.</span>
    </section>;
  }

  return <section className="bt-telemetry-view" aria-label="Live telemetry signal plots" data-paused={paused || undefined}>
    <header className="bt-telemetry-stack-header">
      <div className="bt-telemetry-stack-title">
        <strong>Signal plots</strong>
        <span>{chartablePlots.length} selected · independent scales</span>
      </div>
      <span className="bt-telemetry-stack-hint">One plot per signal</span>
    </header>
    <div className="bt-telemetry-plot-stack">
      {chartablePlots.map((plot) => {
        const color = colorForField(fields, plot.series.key);
        return <article className="bt-telemetry-plot" key={plot.series.key}>
          <header className="bt-telemetry-plot-header">
            <div className="bt-telemetry-plot-label">
              <i aria-hidden="true" style={{ backgroundColor: color }} />
              <strong>{readableFieldName(plot.series.key)}</strong>
              {plot.series.unit ? <small>{plot.series.unit}</small> : null}
            </div>
            <div className="bt-telemetry-plot-readout">
              <strong>{plot.series.latest ? formatTelemetryValue(plot.series.latest.value) : '—'}</strong>
              <span>latest</span>
            </div>
          </header>
          <div className="bt-telemetry-plot-canvas">
            <EChartsSurface
              option={plot.option!}
              structureKey={`separate\u0000${plot.series.key}`}
              ariaLabel={`${readableFieldName(plot.series.key)} telemetry plot`}
            />
          </div>
        </article>;
      })}
    </div>
    <footer className="bt-telemetry-view-footer">
      <span><strong>{aligned.timestamps.length.toLocaleString()}</strong> records in window</span>
      <span>{chartablePlots.length} separate plots</span>
      {prepared.gaps.length ? <span>{prepared.gaps.length} reconnect marker{prepared.gaps.length === 1 ? '' : 's'}</span> : null}
    </footer>
  </section>;
}
