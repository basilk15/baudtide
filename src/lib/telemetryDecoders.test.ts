import { describe, expect, it } from 'vitest';
import {
  createTelemetryDecoderProfile,
  defaultTelemetryDecoderDraft,
  parseCustomTelemetryLine,
  validateTelemetryDecoderDraft,
  type TelemetryDecoderProfileDraft,
} from './telemetryDecoders';
import { telemetrySnapshotFromCapture, TelemetryLineParser, TelemetrySessionStore } from './telemetry';
import type { SerialDataEvent } from './serial';

const encoder = new TextEncoder();

const draft: TelemetryDecoderProfileDraft = {
  name: 'Weather node',
  prefix: 'SAMPLE:',
  separator: 'comma',
  fields: [
    { column: 1, name: 'temperature', unit: '°C' },
    { column: 2, name: 'humidity', unit: '%' },
    { column: 3, name: 'pressure', unit: 'hPa' },
  ],
};

const profile = createTelemetryDecoderProfile(draft, undefined, 1_000);

function event(sessionId: string, sequence: number, text: string): SerialDataEvent {
  return {
    sessionId,
    port: '/dev/test',
    sequence,
    timestamp: `2026-08-10T10:00:${String(sequence).padStart(2, '0')}.000Z`,
    text,
    bytes: [...encoder.encode(text)],
  };
}

describe('custom telemetry decoder profiles', () => {
  it('starts custom mapping with an unprefixed numeric-column example', () => {
    const defaults = defaultTelemetryDecoderDraft();
    expect(defaults.prefix).toBe('');
    expect(defaults.separator).toBe('comma');
    expect(parseCustomTelemetryLine('23.8, 51.2, 3.31', defaults)).toEqual({
      signal_1: { value: 23.8 },
      signal_2: { value: 51.2 },
      signal_3: { value: 3.31 },
    });
  });

  it('maps prefixed delimited columns to named numeric values', () => {
    expect(parseCustomTelemetryLine('SAMPLE: 23.8, 51.2, 1010.4', profile)).toEqual({
      temperature: { value: 23.8, unit: '°C' },
      humidity: { value: 51.2, unit: '%' },
      pressure: { value: 1010.4, unit: 'hPa' },
    });
    expect(parseCustomTelemetryLine('OTHER: 23.8, 51.2, 1010.4', profile)).toBeNull();
    expect(parseCustomTelemetryLine('SAMPLE: 23.8, offline, 1010.4', profile)).toBeNull();
  });

  it('validates duplicate names and column mappings before saving', () => {
    expect(validateTelemetryDecoderDraft({ ...draft, fields: [{ column: 1, name: 'same' }, { column: 1, name: 'other' }] })).toBe('Each column can be mapped only once.');
    expect(validateTelemetryDecoderDraft({ ...draft, fields: [{ column: 1, name: 'same' }, { column: 2, name: 'SAME' }] })).toBe('Signal names must be unique within a profile.');
  });

  it('requires two matching custom records just like automatic telemetry detection', () => {
    const parser = new TelemetryLineParser({ decoderProfile: profile });
    const metadata = (sequence: number) => ({
      timestamp: `2026-08-10T10:00:${String(sequence).padStart(2, '0')}.000Z`,
      nativeSessionId: 'native-a',
      sequence,
    });

    expect(parser.pushLine('SAMPLE: 23.8, 51.2, 1010.4', metadata(1))).toEqual([]);
    const accepted = parser.pushLine('SAMPLE: 24.0, 50.9, 1010.7', metadata(2));
    expect(accepted).toHaveLength(2);
    expect(accepted[0].format).toBe('custom');
    expect(accepted[0].values.temperature.value).toBe(23.8);
    expect(parser.detectedSchemas()).toEqual([expect.objectContaining({ format: 'custom' })]);
  });

  it('can switch one live store session back to automatic detection', () => {
    const store = new TelemetrySessionStore();
    store.setDecoderProfile('stable-ui-key', profile);
    store.ingestOrderedSerialEvent('stable-ui-key', event('native-a', 1, 'SAMPLE: 1, 2, 3\n'));
    store.ingestOrderedSerialEvent('stable-ui-key', event('native-a', 2, 'SAMPLE: 4, 5, 6\n'));
    expect(store.getSnapshot('stable-ui-key').decoderProfile?.id).toBe(profile.id);
    expect(store.getSnapshot('stable-ui-key').fields.map((field) => field.key)).toEqual(['temperature', 'humidity', 'pressure']);

    store.setDecoderProfile('stable-ui-key');
    store.ingestOrderedSerialEvent('stable-ui-key', event('native-a', 3, 'temperature=30 C\n'));
    store.ingestOrderedSerialEvent('stable-ui-key', event('native-a', 4, 'temperature=31 C\n'));
    const snapshot = store.getSnapshot('stable-ui-key');
    expect(snapshot.decoderProfile).toBeUndefined();
    expect(snapshot.samples.map((sample) => sample.values.temperature.value)).toEqual([30, 31]);
  });

  it('uses the same custom decoder for saved-capture replay', () => {
    const snapshot = telemetrySnapshotFromCapture('recorded:weather', 'SAMPLE: 20, 40, 1000\nSAMPLE: 21, 41, 1001\n', {
      decoderProfile: profile,
      startedAt: '2026-08-10T10:00:00.000Z',
      endedAt: '2026-08-10T10:00:01.000Z',
    });
    expect(snapshot.decoderProfile?.name).toBe('Weather node');
    expect(snapshot.samples.map((sample) => sample.values.temperature.value)).toEqual([20, 21]);
  });
});
