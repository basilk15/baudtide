import { closeNativeCaptureAnalysis, openNativeCaptureAnalysis, readNativeCaptureAnalysisChunk, type SavedLog } from './serial';
import { TelemetrySessionStore, type TelemetrySample, type TelemetrySessionSnapshot } from './telemetry';
import type { TelemetryDecoderProfile } from './telemetryDecoders';

export type CaptureRange = { start: number; end: number };
type SamplePage = { samples: TelemetrySample[]; start: number; end: number };
export interface CapturePageStore {
  put(id: string, page: number, value: SamplePage): Promise<void>;
  get(id: string, page: number): Promise<SamplePage>;
  release(id: string): Promise<void>;
  matching?(id: string, range: CaptureRange, signal?: AbortSignal): AsyncIterable<number>;
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('baudtide-analysis-cache', 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('pages')) request.result.createObjectStore('pages');
      if (!request.result.objectStoreNames.contains('bounds')) request.result.createObjectStore('bounds');
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      // A renderer restart has no live readers. Discard only its old derived cache,
      // which can always be rebuilt from the unchanged capture library.
      const tx = db.transaction(['pages', 'bounds'], 'readwrite');
      tx.objectStore('pages').clear();
      tx.objectStore('bounds').clear();
      tx.oncomplete = () => resolve(db);
      tx.onabort = () => { database = undefined; reject(new Error('Could not prepare the analysis cache.')); };
    };
    request.onerror = () => { database = undefined; reject(new Error('Analysis cache is unavailable. Check available disk space and try again.')); };
    request.onblocked = () => { database = undefined; reject(new Error('Close other BaudTide analysis windows and reopen the capture to update its cache.')); };
  });
}

