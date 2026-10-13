import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

function historyRow(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id || value.id.length > 200
    || typeof value.ruleId !== 'string' || typeof value.sessionKey !== 'string' || typeof value.sourceName !== 'string'
    || typeof value.fieldKey !== 'string' || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))
    || !Number.isFinite(value.value) || !Number.isSafeInteger(value.occurrence) || value.occurrence < 1
    || JSON.stringify(value).length > 16384) throw new Error('Invalid saved breach event.');
  return value;
}

/** A single worker owns this journal. No renderer owns a database handle. */
export class WatchJournal {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'watches.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS configuration (id INTEGER PRIMARY KEY CHECK(id=1), contents TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        rule_id TEXT NOT NULL, timestamp TEXT NOT NULL, occurrence INTEGER NOT NULL, contents TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_rule ON events(rule_id, occurrence);
      CREATE INDEX IF NOT EXISTS events_time ON events(timestamp DESC, sequence DESC);`);
  }
  rules() {
    const row = this.db.prepare('SELECT contents FROM configuration WHERE id=1').get();
    const result = row ? JSON.parse(row.contents) : [];
    if (!Array.isArray(result) || result.length > 48) throw new Error('Saved watch configuration is invalid. Existing data has been preserved.');
    return result;
  }
  saveRules(watches) {
    this.db.prepare('INSERT INTO configuration VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET contents=excluded.contents').run(JSON.stringify(watches));
  }
  append(value) {
    const row = historyRow(value);
    const occurrence = Number(this.db.prepare('SELECT COALESCE(MAX(occurrence), 0) AS n FROM events WHERE rule_id=?').get(row.ruleId).n) + 1;
    this.insert({ ...row, occurrence });
    return occurrence;
  }
  insert(row) {
    this.db.prepare('INSERT OR IGNORE INTO events (id, rule_id, timestamp, occurrence, contents) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.ruleId, row.timestamp, row.occurrence, JSON.stringify(row));
  }
  import(rows) {
    if (!Array.isArray(rows) || rows.length > 256) throw new Error('Import up to 256 saved breaches at a time.');
    rows.forEach(historyRow);
    this.db.exec('BEGIN IMMEDIATE');
    try { rows.forEach((row) => this.insert(row)); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  summary() { return this.db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(sequence), 0) AS through FROM events').get(); }
  latest(limit) {
    return this.db.prepare('SELECT sequence, contents FROM events ORDER BY timestamp DESC, sequence DESC LIMIT ?').all(this.limit(limit))
      .map((row) => ({ sequence: row.sequence, event: JSON.parse(row.contents) }));
  }
  page(after, through, limit) {
    if (![after, through].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid breach history cursor.');
    return this.db.prepare('SELECT sequence, contents FROM events WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?')
      .all(after, through, this.limit(limit)).map((row) => ({ sequence: row.sequence, event: JSON.parse(row.contents) }));
  }
  limit(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 256) throw new Error('Invalid breach history page size.');
    return value;
  }
  close() { this.db.close(); }
}
