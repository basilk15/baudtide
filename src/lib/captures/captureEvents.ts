import type { CaptureRange } from './captureAnalysis';
import type { WatchHistoryRow } from '../telemetry/watchHistory';

export type CaptureEvent = {
  id: string; kind: 'breach' | 'note' | 'log' | 'command'; capturePath?: string; timestamp: string;
  sourceName: string; label: string; note: string; fieldKey?: string;
};
export type CaptureMarker = CaptureEvent & { kind: 'note'; capturePath: string };
export type PortableCaptureNote = Pick<CaptureMarker, 'timestamp' | 'sourceName' | 'label' | 'note'>;
export type ChartEventMarker = { id: string; timestampMs: number; label: string; kind: CaptureEvent['kind']; selected?: boolean };
const STORAGE_KEY = 'baudtide.capture-markers.v1';
const MAX_MARKERS = 5000;

export function breachCaptureEvent(event: WatchHistoryRow): CaptureEvent {
  return { id: event.id, kind: 'breach', capturePath: event.capturePath, timestamp: event.timestamp,
    sourceName: event.sourceName, fieldKey: event.fieldKey, label: `${event.fieldKey} watch breached`,
    note: `${event.value}${event.unit ? ` ${event.unit}` : ''} · breach ${event.occurrence}` };
}

function validMarker(value: unknown): value is CaptureMarker {
  if (!value || typeof value !== 'object') return false;
  const marker = value as CaptureMarker;
  return marker.kind === 'note' && typeof marker.id === 'string' && marker.id.length > 0
    && typeof marker.capturePath === 'string' && marker.capturePath.length > 0
    && typeof marker.timestamp === 'string' && Number.isFinite(Date.parse(marker.timestamp))
    && typeof marker.sourceName === 'string' && typeof marker.label === 'string' && !!marker.label.trim()
    && marker.label.length <= 120 && typeof marker.note === 'string' && marker.note.length <= 2000;
}

/** Fail closed on damaged storage: adding a note must never overwrite unreadable notes. */
export function loadCaptureMarkers(storage: Pick<Storage, 'getItem'> = localStorage): CaptureMarker[] {
  const text = storage.getItem(STORAGE_KEY);
  if (!text) return [];
  try {
    const library = JSON.parse(text);
    if (library.version !== 1 || !Array.isArray(library.markers) || !library.markers.every(validMarker)
      || new Set(library.markers.map((marker: CaptureMarker) => marker.id)).size !== library.markers.length) throw new Error();
    return library.markers;
  } catch { throw new Error('Saved markers could not be read. Existing notes are preserved; restore the marker storage before adding notes.'); }
}

export function saveCaptureMarker(marker: CaptureMarker, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
  if (!validMarker(marker)) throw new Error('Enter a title and a valid capture time before saving the marker.');
  const markers = loadCaptureMarkers(storage);
  const existing = markers.findIndex((candidate) => candidate.id === marker.id);
  if (existing < 0 && markers.length >= MAX_MARKERS) throw new Error('The local marker library is full. Existing notes are preserved.');
  if (existing < 0) markers.push(marker); else markers[existing] = marker;
  try { storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, markers })); }
  catch { throw new Error('The marker could not be saved. Check available local storage and try again.'); }
  return markers;
}

/** Restore a whole import atomically; stable IDs make retrying safe. */
export function importCaptureMarkers(capturePath: string, importId: string, notes: readonly PortableCaptureNote[], storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
  if (!capturePath || !/^[a-zA-Z0-9-]{1,128}$/.test(importId) || !Array.isArray(notes)) throw new Error('Invalid imported capture notes.');
  const existing = loadCaptureMarkers(storage);
  const imported = notes.map((note, index): CaptureMarker => ({
    id: `bundle-${importId}-${index}`, kind: 'note', capturePath,
    timestamp: note.timestamp, sourceName: note.sourceName, label: note.label, note: note.note,
  }));
  if (!imported.every(validMarker)) throw new Error('Imported capture notes are invalid. Existing notes are preserved.');
  const byId = new Map(existing.map((marker) => [marker.id, marker]));
  const additions = imported.filter((marker) => {
    const prior = byId.get(marker.id);
    if (!prior) return true;
    if (prior.kind !== marker.kind || prior.capturePath !== marker.capturePath || prior.timestamp !== marker.timestamp
      || prior.sourceName !== marker.sourceName || prior.label !== marker.label || prior.note !== marker.note) throw new Error('Imported note conflicts with an existing note. Existing notes are preserved.');
    return false;
  });
  if (existing.length + additions.length > MAX_MARKERS) throw new Error('The local marker library is full. Existing notes are preserved.');
  if (!additions.length) return existing;
  const merged = [...existing, ...additions];
  try { storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, markers: merged })); }
  catch { throw new Error('Imported notes could not be saved. Check available local storage and retry.'); }
  return merged;
}

export function eventInspectionRange(timestamp: string, beforeSeconds: number, afterSeconds: number, bounds?: CaptureRange): CaptureRange {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time) || !Number.isFinite(beforeSeconds) || !Number.isFinite(afterSeconds)
    || beforeSeconds < 0 || afterSeconds < 0 || beforeSeconds > 3600 || afterSeconds > 3600
    || beforeSeconds + afterSeconds === 0) throw new Error('Choose up to 3600 seconds before and after the event, with at least one nonzero duration.');
  const range = { start: time - beforeSeconds * 1000, end: time + afterSeconds * 1000 };
  // A breach can precede the first numeric sample or follow the last one.
  if (!bounds || bounds.end < range.start || bounds.start > range.end) return range;
  return { start: Math.max(bounds.start, range.start), end: Math.min(bounds.end, range.end) };
}

export function projectEventMarkers(events: readonly CaptureEvent[], capturePath: string | undefined, range: CaptureRange,
  alignment: 'elapsed' | 'clock', originMs: number, selectedId?: string): ChartEventMarker[] {
  if (!capturePath) return [];
  return events.filter((event) => event.capturePath === capturePath).flatMap((event) => {
    const time = Date.parse(event.timestamp);
    if (!Number.isFinite(time) || time < range.start || time > range.end) return [];
    return [{ id: event.id, kind: event.kind, label: event.label, selected: event.id === selectedId,
      timestampMs: alignment === 'elapsed' ? originMs + time - range.start : time }];
  });
}
