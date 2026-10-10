export type TelemetryReplaySource = { id: string; start: number; end: number; origin: number };

/** One playhead advances every capture at the same speed on the aligned timeline. */
export function telemetryReplayTimeline(sources: readonly TelemetryReplaySource[], alignment: 'elapsed' | 'clock', progress: number) {
  const offset = (source: TelemetryReplaySource) => alignment === 'elapsed' ? source.origin : 0;
  const start = sources.length ? Math.min(...sources.map((source) => source.start - offset(source))) : 0;
  const end = sources.length ? Math.max(...sources.map((source) => source.end - offset(source))) : 0;
  const duration = Math.max(0, end - start);
  const position = start + duration * Math.max(0, Math.min(1, progress));
  return { start, end, duration, position, sourceEnds: new Map(sources.map((source) => [source.id, Math.min(source.end, position + offset(source))])) };
}
