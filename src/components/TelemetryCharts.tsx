import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { TelemetryField, TelemetryGap, TelemetrySample } from '../lib/telemetry';
import {
  formatTelemetryValue,
  prepareTelemetryCharts,
  TELEMETRY_SERIES_COLORS,
  telemetryYDomain,
  type TelemetryChartGapMarker,
  type TelemetryChartGroup,
} from '../lib/telemetryChart';
import './telemetry-charts.css';

export type TelemetryChartsProps = {
  samples: readonly TelemetrySample[];
  fields: readonly TelemetryField[];
  gaps: readonly TelemetryGap[];
  selectedFieldKeys: readonly string[];
  windowMs: number;
  paused: boolean;
};

function readableFieldName(key: string) {
  return key.replace(/[._-]+/gu, ' ');
}

function formatTime(timestampMs: number, includeDate: boolean) {
  const date = new Date(timestampMs);
  return new Intl.DateTimeFormat(undefined, {
    ...(includeDate ? { month: 'short', day: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function chartTimeRange(group: TelemetryChartGroup, gaps: readonly TelemetryChartGapMarker[], startMs?: number, endMs?: number) {
  const timestamps = group.series.flatMap((series) => series.points.map((point) => point.timestampMs));
  timestamps.push(...gaps.map((gap) => gap.timestampMs));
  const start = startMs ?? (timestamps.length ? Math.min(...timestamps) : undefined);
  const end = endMs ?? (timestamps.length ? Math.max(...timestamps) : undefined);
  return start === undefined || end === undefined ? undefined : { start, end };
}

/** uPlot uses one shared X array and a Y array per series. Nulls preserve gaps. */
function alignedData(group: TelemetryChartGroup): uPlot.AlignedData {
  const timestampSet = new Set<number>();
  const valuesBySeries = group.series.map((series) => {
    const values = new Map<number, number>();
    series.points.forEach((point) => {
      timestampSet.add(point.timestampMs);
      values.set(point.timestampMs, point.value);
    });
    return values;
  });
  const timestamps = [...timestampSet].sort((left, right) => left - right);
  return [
    timestamps.map((timestampMs) => timestampMs / 1_000),
    ...valuesBySeries.map((values) => timestamps.map((timestampMs) => values.get(timestampMs) ?? null)),
  ] as uPlot.AlignedData;
}

function chartColor(colorsByField: ReadonlyMap<string, string>, fieldKey: string, index: number) {
  return colorsByField.get(fieldKey) ?? TELEMETRY_SERIES_COLORS[index % TELEMETRY_SERIES_COLORS.length];
}

/** Keeps the crosshair intersection and the single hover point on one sample. */
function snapCursorToNearestDataPoint(plot: uPlot, left: number, top: number): uPlot.Cursor.LeftTop {
  if (!Number.isFinite(left) || !Number.isFinite(top) || left < 0 || top < 0) return [left, top];
  const index = plot.posToIdx(left);
  const xValue = plot.data[0]?.[index];
  if (typeof xValue !== 'number' || !Number.isFinite(xValue)) return [left, top];

  const snappedLeft = plot.valToPos(xValue, 'x');
  let nearestTop = top;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let seriesIndex = 1; seriesIndex < plot.data.length; seriesIndex += 1) {
    const value = plot.data[seriesIndex]?.[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const candidateTop = plot.valToPos(value, 'y');
    const distance = Math.abs(candidateTop - top);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestTop = candidateTop;
    }
  }

  return [snappedLeft, nearestDistance <= 48 ? nearestTop : top];
}

function drawChartAnnotations(
  plot: uPlot,
  gapsRef: MutableRefObject<readonly TelemetryChartGapMarker[]>,
  seriesRef: MutableRefObject<readonly TelemetryChartGroup['series'][number][]>,
  colorsByField: ReadonlyMap<string, string>,
) {
  const ratio = uPlot.pxRatio;
  const ctx = plot.ctx;
  const { left, top, width, height } = plot.bbox;
  const xMin = plot.scales.x.min;
  const xMax = plot.scales.x.max;
  if (xMin === undefined || xMax === undefined || !Number.isFinite(xMin) || !Number.isFinite(xMax)) return;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.setLineDash([4 * ratio, 5 * ratio]);
  ctx.lineWidth = ratio;
  ctx.strokeStyle = '#edbf7c99';
  for (const gap of gapsRef.current) {
    const x = plot.valToPos(gap.timestampMs / 1_000, 'x', true);
    if (x < left || x > left + width) continue;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + height);
    ctx.stroke();
  }

  ctx.setLineDash([]);
  seriesRef.current.forEach((series, seriesIndex) => {
    const latest = series.points[series.points.length - 1];
    if (!latest) return;
    const x = plot.valToPos(latest.timestampMs / 1_000, 'x', true);
    const y = plot.valToPos(latest.value, 'y', true);
    if (x < left || x > left + width || y < top || y > top + height) return;
    const color = chartColor(colorsByField, series.key, seriesIndex);
    ctx.beginPath();
    ctx.arc(x, y, 3.5 * ratio, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5 * ratio;
    ctx.strokeStyle = '#10202dcc';
    ctx.stroke();
  });
  ctx.restore();
}

function UPlotTelemetryChart({
  group,
  gaps,
  startMs,
  endMs,
  colorsByField,
}: {
  group: TelemetryChartGroup;
  gaps: readonly TelemetryChartGapMarker[];
  startMs?: number;
  endMs?: number;
  colorsByField: ReadonlyMap<string, string>;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipTimeRef = useRef<HTMLDivElement>(null);
  const tooltipValueRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const tooltipRowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const gapsRef = useRef<readonly TelemetryChartGapMarker[]>(gaps);
  const seriesRef = useRef(group.series);
  gapsRef.current = gaps;
  seriesRef.current = group.series;

  const domain = telemetryYDomain(group.series.flatMap((series) => series.points));
  const timeRange = chartTimeRange(group, gaps, startMs, endMs);
  const data = useMemo(() => alignedData(group), [group]);
  const includeDate = Boolean(timeRange && timeRange.end - timeRange.start >= 24 * 60 * 60 * 1_000);
  const seriesSignature = group.series.map((series) => series.key).join('\u0000');
  const colorSignature = group.series.map((series, index) => chartColor(colorsByField, series.key, index)).join('\u0000');
  const hasData = Boolean(domain && timeRange && data[0]?.length);

  const hideTooltip = () => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    tooltip.hidden = true;
    tooltip.classList.remove('is-visible');
  };

  useEffect(() => {
    const host = hostRef.current;
    const frame = frameRef.current;
    if (!host || !frame || !hasData || !domain || !timeRange) return undefined;

    const frameWidth = Math.floor(host.clientWidth || frame.clientWidth || 640);
    const frameHeight = Math.floor(host.clientHeight || frame.clientHeight || 280);
    const colors = group.series.map((series, index) => chartColor(colorsByField, series.key, index));
    const updateTooltip = (plot: uPlot) => {
      const tooltip = tooltipRef.current;
      const tooltipTime = tooltipTimeRef.current;
      const index = plot.cursor.idx;
      const xValues = plot.data[0];
      if (!tooltip || !tooltipTime || index === null || index === undefined || !xValues?.[index]) {
        hideTooltip();
        return;
      }

      tooltipTime.textContent = formatTime(Number(xValues[index]) * 1_000, includeDate);
      seriesRef.current.forEach((series, seriesIndex) => {
        const value = plot.data[seriesIndex + 1]?.[index];
        const valueElement = tooltipValueRefs.current[seriesIndex];
        const rowElement = tooltipRowRefs.current[seriesIndex];
        if (valueElement) valueElement.textContent = typeof value === 'number' ? formatTelemetryValue(value) : '—';
        if (rowElement) rowElement.style.opacity = typeof value === 'number' ? '1' : '.42';
      });

      const overRect = plot.over.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      const cursorX = overRect.left - frameRect.left + (plot.cursor.left ?? 0);
      const cursorY = overRect.top - frameRect.top + (plot.cursor.top ?? 0);
      const gap = 14;
      const prefersLeft = cursorX > frame.clientWidth * .62;
      const left = prefersLeft ? cursorX - tooltip.offsetWidth - gap : cursorX + gap;
      const top = cursorY < tooltip.offsetHeight + gap ? cursorY + gap : cursorY - tooltip.offsetHeight - gap;
      tooltip.style.left = `${Math.max(8, Math.min(left, frame.clientWidth - tooltip.offsetWidth - 8))}px`;
      tooltip.style.top = `${Math.max(8, Math.min(top, frame.clientHeight - tooltip.offsetHeight - 8))}px`;
      tooltip.hidden = false;
      tooltip.classList.add('is-visible');
    };

    const options: uPlot.Options = {
      width: frameWidth,
      height: frameHeight,
      class: 'sd-uplot',
      ms: 1e-3,
      pxAlign: true,
      padding: [12, 14, 9, 8],
      series: [
        {},
        ...group.series.map((series, index) => ({
          label: readableFieldName(series.key),
          stroke: colors[index],
          width: 2,
          spanGaps: false,
          points: { show: false },
          value: (_plot: uPlot, value: number) => formatTelemetryValue(value),
        })),
      ],
      scales: {
        x: { time: true, auto: false, range: [timeRange.start / 1_000, timeRange.end / 1_000] },
        y: { auto: false, range: [domain.min, domain.max] },
      },
      axes: [
        {
          scale: 'x',
          side: 2,
          stroke: '#748b9b',
          grid: { stroke: '#7895a91f', width: 1, dash: [3, 6] },
          ticks: { show: false },
          border: { show: false },
          font: '9px "DM Mono", ui-monospace, monospace',
          space: 88,
          values: (_plot, splits) => splits.map((value) => formatTime(value * 1_000, includeDate)),
        },
        {
          scale: 'y',
          side: 3,
          stroke: '#748b9b',
          grid: { stroke: '#7895a91f', width: 1, dash: [3, 6] },
          ticks: { show: false },
          border: { show: false },
          font: '9px "DM Mono", ui-monospace, monospace',
          size: 54,
          space: 40,
          values: (_plot, splits) => splits.map((value) => formatTelemetryValue(value)),
        },
      ],
      cursor: {
        x: true,
        y: true,
        move: snapCursorToNearestDataPoint,
        drag: { x: false, y: false, setScale: false },
        points: { show: true, one: true, size: 7, width: 2 },
        focus: { prox: 48 },
        hover: { prox: 32 },
      },
      focus: { alpha: .18 },
      legend: { show: false },
      hooks: {
        draw: [
          (plot) => drawChartAnnotations(plot, gapsRef, seriesRef, colorsByField),
        ],
        setCursor: [updateTooltip],
      },
    };

    const plot = new uPlot(options, data, host);
    plotRef.current = plot;
    let disposed = false;
    const resizeObserver = new ResizeObserver(() => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width > 0 && height > 0) plot.setSize({ width, height });
    });
    resizeObserver.observe(host);
    requestAnimationFrame(() => {
      if (disposed) return;
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width > 0 && height > 0) plot.setSize({ width, height });
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      hideTooltip();
      plot.destroy();
      if (plotRef.current === plot) plotRef.current = null;
    };
  }, [colorSignature, group.id, hasData, includeDate, seriesSignature]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || !hasData || !domain || !timeRange) return;
    plot.batch(() => {
      plot.setData(data, false);
      plot.setScale('x', { min: timeRange.start / 1_000, max: timeRange.end / 1_000 });
      plot.setScale('y', { min: domain.min, max: domain.max });
    });
  }, [data, domain, hasData, timeRange]);

  if (!domain || !timeRange) return null;
  const accessibleSeries = group.series
    .filter((series) => series.latest)
    .map((series) => `${readableFieldName(series.key)} ${formatTelemetryValue(series.latest!.value)}${series.unit ? ` ${series.unit}` : ''}`)
    .join(', ');

  return (
    <div
      ref={frameRef}
      className="sd-telemetry-chart-plot"
      role="img"
      aria-label={`${group.label} telemetry chart`}
    >
      <div ref={hostRef} className="sd-uplot-host" aria-hidden="true" />
      <div ref={tooltipRef} className="sd-telemetry-hover-card" hidden role="status" aria-label={`${group.label} hovered values`}>
        <div ref={tooltipTimeRef} className="sd-telemetry-hover-time" />
        <div className="sd-telemetry-hover-items">
          {group.series.map((series, index) => (
            <div ref={(element) => { tooltipRowRefs.current[index] = element; }} className="sd-telemetry-hover-item" key={series.key}>
              <i aria-hidden="true" style={{ backgroundColor: chartColor(colorsByField, series.key, index) }} />
              <span>{readableFieldName(series.key)}</span>
              <strong><span ref={(element) => { tooltipValueRefs.current[index] = element; }}>—</span>{series.unit ? <small>{series.unit}</small> : null}</strong>
            </div>
          ))}
        </div>
      </div>
      <p className="sd-visually-hidden">
        {`Time series for ${accessibleSeries}. ${gaps.length ? `${gaps.length} reconnect marker${gaps.length === 1 ? '' : 's'} shown.` : 'No reconnect markers in this window.'}`}
      </p>
    </div>
  );
}

