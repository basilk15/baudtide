import { importCaptureMarkers } from './captureEvents';
import { importTelemetryDecoderProfile, normalizeTelemetryDecoderProfile, type TelemetryDecoderProfile } from '../telemetry/telemetryDecoders';
import type { PendingCaptureBundle } from '../serial/serial';

const ASSOCIATIONS = 'baudtide.capture-decoders.v1';
const DECODERS = 'baudtide.telemetry-decoder-profiles.v1';
type BundleStorage = Pick<Storage, 'getItem' | 'setItem'>;

function readAssociations(storage: BundleStorage): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(ASSOCIATIONS) ?? '{"version":1,"bindings":{}}');
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) throw new Error();
    const bindings = (parsed as { bindings?: unknown }).bindings;
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) || Object.entries(bindings).some(([key, value]) => !key || typeof value !== 'string' || !value)) throw new Error();
    return Object.assign(Object.create(null) as Record<string, string>, bindings);
  } catch { throw new Error('Capture decoder associations could not be read. Existing data is preserved.'); }
}

/** A persistent native recovery record stays pending until every write succeeds. */
export function restoreCaptureBundleMetadata(pending: PendingCaptureBundle, storage: BundleStorage = localStorage, skipNotes = false) {
  const { id, capturePath, metadata } = pending;
  if (!metadata || !Array.isArray(metadata.notes)) throw new Error('The imported capture metadata is invalid.');
  const bindings = metadata.decoder ? readAssociations(storage) : null;
  if (!skipNotes && metadata.notes.length) importCaptureMarkers(capturePath, id, metadata.notes, storage);
  if (metadata.decoder) {
    const profile = importTelemetryDecoderProfile(metadata.decoder, id, storage);
    if (typeof window !== 'undefined' && storage === window.localStorage) window.dispatchEvent(new Event('baudtide:decoder-profiles-changed'));
    if (bindings![capturePath] && bindings![capturePath] !== profile.id) throw new Error('This capture already has a different decoder. Existing data is preserved.');
    bindings![capturePath] = profile.id;
    try { storage.setItem(ASSOCIATIONS, JSON.stringify({ version: 1, bindings })); }
    catch { throw new Error('The capture decoder could not be linked. Free local storage and retry.'); }
  }
}

export function decoderForImportedCapture(capturePath: string, storage: BundleStorage = localStorage): TelemetryDecoderProfile | undefined {
  try {
    const id = readAssociations(storage)[capturePath];
    if (!id) return undefined;
    const profiles: unknown = JSON.parse(storage.getItem(DECODERS) ?? '[]');
    if (!Array.isArray(profiles)) return undefined;
    return profiles.map(normalizeTelemetryDecoderProfile).find((profile) => profile?.id === id) ?? undefined;
  } catch { return undefined; }
}
