import { describe, expect, it } from 'vitest';
import { TelemetryLineParser, TelemetrySessionStore, Utf8LineAssembler } from './telemetry';
import type { SerialDataEvent } from './serial';

const encoder = new TextEncoder();

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

describe('Utf8LineAssembler', () => {
  it('preserves split UTF-8 characters and recognizes CR, LF, and split CRLF', () => {
    const assembler = new Utf8LineAssembler();
    const source = encoder.encode('µ=1\r\n温度=2\nthird=3\rfourth');
    const lines = [
      ...assembler.push(source.slice(0, 1)),
      ...assembler.push(source.slice(1, 5)),
      ...assembler.push(source.slice(5, 12)),
      ...assembler.push(source.slice(12)),
    ];

    expect(lines).toEqual(['µ=1', '温度=2', 'third=3']);
    expect(assembler.flushDecoder()).toEqual([]);
  });

  it('never retains an unbounded unterminated line', () => {
    const assembler = new Utf8LineAssembler({ maxLineLength: 5 });

    expect(assembler.push(encoder.encode('123456\nok\n'))).toEqual(['ok']);
    expect(assembler.takeDroppedLineCount()).toBe(1);
  });
});

describe('TelemetryLineParser', () => {
  const metadata = (sequence: number) => ({
    timestamp: `2026-08-10T10:00:${String(sequence).padStart(2, '0')}.000Z`,
    nativeSessionId: 'native-a',
    sequence,
  });

  it('requires repeated JSON evidence and flattens nested finite numeric leaves', () => {
    const parser = new TelemetryLineParser();
    const json = '{"sensor":{"voltage":3.3,"current":0.12},"label":"ESP32","valid":true}';

    expect(parser.pushLine(json, metadata(1))).toEqual([]);
    const accepted = parser.pushLine(json, metadata(2));

    expect(accepted).toHaveLength(2);
    expect(accepted[0].values).toEqual({
      'sensor.voltage': { value: 3.3 },
      'sensor.current': { value: 0.12 },
    });
    expect(parser.pushLine('{"sensor":{"voltage":"3.3"}}', metadata(3))).toEqual([]);
    expect(parser.pushLine('{not valid JSON}', metadata(4))).toEqual([]);
  });

  it('parses named pairs with units but ignores solitary or non-finite values', () => {
    const parser = new TelemetryLineParser();
    const line = 'temperature=24.5 C humidity: 60 %';

    expect(parser.pushLine(line, metadata(1))).toEqual([]);
    expect(parser.pushLine('unrelated diagnostic 42', metadata(2))).toEqual([]);
    const accepted = parser.pushLine(line, metadata(3));

    expect(accepted).toHaveLength(2);
    expect(accepted[0].values).toEqual({
      temperature: { value: 24.5, unit: 'C' },
      humidity: { value: 60, unit: '%' },
    });
    expect(parser.pushLine('temperature=Infinity', metadata(4))).toEqual([]);
    expect(parser.pushLine('temperature=NaN', metadata(5))).toEqual([]);
  });

  it('requires a header and repeated numeric rows for CSV/TSV, including schema changes', () => {
    const parser = new TelemetryLineParser();

    expect(parser.pushLine('time,temp [C],humidity (%)', metadata(1))).toEqual([]);
    expect(parser.pushLine('1,20.5,"unterminated', metadata(2))).toEqual([]);
    expect(parser.pushLine('1,20.5,40', metadata(2))).toEqual([]);
    const csv = parser.pushLine('2,21.0,41', metadata(3));
    expect(csv).toHaveLength(2);
    expect(csv[0].format).toBe('csv');
    expect(csv[0].values).toEqual({
      time: { value: 1 },
      temp: { value: 20.5, unit: 'C' },
      humidity: { value: 40, unit: '%' },
    });

    expect(parser.pushLine('time\tpressure [hPa]\ttext', metadata(4))).toEqual([]);
    expect(parser.pushLine('3\t1013.2\tok', metadata(5))).toEqual([]);
    const tsv = parser.pushLine('4\t1013.4\tok', metadata(6));
    expect(tsv).toHaveLength(2);
    expect(tsv[0].format).toBe('tsv');
    expect(tsv[0].values).toEqual({ time: { value: 3 }, pressure: { value: 1013.2, unit: 'hPa' } });
  });
});