/**
 * A bounded, canvas-rendered telemetry surface. React owns the snapshot and
 * controls; uPlot owns the hot path so incoming samples do not create an SVG
 * element tree or a React reconciliation pass for every line segment.
 */
export function TelemetryCharts({ samples, fields, gaps, selectedFieldKeys, windowMs, paused }: TelemetryChartsProps) {
  const prepared = useMemo(() => prepareTelemetryCharts({
    samples,
    fields,
    gaps,
    selectedFieldKeys,
    windowMs,
    maxPointsPerSeries: 600,
  }), [fields, gaps, samples, selectedFieldKeys, windowMs]);
  const hasSelection = selectedFieldKeys.length > 0;
  const colorsByField = useMemo(() => new Map(fields.map((field, index) => [
    field.key,
    TELEMETRY_SERIES_COLORS[index % TELEMETRY_SERIES_COLORS.length],
  ])), [fields]);

  return (
    <section className="sd-telemetry-charts" aria-label="Live telemetry charts" data-paused={paused || undefined}>
      {!hasSelection ? (
        <div className="sd-telemetry-charts-empty" role="status">
          <strong>Select a field to chart</strong>
          <span>Detected numeric fields will appear here with their latest value and history.</span>
        </div>
      ) : !prepared.totalPointCount ? (
        <div className="sd-telemetry-charts-empty" role="status">
          <strong>No chartable points in this window</strong>
          <span>Keep the serial stream running, choose a longer window, or select another detected field.</span>
        </div>
      ) : (
        <div className="sd-telemetry-chart-stack">
          {prepared.groups.map((group) => (
            <article className="sd-telemetry-chart-card" key={group.id}>
              <header className="sd-telemetry-chart-header">
                <div>
                  <p>Scale</p>
                  <h3>{group.label}</h3>
                </div>
                <ul className="sd-telemetry-chart-legend" aria-label={`${group.label} latest values`}>
                  {group.series.map((series, index) => (
                    <li key={series.key}>
                      <i aria-hidden="true" style={{ backgroundColor: chartColor(colorsByField, series.key, index) }} />
                      <span title={series.key}>{readableFieldName(series.key)}</span>
                      <strong>
                        {series.latest ? formatTelemetryValue(series.latest.value) : '—'}
                        {series.unit ? <small>{series.unit}</small> : null}
                      </strong>
                    </li>
                  ))}
                </ul>
              </header>
              <UPlotTelemetryChart
                group={group}
                gaps={prepared.gaps}
                startMs={prepared.startMs}
                endMs={prepared.endMs}
                colorsByField={colorsByField}
              />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
