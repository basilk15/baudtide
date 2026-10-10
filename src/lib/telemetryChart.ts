import type { TelemetryField, TelemetryGap, TelemetrySample } from './telemetry';

export const TELEMETRY_SERIES_COLORS = ['#70d8bd', '#8e9fff', '#efb778', '#e985a2', '#69bde8', '#c28be8', '#adc979', '#f1a873'] as const;
const LIGHT_TELEMETRY_SERIES_COLORS = ['#187d68', '#5358c8', '#995d1a', '#b14165', '#206e9a', '#8350b1', '#557423', '#a45125'] as const;

export function telemetrySeriesColor(index: number, light = false) {
  const colors = light ? LIGHT_TELEMETRY_SERIES_COLORS : TELEMETRY_SERIES_COLORS;
  return colors[Math.max(0, index) % colors.length];
}

/** A timestamped scalar ready for plotting. Timestamps are milliseconds since Unix epoch. */
export type TelemetryChartPoint = Readonly<{
  sampleId: string;
  timestampMs: number;
  value: number;
}>;

export type TelemetryChartSeries = Readonly<{
  key: string;
  unit?: string;
  points: readonly TelemetryChartPoint[];
  latest?: TelemetryChartPoint;
}>;

export type AlignedTelemetryChartData = Readonly<{
  /** Strictly increasing X values in seconds, ready for a time-series renderer. */
  timestamps: readonly number[];
  /** One nullable value array per input series, aligned to `timestamps`. */
  values: readonly (readonly (number | null)[])[];
}>;

/** Fields with this unit share one Y scale. Fields without a unit form their own group. */
export type TelemetryChartGroup = Readonly<{
  id: string;
  unit?: string;
  label: string;
  series: readonly TelemetryChartSeries[];
}>;

export type TelemetryChartGapMarker = Readonly<{
  id: string;
  timestampMs: number;
  type: TelemetryGap['type'];
  fieldKeys?: readonly string[];
}>;

export type TelemetryChartDomain = Readonly<{
  min: number;
  max: number;
}>;

export type PreparedTelemetryCharts = Readonly<{
  groups: readonly TelemetryChartGroup[];
  gaps: readonly TelemetryChartGapMarker[];
  startMs?: number;
  endMs?: number;
  totalPointCount: number;
}>;

export type PrepareTelemetryChartsOptions = Readonly<{
  samples: readonly TelemetrySample[];
  fields: readonly TelemetryField[];
  gaps: readonly TelemetryGap[];
  selectedFieldKeys: readonly string[];
  /** A duration ending at the newest valid telemetry timestamp. Non-positive values retain all samples. */
  windowMs: number;
  /** Upper bound for each rendered line. The default is intentionally safe for 10k retained samples. */
  maxPointsPerSeries?: number;
  /** Useful for a fixed live clock in callers that have one. Defaults to the newest valid sample timestamp. */
  endMs?: number;
}>;

const DEFAULT_MAX_POINTS_PER_SERIES = 1_200;
const MIN_DECIMATION_POINTS = 4;
const DUPLICATE_TIMESTAMP_STEP_MS = 0.001;

type TimestampedSample = Readonly<{ sample: TelemetrySample; timestampMs: number; sourceIndex: number }>;

function finiteTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function normalizedUnit(unit: string | undefined) {
  const trimmed = unit?.trim();
  return trimmed || undefined;
}

function clampPositiveInteger(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(MIN_DECIMATION_POINTS, Math.floor(value))
    : fallback;
}

/** Returns only samples with parseable timestamps and the time range used for a chart. */
export function filterTelemetryWindow(
  samples: readonly TelemetrySample[],
  windowMs: number,
  endMs?: number,
): Readonly<{ samples: readonly TimestampedSample[]; startMs?: number; endMs?: number }> {
  const validSamples: TimestampedSample[] = [];
  let latestTimestamp: number | undefined;

  samples.forEach((sample, sourceIndex) => {
    const timestampMs = finiteTimestamp(sample.timestamp);
    if (timestampMs === undefined) return;
    validSamples.push({ sample, timestampMs, sourceIndex });
    if (latestTimestamp === undefined || timestampMs > latestTimestamp) latestTimestamp = timestampMs;
  });

  const resolvedEndMs = typeof endMs === 'number' && Number.isFinite(endMs) ? endMs : latestTimestamp;
  if (resolvedEndMs === undefined) return { samples: [] };

  const startMs = Number.isFinite(windowMs) && windowMs > 0 ? resolvedEndMs - windowMs : undefined;
  return {
    samples: validSamples.filter(({ timestampMs }) => timestampMs <= resolvedEndMs && (startMs === undefined || timestampMs >= startMs)),
    startMs,
    endMs: resolvedEndMs,
  };
}

