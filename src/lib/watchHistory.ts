import type { TelemetryAlertEvent } from './telemetryAlerts';

export type WatchHistoryRow = TelemetryAlertEvent & {
  id: string; sourceName: string; occurrence: number; sourceIdentity?: string; capturePath?: string;
};
export type StoredWatchEvent = { sequence: number; event: WatchHistoryRow };
export type WatchHistorySummary = { count: number; through: number };
export interface WatchHistoryStorage {
  append(event: WatchHistoryRow): Promise<void>;
  summary(): Promise<WatchHistorySummary>;
  latest(limit: number): Promise<StoredWatchEvent[]>;
  page(after: number, through: number, limit: number): Promise<StoredWatchEvent[]>;
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('baudtide-watch-history', 1);
    let failed = false;
    const fail = () => { failed = true; database = undefined; reject(new Error('Breach history could not be saved or opened. Check disk space and close other BaudTide windows, then retry.')); };
    request.onupgradeneeded = () => request.result.createObjectStore('events', { autoIncrement: true });
    request.onerror = request.onblocked = fail;
    request.onsuccess = () => {
      const db = request.result;
      if (failed) { db.close(); return; }
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  }).catch((error: unknown) => { database = undefined; throw error; });
  return database;
}

async function records(range: IDBKeyRange | undefined, direction: IDBCursorDirection, limit: number) {
  const db = await openDatabase();
  return new Promise<StoredWatchEvent[]>((resolve, reject) => {
    const tx = db.transaction('events');
    const result: StoredWatchEvent[] = [];
    const request = tx.objectStore('events').openCursor(range, direction);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || result.length >= limit) return;
      result.push({ sequence: Number(cursor.key), event: cursor.value as WatchHistoryRow }); cursor.continue();
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(new Error('Could not read breach history. Retry after checking available disk space.'));
  });
}

export const diskWatchHistory: WatchHistoryStorage = {
  async append(event) {
    const db = await openDatabase();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('events', 'readwrite');
      tx.objectStore('events').add(event);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error('Breach history was not saved. Check available disk space; live watches are still running.'));
    });
  },
  async summary() {
    const db = await openDatabase();
    return new Promise<WatchHistorySummary>((resolve, reject) => {
      const tx = db.transaction('events'); const store = tx.objectStore('events');
      const count = store.count(); const last = store.openKeyCursor(undefined, 'prev');
      tx.oncomplete = () => resolve({ count: count.result, through: Number(last.result?.key ?? 0) });
      tx.onerror = tx.onabort = () => reject(new Error('Could not count saved breaches. Retry opening the history.'));
    });
  },
  latest: (limit) => records(undefined, 'prev', limit),
  page: (after, through, limit) => after >= through ? Promise.resolve([]) : records(IDBKeyRange.bound(after, through, true, false), 'next', limit),
};

/** Serialize appends and export a fixed saved snapshot while live watches continue. */
export class WatchHistoryJournal {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(private readonly storage: WatchHistoryStorage = diskWatchHistory) {}
  append(event: WatchHistoryRow) {
    if (this.pending >= 2048) return Promise.reject(new Error('Breach history cannot keep up. Some events were not saved; add a recovery margin or sustained duration.'));
    this.pending += 1;
    const write = this.tail.then(() => this.storage.append(event)).finally(() => { this.pending -= 1; });
    this.tail = write.catch(() => undefined);
    return write;
  }
  async summary() { await this.tail; return this.storage.summary(); }
  async latest(limit = 100) { await this.tail; return this.storage.latest(limit); }
  async *events(signal?: AbortSignal) {
    await this.tail;
    signal?.throwIfAborted();
    const { through } = await this.storage.summary();
    let after = 0;
    while (after < through) {
      signal?.throwIfAborted();
      const page = await this.storage.page(after, through, 256);
      if (!page.length) break;
      for (const record of page) { signal?.throwIfAborted(); after = record.sequence; yield record.event; }
    }
  }
}

export async function* watchHistoryExportChunks(events: AsyncIterable<WatchHistoryRow>, format: 'csv' | 'json') {
  let chunk = format === 'csv' ? 'id,source,device_identity,capture_path,timestamp,signal,value,unit,condition,threshold,min,max,sustain_ms,hysteresis,stale_after_ms,occurrence\n' : '{"version":1,"events":[';
  let first = true;
  function csv(value: unknown) { const text = String(value ?? ''); return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text; }
  for await (const event of events) {
    chunk += format === 'json' ? `${first ? '' : ','}${JSON.stringify(event)}` : [event.id, event.sourceName, event.sourceIdentity, event.capturePath, event.timestamp, event.fieldKey, event.value, event.unit,
      event.condition, event.threshold, event.min, event.max, event.sustainMs ?? 0, event.hysteresis ?? 0, event.staleAfterMs ?? 10_000, event.occurrence].map(csv).join(',') + '\n';
    first = false;
    if (chunk.length >= 32 * 1024) { yield chunk; chunk = ''; }
  }
  if (format === 'json') chunk += ']}';
  if (chunk) yield chunk;
}
