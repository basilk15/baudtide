/** Explicit timelines keep aligned recordings independent of the local timezone. */
export type TelemetryTimeline = { kind: 'elapsed'; originMs: number } | { kind: 'clock' };

export function formatTelemetryElapsedTime(timestamp: number, originMs: number, milliseconds = false) {
  const elapsed = Math.max(0, Math.round(timestamp - originMs));
  const seconds = Math.floor(elapsed / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds / 60) % 60;
  const remainder = seconds % 60;
  const fraction = milliseconds ? `.${String(elapsed % 1_000).padStart(3, '0')}` : '';
  if (hours) return `+${hours}h ${String(minutes).padStart(2, '0')}m ${String(remainder).padStart(2, '0')}${fraction}s`;
  if (minutes) return `+${minutes}m ${String(remainder).padStart(2, '0')}${fraction}s`;
  return `+${remainder}${fraction}s`;
}
