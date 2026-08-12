import type { SerialDataEvent } from './serial';

/** The serial formats understood by the live telemetry foundation. */
export type TelemetryFormat = 'json' | 'pairs' | 'csv' | 'tsv';

export type TelemetryValue = {
  value: number;
  /** The unit sent by the device, when its format included one. */
  unit?: string;
};

/** A numeric record recovered from one complete serial line. */
export type TelemetrySample = {
  id: string;
  timestamp: string;
  nativeSessionId: string;
  sequence: number;
  format: TelemetryFormat;
  schemaId: string;
  values: Readonly<Record<string, Readonly<TelemetryValue>>>;
};

export type TelemetryField = {
  key: string;
  unit?: string;
  formats: readonly TelemetryFormat[];
};

/** A discontinuity between two native readers for one stable UI session. */
export type TelemetryGap = {
  id: string;
  type: 'reconnect';
  timestamp: string;
  previousNativeSessionId: string;
  nextNativeSessionId: string;
  nextSequence: number;
};

/** The immutable view consumed by a future visualization screen. */
export type TelemetrySessionSnapshot = {
  sessionKey: string;
  samples: readonly TelemetrySample[];
  fields: readonly TelemetryField[];
  gaps: readonly TelemetryGap[];
  detectedSchemas: readonly { format: TelemetryFormat; schemaId: string }[];
  receivedCompleteLineCount: number;
  acceptedSampleCount: number;
  droppedOverlongLineCount: number;
};

export type TelemetryStoreOptions = {
  /** Maximum retained chart records for each stable session. */
  maxSamplesPerSession?: number;
  /** Maximum reconnect annotations retained for each stable session. */
  maxGapsPerSession?: number;
  /** Maximum number of dormant stable sessions held by this in-memory store. */
  maxSessions?: number;
  /** Maximum parser schemas retained for each stable session. */
  maxDetectedSchemasPerSession?: number;
  /** Maximum field descriptors retained for each stable session. */
  maxFieldsPerSession?: number;
  /** A single un-delimited serial line must not grow without a bound. */
  maxLineLength?: number;
};

export const DEFAULT_MAX_TELEMETRY_SAMPLES = 10_000;
export const DEFAULT_MAX_TELEMETRY_GAPS = 128;
export const DEFAULT_MAX_TELEMETRY_SESSIONS = 32;
export const DEFAULT_MAX_DETECTED_TELEMETRY_SCHEMAS = 128;
export const DEFAULT_MAX_TELEMETRY_FIELDS = 512;
export const DEFAULT_MAX_TELEMETRY_LINE_LENGTH = 16 * 1024;
export const TELEMETRY_EVIDENCE_LINES = 2;

/**
 * Reassembles complete UTF-8 lines from arbitrary byte chunks. CR, LF, and
 * CRLF all terminate one line; a CRLF split across chunks is still one
 * delimiter. TextDecoder's streaming mode deliberately preserves split UTF-8
 * sequences until their remaining bytes arrive.
 */
export class Utf8LineAssembler {
  private readonly decoder = new TextDecoder('utf-8');
  private readonly maxLineLength: number;
  private current = '';
  private skipLineFeed = false;
  private discardingCurrentLine = false;
  private droppedLineCount = 0;

  constructor(options: { maxLineLength?: number } = {}) {
    this.maxLineLength = positiveInteger(options.maxLineLength, DEFAULT_MAX_TELEMETRY_LINE_LENGTH);
  }

  push(bytes: Uint8Array | number[]): string[] {
    return this.consume(this.decoder.decode(Uint8Array.from(bytes), { stream: true }));
  }

  /** Flushes a decoder tail while deliberately retaining an unfinished line. */
  flushDecoder(): string[] {
    return this.consume(this.decoder.decode());
  }

  /** Forget a partial line at a known serial-stream boundary, such as reconnect. */
  reset() {
    this.decoder.decode();
    this.current = '';
    this.skipLineFeed = false;
    this.discardingCurrentLine = false;
  }