/**
 * Group selected descriptors by their reported unit. The input descriptor
 * order is retained, which keeps legends and field-selection order stable.
 */
export function groupTelemetryFieldsByUnit(
  fields: readonly TelemetryField[],
  selectedFieldKeys: readonly string[],
): readonly Readonly<{ id: string; unit?: string; label: string; fields: readonly TelemetryField[] }>[] {
  const requested = new Set(selectedFieldKeys);
  const groups = new Map<string, { id: string; unit?: string; label: string; fields: TelemetryField[] }>();

  for (const field of fields) {
    if (!requested.has(field.key)) continue;
    const unit = normalizedUnit(field.unit);
    const id = `unit:${unit ?? 'unspecified'}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, unit, label: unit ?? 'Unitless', fields: [] };
      groups.set(id, group);
    }
    group.fields.push(field);
  }

  return [...groups.values()].map((group) => ({
    ...group,
    fields: Object.freeze([...group.fields]),
  }));
}

/**
 * Deterministically reduces a line while always retaining its first, last,
 * global minimum, and global maximum. The remaining capacity is allocated to
 * min/max pairs in chronological buckets, making short spikes visible.
 */
export function decimateTelemetryPoints(
  points: readonly TelemetryChartPoint[],
  maxPoints = DEFAULT_MAX_POINTS_PER_SERIES,
): readonly TelemetryChartPoint[] {
  const limit = clampPositiveInteger(maxPoints, DEFAULT_MAX_POINTS_PER_SERIES);
  if (points.length <= limit) return [...points];

  let minimumIndex = 0;
  let maximumIndex = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].value < points[minimumIndex].value) minimumIndex = index;
    if (points[index].value > points[maximumIndex].value) maximumIndex = index;
  }

  const selected = new Set<number>([0, points.length - 1, minimumIndex, maximumIndex]);
  const remainingSlots = Math.max(0, limit - selected.size);
  const interiorLength = Math.max(0, points.length - 2);
  const bucketCount = Math.min(interiorLength, Math.floor(remainingSlots / 2));

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor((bucket * interiorLength) / bucketCount);
    const end = 1 + Math.floor(((bucket + 1) * interiorLength) / bucketCount);
    let minIndex = start;
    let maxIndex = start;
    for (let index = start + 1; index < end; index += 1) {
      if (points[index].value < points[minIndex].value) minIndex = index;
      if (points[index].value > points[maxIndex].value) maxIndex = index;
    }
    selected.add(minIndex);
    selected.add(maxIndex);
  }

  // A flat bucket produces one candidate; fill any spare capacity with evenly
  // spaced original points so a flat signal still reads as a continuous line.
  if (selected.size < limit) {
    for (let slot = 1; slot <= remainingSlots && selected.size < limit; slot += 1) {
      const index = Math.round((slot * (points.length - 1)) / (remainingSlots + 1));
      selected.add(index);
    }
  }

  return [...selected]
    .sort((left, right) => left - right)
    .slice(0, limit)
    .map((index) => points[index]);
}

/** Builds a padded finite domain. A flat signal is expanded around its value. */
export function telemetryYDomain(points: readonly TelemetryChartPoint[]): TelemetryChartDomain | undefined {
  if (!points.length) return undefined;
  let minimum = points[0].value;
  let maximum = points[0].value;
  for (let index = 1; index < points.length; index += 1) {
    minimum = Math.min(minimum, points[index].value);
    maximum = Math.max(maximum, points[index].value);
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return undefined;

  if (minimum === maximum) {
    const padding = Math.max(Math.abs(minimum) * 0.05, 1);
    return { min: minimum - padding, max: maximum + padding };
  }
  const padding = Math.max((maximum - minimum) * 0.08, Number.EPSILON);
  return { min: minimum - padding, max: maximum + padding };
}

function pointsForField(field: TelemetryField, samples: readonly TimestampedSample[]) {
  const points: Array<TelemetryChartPoint & { sourceIndex: number }> = [];
  for (const { sample, timestampMs, sourceIndex } of samples) {
    const value = sample.values[field.key]?.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    points.push({ sampleId: sample.id, timestampMs, value, sourceIndex });
  }
  points.sort((left, right) => left.timestampMs - right.timestampMs || left.sourceIndex - right.sourceIndex);
  return points.map(({ sourceIndex: _sourceIndex, ...point }) => point);
}

/**
 * Aligns fields by sample identity instead of timestamp. Native reads can
 * contain several complete records, all stamped with the same read time; a
 * timestamp-keyed map would silently overwrite every record except the last.
 * Duplicate X values receive a sub-millisecond tie-breaker so a time-series
 * renderer can keep them as distinct, strictly ordered points without changing
 * displayed labels.
 */
export function alignTelemetryChartData(series: readonly TelemetryChartSeries[]): AlignedTelemetryChartData {
  type Row = {
    sampleId: string;
    timestampMs: number;
    order: number;
    values: Map<string, number>;
  };

  const rowsBySampleId = new Map<string, Row>();
  let nextOrder = 0;
  for (const currentSeries of series) {
    for (const point of currentSeries.points) {
      let row = rowsBySampleId.get(point.sampleId);
      if (!row) {
        row = { sampleId: point.sampleId, timestampMs: point.timestampMs, order: nextOrder, values: new Map() };
        nextOrder += 1;
        rowsBySampleId.set(point.sampleId, row);
      }
      row.values.set(currentSeries.key, point.value);
    }
  }

  const rows = [...rowsBySampleId.values()].sort((left, right) => left.timestampMs - right.timestampMs || left.order - right.order);
  const occurrencesByTimestamp = new Map<number, number>();
  let previousTimestampMs = Number.NEGATIVE_INFINITY;
  const timestamps = rows.map((row) => {
    const occurrence = occurrencesByTimestamp.get(row.timestampMs) ?? 0;
    occurrencesByTimestamp.set(row.timestampMs, occurrence + 1);
    const candidate = row.timestampMs + occurrence * DUPLICATE_TIMESTAMP_STEP_MS;
    const timestampMs = Math.max(candidate, previousTimestampMs + DUPLICATE_TIMESTAMP_STEP_MS);
    previousTimestampMs = timestampMs;
    return timestampMs / 1_000;
  });

  return {
    timestamps,
    values: series.map((currentSeries) => rows.map((row) => row.values.get(currentSeries.key) ?? null)),
  };
}

function filteredGapMarkers(gaps: readonly TelemetryGap[], startMs?: number, endMs?: number) {
  const markers: TelemetryChartGapMarker[] = [];
  for (const gap of gaps) {
    const timestampMs = finiteTimestamp(gap.timestamp);
    if (timestampMs === undefined) continue;
    if ((startMs !== undefined && timestampMs < startMs) || (endMs !== undefined && timestampMs > endMs)) continue;
    markers.push({ id: gap.id, timestampMs, type: gap.type, fieldKeys: gap.fieldKeys });
  }
  return markers.sort((left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id));
}

/** Prepares immutable, bounded chart series without mutating telemetry storage. */
export function prepareTelemetryCharts(options: PrepareTelemetryChartsOptions): PreparedTelemetryCharts {
  const window = filterTelemetryWindow(options.samples, options.windowMs, options.endMs);
  const maxPointsPerSeries = clampPositiveInteger(options.maxPointsPerSeries, DEFAULT_MAX_POINTS_PER_SERIES);
  const groups = groupTelemetryFieldsByUnit(options.fields, options.selectedFieldKeys).map((group) => {
    const series = group.fields.map((field) => {
      const rawPoints = pointsForField(field, window.samples);
      const points = decimateTelemetryPoints(rawPoints, maxPointsPerSeries);
      return {
        key: field.key,
        unit: normalizedUnit(field.unit),
        points: Object.freeze(points),
        latest: rawPoints[rawPoints.length - 1],
      } satisfies TelemetryChartSeries;
    });
    return Object.freeze({ ...group, series: Object.freeze(series) }) as TelemetryChartGroup;
  });

  const totalPointCount = groups.reduce(
    (sum, group) => sum + group.series.reduce((seriesSum, series) => seriesSum + series.points.length, 0),
    0,
  );
  return Object.freeze({
    groups: Object.freeze(groups),
    gaps: Object.freeze(filteredGapMarkers(options.gaps, window.startMs, window.endMs)),
    startMs: window.startMs,
    endMs: window.endMs,
    totalPointCount,
  });
}

/** Compact numeric text for axes, legends, and the latest-value readout. */
export function formatTelemetryValue(value: number) {
  if (!Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if ((absolute !== 0 && absolute < 0.001) || absolute >= 100_000) return value.toExponential(2);
  if (absolute >= 100) return value.toFixed(0);
  if (absolute >= 10) return value.toFixed(1).replace(/\.0$/u, '');
  const formatted = value.toFixed(3);
  return formatted.includes('.') ? formatted.replace(/0+$/u, '').replace(/\.$/u, '') : formatted;
}
