import type { TelemetrySample } from './telemetry';

type Projection = {
  sourceId: string;
  fieldKeys: ReadonlyMap<string, string>;
  alignment: 'elapsed' | 'clock';
  startMs: number;
  epochMs: number;
  endMs?: number;
};

type CachedReading = {
  timestampMs: number;
  alignedMs: number;
  mapping: string;
  values: TelemetrySample['values'];
  projected: TelemetrySample;
};

/** Reuse plotting metadata for immutable readings; retain every reading/value. */
export class TelemetryProjectionCache {
  private readonly readings = new WeakMap<TelemetrySample, CachedReading>();

  project(samples: readonly TelemetrySample[], options: Projection): TelemetrySample[] {
    const mapping = JSON.stringify([options.sourceId, [...options.fieldKeys]]);
    const output: TelemetrySample[] = [];
    for (const sample of samples) {
      const previous = this.readings.get(sample);
      const timestampMs = previous?.timestampMs ?? Date.parse(sample.timestamp);
      if (timestampMs > (options.endMs ?? Infinity)) continue;
      const alignedMs = options.alignment === 'elapsed'
        ? options.epochMs + Math.max(0, timestampMs - options.startMs) : timestampMs;
      if (previous?.mapping === mapping && previous.alignedMs === alignedMs) {
        output.push(previous.projected);
        continue;
      }
      const timestamp = new Date(alignedMs).toISOString();
      const values = previous?.mapping === mapping ? previous.values : Object.freeze(Object.fromEntries(
        Object.entries(sample.values).flatMap(([key, value]) => {
          const chartKey = options.fieldKeys.get(key);
          return chartKey ? [[chartKey, value]] : [];
        }),
      ));
      const projected = Object.freeze({ ...sample, id: `${options.sourceId}:${sample.id}`, timestamp, values });
      this.readings.set(sample, { timestampMs, alignedMs, mapping, values, projected });
      output.push(projected);
    }
    return output;
  }
}