  takeDroppedLineCount() {
    const count = this.droppedLineCount;
    this.droppedLineCount = 0;
    return count;
  }

  private consume(text: string) {
    const lines: string[] = [];
    let segmentStart = 0;

    const appendSegment = (segment: string) => {
      if (!segment || this.discardingCurrentLine) return;
      if (this.current.length + segment.length > this.maxLineLength) {
        this.current = '';
        this.discardingCurrentLine = true;
        this.droppedLineCount += 1;
        return;
      }
      this.current += segment;
    };
    const finishLine = () => {
      if (!this.discardingCurrentLine) lines.push(this.current);
      this.current = '';
      this.discardingCurrentLine = false;
    };

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (this.skipLineFeed) {
        this.skipLineFeed = false;
        if (character === '\n') {
          segmentStart = index + 1;
          continue;
        }
      }
      if (character !== '\r' && character !== '\n') continue;
      appendSegment(text.slice(segmentStart, index));
      finishLine();
      if (character === '\r') this.skipLineFeed = true;
      segmentStart = index + 1;
    }
    appendSegment(text.slice(segmentStart));
    return lines;
  }
}

type ParsedRecord = {
  timestamp: string;
  nativeSessionId: string;
  sequence: number;
  format: TelemetryFormat;
  schemaId: string;
  values: Record<string, TelemetryValue>;
};

type LineMetadata = Pick<ParsedRecord, 'timestamp' | 'nativeSessionId' | 'sequence'>;
type DelimitedHeader = { delimiter: ',' | '\t'; fields: Array<{ key: string; unit?: string }> };

const NUMBER_TEXT_SOURCE = '[+-]?(?:(?:\\d+\\.\\d*)|(?:\\d*\\.\\d+)|\\d+)(?:[eE][+-]?\\d+)?';
const FINITE_NUMBER_PATTERN = new RegExp(`^${NUMBER_TEXT_SOURCE}$`);
const NAMED_PAIR_PATTERN = new RegExp(
  `(?:^|[,;|\\s])\\s*([A-Za-z_][A-Za-z0-9_.-]{0,63})\\s*(?:=|:)\\s*(${NUMBER_TEXT_SOURCE})\\s*(%|[A-Za-zµμ°][A-Za-z0-9µμ°/*^._-]{0,23})?(?=$|[,;|\\s])`,
  'gu',
);
const HEADER_UNIT_PATTERN = /^(.*?)\s*(?:\(([^()]+)\)|\[([^\[\]]+)\])\s*$/u;
const MAX_FIELDS_PER_RECORD = 64;
const MAX_PENDING_SCHEMAS = 16;

