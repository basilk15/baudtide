import type { SavedLog } from '../serial/serial';
import type { TelemetryDecoderProfile } from '../telemetry/telemetryDecoders';
import type { CaptureRange } from './captureAnalysis';

/** A recording must be reindexed after it stops, without losing its analysis settings. */
export function comparisonReloadOptions(indexedState: SavedLog['state'] | undefined, currentState: SavedLog['state'], profile?: TelemetryDecoderProfile, requestedRange?: CaptureRange): { replace: boolean; profile?: TelemetryDecoderProfile; requestedRange?: CaptureRange } {
  return indexedState === 'capturing' && currentState !== 'capturing' ? { replace: true, profile, requestedRange } : { replace: false };
}