describe('TelemetrySessionStore', () => {
  it('returns one cached immutable snapshot until a mutation invalidates it', () => {
    const store = new TelemetrySessionStore();
    const emptyBefore = store.getSnapshot('stable-ui-key');
    expect(store.getSnapshot('stable-ui-key')).toBe(emptyBefore);

    store.ingestOrderedSerialEvent('stable-ui-key', event('native-a', 1, 'temp=1\n'));
    const afterIngest = store.getSnapshot('stable-ui-key');
    expect(afterIngest).not.toBe(emptyBefore);
    expect(store.getSnapshot('stable-ui-key')).toBe(afterIngest);
    expect(Object.isFrozen(afterIngest)).toBe(true);
    expect(Object.isFrozen(afterIngest.samples)).toBe(true);
  });

  it('does not notify subscribers for chunks that have not completed a telemetry line', () => {
    const store = new TelemetrySessionStore();
    let subscriberCalls = 0;
    store.subscribe('stable-ui-key', () => { subscriberCalls += 1; });

    store.ingestOrderedSerialEvent('stable-ui-key', event('native-a', 1, 'temp='));
    expect(subscriberCalls).toBe(0);

    store.ingestOrderedSerialEvent('stable-ui-key', event('native-a', 2, '1\n'));
    expect(subscriberCalls).toBe(1);
  });

  it('contains subscriber failures and safely notifies an evicted session', () => {
    const store = new TelemetrySessionStore({ maxSessions: 1 });
    let healthySubscriberCalls = 0;
    store.subscribe('first', () => { throw new Error('observer failed'); });
    store.subscribe('first', () => { healthySubscriberCalls += 1; });

    expect(() => store.ingestOrderedSerialEvent('first', event('native-a', 1, 'temp=1\n'))).not.toThrow();
    const firstSnapshot = store.getSnapshot('first');
    expect(() => store.ingestOrderedSerialEvent('second', event('native-b', 1, 'temp=2\n'))).not.toThrow();

    expect(healthySubscriberCalls).toBe(2);
    expect(store.getSnapshot('first')).not.toBe(firstSnapshot);
    expect(store.getSnapshot('first').samples).toEqual([]);
  });

  it('uses the stable UI key, bounds samples, and marks a native-session reconnect gap', () => {
    const store = new TelemetrySessionStore({ maxSamplesPerSession: 2, maxGapsPerSession: 1, maxSessions: 2 });

    store.ingestOrderedSerialEvent('stable-ui-key', event('native-a', 1, 'temp=1\n'));
    store.ingestOrderedSerialEvent('stable-ui-key', event('native-a', 2, 'temp=2\n'));
    store.ingestOrderedSerialEvent('stable-ui-key', event('native-a', 3, 'temp=3\n'));
    store.ingestOrderedSerialEvent('stable-ui-key', event('native-b', 1, 'temp=4\n'));

    const snapshot = store.getSnapshot('stable-ui-key');
    expect(snapshot.samples.map((sample) => sample.values.temp.value)).toEqual([3, 4]);
    expect(snapshot.samples.map((sample) => sample.nativeSessionId)).toEqual(['native-a', 'native-b']);
    expect(snapshot.gaps).toEqual([expect.objectContaining({
      type: 'reconnect',
      previousNativeSessionId: 'native-a',
      nextNativeSessionId: 'native-b',
      nextSequence: 1,
    })]);
    expect(snapshot.acceptedSampleCount).toBe(4);
    expect(store.getSnapshot('another-stable-ui-key').samples).toEqual([]);
  });

  it('keeps chunked lines together and drops malformed values before buffering samples', () => {
    const store = new TelemetrySessionStore();

    store.ingestOrderedSerialEvent('ui-key', event('native-a', 1, '{"sensor":{"v":3'));
    store.ingestOrderedSerialEvent('ui-key', event('native-a', 2, '.3}}\n'));
    store.ingestOrderedSerialEvent('ui-key', event('native-a', 3, '{"sensor":{"v":3.4}}\n'));
    store.ingestOrderedSerialEvent('ui-key', event('native-a', 4, '{"sensor":{"v":"3.5"}}\n'));

    const snapshot = store.getSnapshot('ui-key');
    expect(snapshot.samples).toHaveLength(2);
    expect(snapshot.samples.map((sample) => sample.values['sensor.v'].value)).toEqual([3.3, 3.4]);
    expect(snapshot.receivedCompleteLineCount).toBe(3);
  });

  it('caps dynamic detected schemas and accumulated field descriptors', () => {
    const store = new TelemetrySessionStore({
      maxDetectedSchemasPerSession: 2,
      maxFieldsPerSession: 3,
      maxSamplesPerSession: 16,
    });

    for (let index = 1; index <= 4; index += 1) {
      store.ingestOrderedSerialEvent('ui-key', event('native-a', index * 2 - 1, `field${index}=1\n`));
      store.ingestOrderedSerialEvent('ui-key', event('native-a', index * 2, `field${index}=2\n`));
    }

    const snapshot = store.getSnapshot('ui-key');
    expect(snapshot.detectedSchemas).toHaveLength(2);
    expect(snapshot.detectedSchemas.map((schema) => schema.schemaId)).toEqual([
      'pairs:field3=',
      'pairs:field4=',
    ]);
    expect(snapshot.fields.map((field) => field.key)).toEqual(['field2', 'field3', 'field4']);
    expect(snapshot.samples).toHaveLength(8);
  });
});