function positiveInteger(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseFiniteNumber(value: string): number | null {
  if (!FINITE_NUMBER_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: object, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeUnit(value: string | undefined) {
  const unit = value?.trim();
  return unit ? unit : undefined;
}

function buildSchemaId(format: TelemetryFormat, values: Record<string, TelemetryValue>) {
  return `${format}:${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value.unit ?? ''}`)
    .join('|')}`;
}

function parseJsonObject(line: string): Omit<ParsedRecord, keyof LineMetadata> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!recordValue(parsed)) return null;

  const values: Record<string, TelemetryValue> = Object.create(null) as Record<string, TelemetryValue>;
  let invalid = false;
  const flatten = (value: unknown, path: string, depth: number) => {
    if (invalid || depth > 16) {
      invalid = true;
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || !path || hasOwn(values, path) || Object.keys(values).length >= MAX_FIELDS_PER_RECORD) {
        invalid = true;
        return;
      }
      values[path] = { value };
      return;
    }
    if (!recordValue(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const segment = key.trim();
      if (!segment || segment.length > 80) {
        invalid = true;
        return;
      }
      flatten(child, path ? `${path}.${segment}` : segment, depth + 1);
    }
  };
  flatten(parsed, '', 0);
  if (invalid || !Object.keys(values).length) return null;
  return { format: 'json', schemaId: buildSchemaId('json', values), values };
}

function parseNamedPairs(line: string): Omit<ParsedRecord, keyof LineMetadata> | null {
  const values: Record<string, TelemetryValue> = Object.create(null) as Record<string, TelemetryValue>;
  NAMED_PAIR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NAMED_PAIR_PATTERN.exec(line)) !== null) {
    if (Object.keys(values).length >= MAX_FIELDS_PER_RECORD) return null;
    const key = match[1];
    const value = parseFiniteNumber(match[2]);
    if (value === null || hasOwn(values, key)) return null;
    values[key] = { value, unit: normalizeUnit(match[3]) };
  }
  if (!Object.keys(values).length) return null;
  return { format: 'pairs', schemaId: buildSchemaId('pairs', values), values };
}

function parseDelimitedCells(line: string, delimiter: ',' | '\t'): string[] | null {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      if (cell) return null;
      quoted = true;
    } else if (character === delimiter) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  if (quoted) return null;
  cells.push(cell.trim());
  return cells;
}

function headerField(cell: string): { key: string; unit?: string } | null {
  if (!cell || cell.length > 80 || /[\r\n\u0000-\u001F]/u.test(cell)) return null;
  const unitMatch = cell.match(HEADER_UNIT_PATTERN);
  const key = (unitMatch?.[1] ?? cell).trim();
  const unit = normalizeUnit(unitMatch?.[2] ?? unitMatch?.[3]);
  if (!key || key.length > 64) return null;
  return { key, unit };
}

function parseDelimitedHeader(line: string): DelimitedHeader | null {
  const delimiter: ',' | '\t' | null = line.includes('\t') ? '\t' : line.includes(',') ? ',' : null;
  if (!delimiter) return null;
  const cells = parseDelimitedCells(line, delimiter);
  if (!cells || cells.length < 2 || cells.length > MAX_FIELDS_PER_RECORD) return null;
  const fields = cells.map(headerField);
  if (
    fields.some((field) => !field || !/[A-Za-z]/u.test(field.key))
    || new Set(fields.map((field) => field!.key)).size !== fields.length
  ) return null;
  return { delimiter, fields: fields as Array<{ key: string; unit?: string }> };
}

function parseDelimitedRecord(line: string, header: DelimitedHeader): Omit<ParsedRecord, keyof LineMetadata> | null {
  const cells = parseDelimitedCells(line, header.delimiter);
  if (!cells || cells.length !== header.fields.length) return null;
  const values: Record<string, TelemetryValue> = Object.create(null) as Record<string, TelemetryValue>;
  cells.forEach((cell, index) => {
    const value = parseFiniteNumber(cell);
    if (value !== null) values[header.fields[index].key] = { value, unit: header.fields[index].unit };
  });
  if (!Object.keys(values).length) return null;
  const format: TelemetryFormat = header.delimiter === ',' ? 'csv' : 'tsv';
  return { format, schemaId: buildSchemaId(format, values), values };
}

/**
 * Stateful line parser. A schema is only accepted after two matching complete
 * records, preventing a solitary number in normal terminal output from being
 * mistaken for chart data. The first matching record is retained and emitted
 * once the second confirms it.
 */
export class TelemetryLineParser {
  private readonly pendingBySchema = new Map<string, ParsedRecord[]>();
  private readonly detectedSchemaIds = new Set<string>();
  private delimitedHeader: DelimitedHeader | null = null;
  private readonly maxDetectedSchemas: number;

  constructor(options: { maxDetectedSchemas?: number } = {}) {
    this.maxDetectedSchemas = positiveInteger(options.maxDetectedSchemas, DEFAULT_MAX_DETECTED_TELEMETRY_SCHEMAS);
  }

  pushLine(line: string, metadata: LineMetadata): ParsedRecord[] {
    const json = parseJsonObject(line);
    if (json) return this.accept({ ...metadata, ...json });

    const pairs = parseNamedPairs(line);
    if (pairs) return this.accept({ ...metadata, ...pairs });

    const nextHeader = parseDelimitedHeader(line);
    if (nextHeader) {
      this.delimitedHeader = nextHeader;
      return [];
    }
    const delimited = this.delimitedHeader ? parseDelimitedRecord(line, this.delimitedHeader) : null;
    return delimited ? this.accept({ ...metadata, ...delimited }) : [];
  }

  /** Do not let a partial candidate or CSV header cross a physical reconnect. */
  resetForStreamBoundary() {
    this.pendingBySchema.clear();
    this.delimitedHeader = null;
  }

  detectedSchemas() {
    return [...this.detectedSchemaIds].map((schemaId) => ({
      schemaId,
      format: schemaId.slice(0, schemaId.indexOf(':')) as TelemetryFormat,
    }));
  }

  private accept(record: ParsedRecord) {
    if (this.detectedSchemaIds.has(record.schemaId)) return [record];
    const pending = this.pendingBySchema.get(record.schemaId) ?? [];
    pending.push(record);
    this.pendingBySchema.delete(record.schemaId);
    this.pendingBySchema.set(record.schemaId, pending);
    while (this.pendingBySchema.size > MAX_PENDING_SCHEMAS) {
      const oldest = this.pendingBySchema.keys().next().value;
      if (oldest === undefined) break;
      this.pendingBySchema.delete(oldest);
    }
    if (pending.length < TELEMETRY_EVIDENCE_LINES) return [];
    this.pendingBySchema.delete(record.schemaId);
    while (this.detectedSchemaIds.size >= this.maxDetectedSchemas) {
      const oldest = this.detectedSchemaIds.values().next().value;
      if (oldest === undefined) break;
      this.detectedSchemaIds.delete(oldest);
    }
    this.detectedSchemaIds.add(record.schemaId);
    return pending;
  }
}

type MutableTelemetryField = {
  key: string;
  unit?: string;
  formats: TelemetryFormat[];
};

type InternalSession = {
  assembler: Utf8LineAssembler;
  parser: TelemetryLineParser;
  samples: TelemetrySample[];
  fields: Map<string, MutableTelemetryField>;
  gaps: TelemetryGap[];
  latestNativeSessionId: string | null;
  nextSampleId: number;
  nextGapId: number;
  receivedCompleteLineCount: number;
  acceptedSampleCount: number;
  droppedOverlongLineCount: number;
  snapshot: TelemetrySessionSnapshot | null;
};

/**
 * Bounded, in-memory telemetry data organized by App's stable `LiveSession`
 * `uiKey`, not the short-lived backend serial-session ID. It intentionally has
 * no Tauri listener: LiveMonitor gives it only the already ordered stream.
 */
export class TelemetrySessionStore {
  private readonly maxSamplesPerSession: number;
  private readonly maxGapsPerSession: number;
  private readonly maxSessions: number;
  private readonly maxDetectedSchemasPerSession: number;
  private readonly maxFieldsPerSession: number;
  private readonly maxLineLength: number;
  private readonly sessions = new Map<string, InternalSession>();
  private readonly subscribers = new Map<string, Set<() => void>>();
  /** Cached empty snapshots are bounded except for active external subscribers. */
  private readonly emptySnapshots = new Map<string, TelemetrySessionSnapshot>();

  constructor(options: TelemetryStoreOptions = {}) {
    this.maxSamplesPerSession = positiveInteger(options.maxSamplesPerSession, DEFAULT_MAX_TELEMETRY_SAMPLES);
    this.maxGapsPerSession = positiveInteger(options.maxGapsPerSession, DEFAULT_MAX_TELEMETRY_GAPS);
    this.maxSessions = positiveInteger(options.maxSessions, DEFAULT_MAX_TELEMETRY_SESSIONS);
    this.maxDetectedSchemasPerSession = positiveInteger(options.maxDetectedSchemasPerSession, DEFAULT_MAX_DETECTED_TELEMETRY_SCHEMAS);
    this.maxFieldsPerSession = positiveInteger(options.maxFieldsPerSession, DEFAULT_MAX_TELEMETRY_FIELDS);
    this.maxLineLength = positiveInteger(options.maxLineLength, DEFAULT_MAX_TELEMETRY_LINE_LENGTH);
  }

  /** Ingest one event after LiveMonitor has placed it in native sequence order. */
  ingestOrderedSerialEvent(sessionKey: string, event: SerialDataEvent) {
    if (!sessionKey) return;
    const session = this.ensureSession(sessionKey);
    this.invalidateSnapshot(session);
    if (session.latestNativeSessionId && session.latestNativeSessionId !== event.sessionId) {
      session.assembler.reset();
      session.parser.resetForStreamBoundary();
      session.gaps.push({
        id: `${sessionKey}:gap:${++session.nextGapId}`,
        type: 'reconnect',
        timestamp: event.timestamp,
        previousNativeSessionId: session.latestNativeSessionId,
        nextNativeSessionId: event.sessionId,
        nextSequence: event.sequence,
      });
      if (session.gaps.length > this.maxGapsPerSession) session.gaps.splice(0, session.gaps.length - this.maxGapsPerSession);
    }
    session.latestNativeSessionId = event.sessionId;

    const lines = session.assembler.push(event.bytes);
    session.droppedOverlongLineCount += session.assembler.takeDroppedLineCount();
    for (const line of lines) {
      session.receivedCompleteLineCount += 1;
      const records = session.parser.pushLine(line, {
        timestamp: event.timestamp,
        nativeSessionId: event.sessionId,
        sequence: event.sequence,
      });
      for (const record of records) this.appendRecord(sessionKey, session, record);
    }
    this.emit(sessionKey);
  }

  /** A future screen can use this with useSyncExternalStore. */
  subscribe(sessionKey: string, listener: () => void) {
    const listeners = this.subscribers.get(sessionKey) ?? new Set<() => void>();
    listeners.add(listener);
    this.subscribers.set(sessionKey, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        this.subscribers.delete(sessionKey);
        this.trimEmptySnapshots();
      }
    };
  }

  getSnapshot(sessionKey: string): TelemetrySessionSnapshot {
    const session = this.sessions.get(sessionKey);
    if (!session) return this.getEmptySnapshot(sessionKey);
    if (!session.snapshot) session.snapshot = createSnapshot(sessionKey, session);
    return session.snapshot;
  }

  /** Release a closed UI session explicitly when a future owner no longer needs it. */
  removeSession(sessionKey: string) {
    this.sessions.delete(sessionKey);
    this.emptySnapshots.set(sessionKey, emptySnapshot(sessionKey));
    this.trimEmptySnapshots();
    this.emit(sessionKey);
  }

  private ensureSession(sessionKey: string) {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      // Map insertion order serves as a bounded, simple LRU for inactive tabs.
      this.sessions.delete(sessionKey);
      this.sessions.set(sessionKey, existing);
      return existing;
    }
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
      this.emptySnapshots.set(oldest, emptySnapshot(oldest));
      this.emit(oldest);
    }
    const created: InternalSession = {
      assembler: new Utf8LineAssembler({ maxLineLength: this.maxLineLength }),
      parser: new TelemetryLineParser({ maxDetectedSchemas: this.maxDetectedSchemasPerSession }),
      samples: [],
      fields: new Map(),
      gaps: [],
      latestNativeSessionId: null,
      nextSampleId: 0,
      nextGapId: 0,
      receivedCompleteLineCount: 0,
      acceptedSampleCount: 0,
      droppedOverlongLineCount: 0,
      snapshot: null,
    };
    this.emptySnapshots.delete(sessionKey);
    this.sessions.set(sessionKey, created);
    this.trimEmptySnapshots();
    return created;
  }

  private appendRecord(sessionKey: string, session: InternalSession, record: ParsedRecord) {
    const sample: TelemetrySample = {
      id: `${sessionKey}:sample:${++session.nextSampleId}`,
      timestamp: record.timestamp,
      nativeSessionId: record.nativeSessionId,
      sequence: record.sequence,
      format: record.format,
      schemaId: record.schemaId,
      values: cloneValues(record.values),
    };
    session.samples.push(sample);
    if (session.samples.length > this.maxSamplesPerSession) session.samples.splice(0, session.samples.length - this.maxSamplesPerSession);
    session.acceptedSampleCount += 1;
    for (const [key, value] of Object.entries(sample.values)) {
      const existing = session.fields.get(key);
      if (existing) {
        if (!existing.formats.includes(sample.format)) existing.formats.push(sample.format);
        if (!existing.unit && value.unit) existing.unit = value.unit;
      } else {
        while (session.fields.size >= this.maxFieldsPerSession) {
          const oldest = session.fields.keys().next().value;
          if (oldest === undefined) break;
          session.fields.delete(oldest);
        }
        session.fields.set(key, { key, unit: value.unit, formats: [sample.format] });
      }
    }
  }

  private emit(sessionKey: string) {
    this.subscribers.get(sessionKey)?.forEach((listener) => {
      try {
        listener();
      } catch {
        // Telemetry is an optional observer. One faulty UI subscriber must not
        // disrupt serial ingestion or other subscribers.
      }
    });
  }

  private invalidateSnapshot(session: InternalSession) {
    session.snapshot = null;
  }

  private getEmptySnapshot(sessionKey: string) {
    const existing = this.emptySnapshots.get(sessionKey);
    if (existing) {
      this.emptySnapshots.delete(sessionKey);
      this.emptySnapshots.set(sessionKey, existing);
      return existing;
    }
    const snapshot = emptySnapshot(sessionKey);
    this.emptySnapshots.set(sessionKey, snapshot);
    this.trimEmptySnapshots();
    return snapshot;
  }

  private trimEmptySnapshots() {
    while (this.emptySnapshots.size > this.maxSessions) {
      const candidate = [...this.emptySnapshots.keys()].find((key) => !this.subscribers.has(key));
      if (!candidate) return;
      this.emptySnapshots.delete(candidate);
    }
  }
}

function cloneValues(values: Readonly<Record<string, Readonly<TelemetryValue>>>): Readonly<Record<string, Readonly<TelemetryValue>>> {
  const entries = Object.entries(values).map(([key, value]) => [key, Object.freeze({ ...value })] as const);
  return Object.freeze(Object.fromEntries(entries));
}

function cloneSample(sample: TelemetrySample): TelemetrySample {
  return Object.freeze({ ...sample, values: cloneValues(sample.values) });
}

function createSnapshot(sessionKey: string, session: InternalSession): TelemetrySessionSnapshot {
  return Object.freeze({
    sessionKey,
    samples: Object.freeze(session.samples.map(cloneSample)),
    fields: Object.freeze([...session.fields.values()].map((field) => Object.freeze({
      ...field,
      formats: Object.freeze([...field.formats]),
    }))),
    gaps: Object.freeze(session.gaps.map((gap) => Object.freeze({ ...gap }))),
    detectedSchemas: Object.freeze(session.parser.detectedSchemas().map((schema) => Object.freeze({ ...schema }))),
    receivedCompleteLineCount: session.receivedCompleteLineCount,
    acceptedSampleCount: session.acceptedSampleCount,
    droppedOverlongLineCount: session.droppedOverlongLineCount,
  });
}

function emptySnapshot(sessionKey: string): TelemetrySessionSnapshot {
  return Object.freeze({
    sessionKey,
    samples: Object.freeze([]),
    fields: Object.freeze([]),
    gaps: Object.freeze([]),
    detectedSchemas: Object.freeze([]),
    receivedCompleteLineCount: 0,
    acceptedSampleCount: 0,
    droppedOverlongLineCount: 0,
  });
}

/** Shared live registry. It is deliberately fed by LiveMonitor, never Tauri directly. */
export const liveTelemetryStore = new TelemetrySessionStore();
