import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export function validateBenchEvent(event) {
  const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
  if (!event || !['log', 'command'].includes(event.kind) || !text(event.id, 160) || !text(event.capturePath, 8192)
    || !text(event.sourceName, 200) || !text(event.label, 120) || typeof event.note !== 'string' || event.note.length > 2000
    || typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))) throw new Error('Invalid capture event.');
  return { id: event.id, kind: event.kind, capturePath: event.capturePath, sourceName: event.sourceName,
    label: event.label, note: event.note, timestamp: event.timestamp };
}

/** Kept separate from the existing signal-watch journal and raw capture files. */
export class BenchJournal {
  constructor(directory) {
    this.db = new DatabaseSync(path.join(directory, 'bench-events.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS log_rules (id INTEGER PRIMARY KEY CHECK(id=1), contents TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capture_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE, capture_path TEXT NOT NULL, contents TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS capture_events_path ON capture_events(capture_path, sequence);`);
  }
  rules() { const row = this.db.prepare('SELECT contents FROM log_rules WHERE id=1').get(); return row ? JSON.parse(row.contents) : []; }
  saveRules(rules) {
    this.db.prepare('INSERT INTO log_rules VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET contents=excluded.contents').run(JSON.stringify(rules));
  }
  append(value) {
    const event = validateBenchEvent(value);
    this.db.prepare('INSERT OR IGNORE INTO capture_events(id, capture_path, contents) VALUES (?, ?, ?)')
      .run(event.id, event.capturePath, JSON.stringify(event));
    return event;
  }
  list({ capturePath, before = Number.MAX_SAFE_INTEGER, limit = 100 }) {
    if (typeof capturePath !== 'string' || !capturePath || capturePath.length > 8192 || !Number.isSafeInteger(before) || before < 1
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('Invalid capture event page.');
    const rows = this.db.prepare('SELECT sequence, contents FROM capture_events WHERE capture_path=? AND sequence<? ORDER BY sequence DESC LIMIT ?')
      .all(capturePath, before, limit + 1);
    return { events: rows.slice(0, limit).map((row) => JSON.parse(row.contents)),
      nextBefore: rows.length > limit ? rows[limit - 1].sequence : null };
  }
  close() { this.db.close(); }
}
