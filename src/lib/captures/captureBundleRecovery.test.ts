import { describe, expect, it } from 'vitest';
import { restoreCaptureBundleMetadata, decoderForImportedCapture } from './captureBundleRecovery';
import { loadCaptureMarkers } from './captureEvents';
import type { PendingCaptureBundle } from '../serial/serial';

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const decoder = { version: 1 as const, id: 'old', name: 'Sensor', prefix: '', separator: 'comma' as const, fields: [{ column: 1, name: 'temperature', unit: 'C' }], createdAt: 1, updatedAt: 1 };
const pending: PendingCaptureBundle = { id: '1234-abcd', capturePath: '/new.log', metadata: { name: 'Board', decoder, notes: [{ timestamp: '2026-01-01T00:00:01.000Z', sourceName: 'Board', label: 'Spike', note: 'Reset' }] } };

describe('capture bundle metadata recovery', () => {
  it('restores notes and decoder to the imported path and is safe to retry', () => {
    const storage = memory();
    restoreCaptureBundleMetadata(pending, storage);
    restoreCaptureBundleMetadata(pending, storage);
    expect(loadCaptureMarkers(storage)).toHaveLength(1);
    expect(loadCaptureMarkers(storage)[0].capturePath).toBe('/new.log');
    expect(decoderForImportedCapture('/new.log', storage)?.name).toBe('Sensor');
  });
  it('preserves damaged associations and offers a recoverable failure', () => {
    const storage = memory(); storage.setItem('baudtide.capture-decoders.v1', '{bad');
    expect(() => restoreCaptureBundleMetadata(pending, storage)).toThrow();
    expect(storage.getItem('baudtide.capture-decoders.v1')).toBe('{bad');
  });
});
