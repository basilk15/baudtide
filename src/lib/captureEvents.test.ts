import { describe, expect, it } from 'vitest';
import { eventInspectionRange, loadCaptureMarkers, projectEventMarkers, saveCaptureMarker, type CaptureMarker } from './captureEvents';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const marker: CaptureMarker = { id: 'note-1', kind: 'note', capturePath: '/captures/board.log',
  sourceName: 'Board', timestamp: new Date(12000).toISOString(), label: 'Motor started', note: 'Supply changed to 5V.' };

describe('capture markers and inspection ranges', () => {
  it('retains notes for separate captures through saves and a new reader', () => {
    const disk = storage();
    saveCaptureMarker(marker, disk);
    saveCaptureMarker({ ...marker, id: 'note-2', capturePath: '/other.log' }, disk);
    expect(loadCaptureMarkers(disk)).toEqual([marker, { ...marker, id: 'note-2', capturePath: '/other.log' }]);
    saveCaptureMarker({ ...marker, note: 'Updated observation' }, disk);
    expect(loadCaptureMarkers(disk)).toHaveLength(2);
    expect(loadCaptureMarkers(disk)[0].note).toBe('Updated observation');
  });
  it('never overwrites damaged storage or silently drops invalid records', () => {
    let written = false;
    const disk = { getItem: () => '{broken', setItem: () => { written = true; } };
    expect(() => saveCaptureMarker(marker, disk)).toThrow('Existing notes are preserved');
    expect(written).toBe(false);
    expect(() => loadCaptureMarkers({ getItem: () => JSON.stringify({ version: 1, markers: [marker, { ...marker, timestamp: 'bad' }] }) })).toThrow();
  });
  it('reports quota failures and validates note lengths before writing', () => {
    expect(() => saveCaptureMarker(marker, { getItem: () => null, setItem: () => { throw new Error('Quota'); } })).toThrow('could not be saved');
    expect(() => saveCaptureMarker({ ...marker, label: ' ' }, storage())).toThrow();
    expect(() => saveCaptureMarker({ ...marker, note: 'x'.repeat(2001) }, storage())).toThrow();
  });
  it('projects only this capture into elapsed and clock coordinates', () => {
    const events = [marker, { ...marker, id: 'other', capturePath: '/other.log' }, { ...marker, id: 'outside', timestamp: new Date(30000).toISOString() }];
    const range = { start: 10000, end: 20000 };
    expect(projectEventMarkers(events, marker.capturePath, range, 'elapsed', 100000, marker.id)).toEqual([
      { id: marker.id, timestampMs: 102000, label: marker.label, kind: 'note', selected: true },
    ]);
    expect(projectEventMarkers(events, marker.capturePath, range, 'clock', 0)[0].timestampMs).toBe(12000);
    expect(projectEventMarkers(events, undefined, range, 'clock', 0)).toEqual([]);
  });
  it('uses exact pre/post windows and clamps overlapping capture bounds', () => {
    expect(eventInspectionRange(marker.timestamp, 2, 4)).toEqual({ start: 10000, end: 16000 });
    expect(eventInspectionRange(marker.timestamp, 2, 4, { start: 11000, end: 15000 })).toEqual({ start: 11000, end: 15000 });
    expect(eventInspectionRange(marker.timestamp, 2, 4, { start: 30000, end: 40000 })).toEqual({ start: 10000, end: 16000 });
  });
  it.each([[0, 0], [-1, 2], [NaN, 2], [3601, 1], [1, Infinity]])('rejects invalid window %s/%s', (before, after) => {
    expect(() => eventInspectionRange(marker.timestamp, before, after)).toThrow('Choose up to');
  });
});