export const diskCapturePages: CapturePageStore = {
  async put(id, page, value) {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['pages', 'bounds'], 'readwrite');
      tx.objectStore('pages').put(value, [id, page]);
      tx.objectStore('bounds').put({ page, start: value.start, end: value.end }, [id, page]);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('Could not store capture analysis. Free disk space and reopen the capture.'));
    });
  },
  async get(id, page) {
    const db = await openDatabase();
    return new Promise<SamplePage>((resolve, reject) => {
      const request = db.transaction('pages').objectStore('pages').get([id, page]);
      request.onsuccess = () => request.result ? resolve(request.result) : reject(new Error('The analysis cache is unavailable. Reopen this capture.'));
      request.onerror = () => reject(new Error('Could not read the analysis cache.'));
    });
  },
  async release(id) {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['pages', 'bounds'], 'readwrite');
      // Only temporary derived pages created by this analysis are released.
      tx.objectStore('pages').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
      tx.objectStore('bounds').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
  },
  async *matching(id, range, signal) {
    const db = await openDatabase();
    let nextPage = 0;
    while (true) {
      signal?.throwIfAborted();
      const bounds = await new Promise<Array<{ page: number; start: number; end: number }>>((resolve, reject) => {
        const request = db.transaction('bounds').objectStore('bounds').getAll(IDBKeyRange.bound([id, nextPage], [id, Number.MAX_SAFE_INTEGER]), 256);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      if (!bounds.length) break;
      nextPage = bounds[bounds.length - 1].page + 1;
      for (const bound of bounds) if (bound.end >= range.start && bound.start <= range.end) yield bound.page;
    }
  },
};

/** Complete on-disk sample history; only one page and a bounded chart overview are read into memory. */
export class CaptureAnalysisIndex {
  readonly id = crypto.randomUUID();
  private page = 0;
  private buffer: TelemetrySample[] = [];
  private pending: SamplePage[] = [];
  private bounds: CaptureRange = { start: Infinity, end: -Infinity };
  private count = 0;
  private released = false;
  metadata!: TelemetrySessionSnapshot;
  timingMode: 'recorded' | 'approximate' = 'approximate';

  constructor(private readonly pages: CapturePageStore = diskCapturePages) {}
  get range(): CaptureRange { return this.count ? this.bounds : { start: 0, end: 0 }; }
  get totalRecords() { return this.count; }

  append(sample: TelemetrySample) {
    this.buffer.push(sample); this.count += 1;
    const time = Date.parse(sample.timestamp);
    this.bounds.start = Math.min(this.bounds.start, time); this.bounds.end = Math.max(this.bounds.end, time);
    if (this.buffer.length >= 512) this.queuePage();
  }
  private queuePage() {
    if (!this.buffer.length) return;
    let start = Infinity; let end = -Infinity;
    for (const sample of this.buffer) { const time = Date.parse(sample.timestamp); start = Math.min(start, time); end = Math.max(end, time); }
    this.pending.push({ samples: this.buffer, start, end }); this.buffer = [];
  }
  async flush(final = false) {
    if (final) this.queuePage();
    for (const page of this.pending) await this.pages.put(this.id, this.page++, page);
    this.pending = [];
  }
  async *samples(range: CaptureRange = this.range, signal?: AbortSignal): AsyncGenerator<TelemetrySample> {
    if (this.released) throw new Error('Reopen the capture before using its analysis.');
    signal?.throwIfAborted();
    const pageCount = this.page;
    async function* allPages() { for (let page = 0; page < pageCount; page += 1) yield page; }
    for await (const page of this.pages.matching?.(this.id, range, signal) ?? allPages()) {
      signal?.throwIfAborted();
      const value = await this.pages.get(this.id, page);
      if (value.end < range.start || value.start > range.end) continue;
      for (const sample of value.samples) {
        signal?.throwIfAborted();
        const time = Date.parse(sample.timestamp);
        if (time >= range.start && time <= range.end) yield sample;
      }
    }
  }
  async query(range: CaptureRange = this.range, fieldKeys = this.metadata.fields.slice(0, 8).map((field) => field.key), signal?: AbortSignal) {
    const buckets = new Map<string, { sample: TelemetrySample; ordinal: number }>();
    let matched = 0;
    // Each bucket keeps its endpoints and the extrema of every selected signal.
    // Spikes remain visible even when millions of records share the overview.
    for await (const sample of this.samples(range, signal)) {
      matched += 1;
      const record = { sample, ordinal: matched };
      const bucket = Math.min(255, Math.floor(256 * (Date.parse(sample.timestamp) - range.start) / Math.max(1, range.end - range.start)));
      const prefix = `${bucket}:`;
      if (!buckets.has(`${prefix}first`)) buckets.set(`${prefix}first`, record);
      buckets.set(`${prefix}last`, record);
      for (const field of fieldKeys.slice(0, 8)) {
        const value = sample.values[field]?.value;
        if (value === undefined) continue;
        for (const extreme of ['min', 'max'] as const) {
          const key = `${prefix}${field}:${extreme}`;
          const previous = buckets.get(key)?.sample.values[field]?.value;
          if (previous === undefined || (extreme === 'min' ? value < previous : value > previous)) buckets.set(key, record);
        }
      }
    }
    // Several lines from one read share both timestamp and native sequence.
    // Bucket insertion order is unrelated to their order in the capture.
    const samples = [...new Map([...buckets.values()].map((record) => [record.sample.id, record])).values()]
      .sort((a, b) => Date.parse(a.sample.timestamp) - Date.parse(b.sample.timestamp) || a.ordinal - b.ordinal)
      .map((record) => record.sample);
    return { snapshot: { ...this.metadata, samples, acceptedSampleCount: matched }, matched };
  }
  async dispose() { if (!this.released) { this.released = true; await this.pages.release(this.id); } }
}

export async function analyzeNativeCapture(
  sourceId: string, log: SavedLog, options: { profile?: TelemetryDecoderProfile; signal?: AbortSignal; onProgress?: (fraction: number) => void; pages?: CapturePageStore } = {},
) {
  const handle = await openNativeCaptureAnalysis(log.path);
  const index = new CaptureAnalysisIndex(options.pages); index.timingMode = handle.timingMode;
  const store = new TelemetrySessionStore({ maxSamplesPerSession: 1, decoderProfile: options.profile });
  const unsubscribe = store.subscribeRecords(sourceId, (observation) => { if (observation.type === 'sample') index.append(observation.sample); });
  const start = Date.parse(log.startedAt ?? log.modifiedAt) || 0;
  const end = Date.parse(log.endedAt ?? '') || start + Math.max(1, handle.totalBytes) * 2;
  let sequence = 0; let lastByte = 10; let lastTime = start;
  try {
    let offset = 0;
    while (offset < handle.totalBytes) {
      options.signal?.throwIfAborted();
      const chunk = await readNativeCaptureAnalysisChunk(handle.id);
      if (chunk.offset !== offset || chunk.nextOffset <= offset || chunk.totalBytes !== handle.totalBytes) throw new Error('The capture changed while loading. Reopen it to try again.');
      const bytes = Uint8Array.from(atob(chunk.rawBase64), (character) => character.charCodeAt(0));
      if (bytes.length !== chunk.nextOffset - offset) throw new Error('The capture chunk was incomplete. Reopen it to try again.');
      let from = 0;
      const timing = chunk.timing ?? (() => {
        // Approximate each line by its byte position, rather than collapsing a
        // small legacy capture into one receive-time point per file read.
        const boundaries: number[] = [];
        bytes.forEach((byte, position) => { if (byte === 10 || byte === 13) boundaries.push(position + 1); });
        if (boundaries[boundaries.length - 1] !== bytes.length) boundaries.push(bytes.length);
        return boundaries.map((endOffset) => ({ endOffset, timestampMs: start + Math.max(0, end - start) * (chunk.offset + endOffset) / Math.max(1, handle.totalBytes) }));
      })();
      for (const record of timing) {
        lastTime = record.timestampMs;
        store.ingestOrderedSerialEvent(sourceId, { sessionId: log.sessionId ?? sourceId, port: 'saved-capture', sequence: ++sequence, timestamp: new Date(lastTime).toISOString(), text: '', bytes: [...bytes.subarray(from, record.endOffset)] });
        from = record.endOffset;
      }
      if (from !== bytes.length) throw new Error('Capture timing was incomplete. Reopen the capture.');
      lastByte = bytes[bytes.length - 1]; offset = chunk.nextOffset;
      await index.flush(); options.onProgress?.(offset / Math.max(1, handle.totalBytes));
    }
    if (handle.timingMode === 'approximate' && lastByte !== 10 && lastByte !== 13) {
      store.ingestOrderedSerialEvent(sourceId, { sessionId: log.sessionId ?? sourceId, port: 'saved-capture', sequence: ++sequence, timestamp: new Date(lastTime).toISOString(), text: '', bytes: [10] });
    }
    await index.flush(true); options.signal?.throwIfAborted();
    index.metadata = store.getSnapshot(sourceId);
    const preview = await index.query(index.range, undefined, options.signal);
    options.signal?.throwIfAborted();
    return { index, snapshot: preview.snapshot };
  } catch (error) { await index.dispose().catch(() => undefined); throw error; }
  finally { unsubscribe(); await closeNativeCaptureAnalysis(handle.id).catch(() => undefined); }
}
