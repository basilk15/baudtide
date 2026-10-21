import { TelemetrySessionStore } from './telemetry';
import { TelemetryWatchEngine } from './telemetryWatchEngine';
import { watchOptionsError, type TelemetryAlertRule } from './telemetryAlerts';
import { normalizeTelemetryDecoderProfile, type TelemetryDecoderProfile } from './telemetryDecoders';
import { stableTerminalSessionIdentity } from '../workspaces/sessionWorkspaces';
import type { SerialDataEvent, SerialStatusEvent, StartedSerialSession } from '../serial/serial';
import type { WatchHistoryRow } from './watchHistory';
export { DesktopLogRuntime } from '../serial/logRules';

export type DesktopWatch = { rule: TelemetryAlertRule; decoder?: TelemetryDecoderProfile; sourceName: string };
export type DesktopWatchState = {
  rule: TelemetryAlertRule; sourceName: string; nativeSessionId?: string;
  decoder?: TelemetryDecoderProfile;
  lastReading?: number; breached: boolean; pending: boolean; occurrence: number;
};
export type DesktopWatchSnapshot = { watches: DesktopWatchState[]; interruption: string; historyError: string };
export type WatchFeedEvent = { info: StartedSerialSession; data: SerialDataEvent };

/** Validate persisted and renderer-supplied configuration before arming it. */
export function normalizeDesktopWatch(value: unknown): DesktopWatch {
  if (!value || typeof value !== 'object') throw new Error('Invalid watch configuration.');
  const input = value as DesktopWatch;
  const rule = input.rule;
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\u0000');
  if (!rule || !text(rule.id, 160) || !text(rule.sessionKey, 8192) || !rule.sessionKey.startsWith('serial:')
    || !text(rule.fieldKey, 256) || typeof rule.enabled !== 'boolean' || !text(input.sourceName, 200)
    || (rule.unit !== undefined && !text(rule.unit, 64)) || watchOptionsError(rule)
    || (rule.condition === 'outsideRange' ? !Number.isFinite(rule.min) || !Number.isFinite(rule.max) || rule.min! >= rule.max!
      : !['above', 'below'].includes(rule.condition) || !Number.isFinite(rule.threshold))) throw new Error('Invalid watch configuration.');
  const decoder = input.decoder === undefined ? undefined : normalizeTelemetryDecoderProfile(input.decoder);
  if (input.decoder !== undefined && !decoder) throw new Error('Invalid watch decoder.');
  // Copy only known properties; a saved rule is data, never a desktop command.
  return { sourceName: input.sourceName, ...(decoder ? { decoder } : {}), rule: {
    id: rule.id, sessionKey: rule.sessionKey, fieldKey: rule.fieldKey, enabled: rule.enabled, condition: rule.condition,
    ...(rule.unit === undefined ? {} : { unit: rule.unit }),
    ...(rule.condition === 'outsideRange' ? { min: rule.min, max: rule.max } : { threshold: rule.threshold }),
    sustainMs: rule.sustainMs ?? 0, hysteresis: rule.hysteresis ?? 0, staleAfterMs: rule.staleAfterMs ?? 10_000,
  } };
}

/** Independent of React, chart visibility, and the renderer's replay buffer. */
export class DesktopWatchRuntime {
  private readonly store = new TelemetrySessionStore({ maxSamplesPerSession: 2, maxSessions: 96 });
  private readonly engine: TelemetryWatchEngine;
  private watches: DesktopWatch[];
  private readonly sessions = new Map<string, StartedSerialSession>();
  private readonly sequences = new Map<string, number>();
  private readonly occurrences = new Map<string, number>();
  private interruption = '';
  private historyError = '';

  constructor(watches: unknown[], private readonly persist: (watches: DesktopWatch[]) => void,
    private readonly record: (event: WatchHistoryRow) => number, private readonly notify: (event: WatchHistoryRow) => void,
    private readonly now: () => number = Date.now) {
    if (watches.length > 48) throw new Error('Saved watch configuration exceeds the watch limit.');
    this.watches = watches.map(normalizeDesktopWatch);
    if (new Set(this.watches.map((watch) => watch.rule.id)).size !== this.watches.length) throw new Error('Saved watch IDs are not unique.');
    this.engine = new TelemetryWatchEngine(this.store, (event) => {
      const session = this.uniqueSession(event.sessionKey);
      const watch = this.watches.find((entry) => entry.rule.id === event.ruleId);
      if (!session || !watch) return;
      const row: WatchHistoryRow = { ...event, id: globalThis.crypto.randomUUID(), sourceName: watch.sourceName,
        sourceIdentity: event.sessionKey, capturePath: session.logPath, occurrence: (this.occurrences.get(event.ruleId) ?? 0) + 1 };
      try { row.occurrence = this.record(row); this.historyError = ''; }
      catch { this.historyError = 'Breach history was not saved. Check available disk space; watches are still running.'; }
      this.occurrences.set(event.ruleId, row.occurrence);
      this.notify(row);
    }, now);
    this.engine.setRules(this.watches.map((watch) => watch.rule));
  }

  private uniqueSession(identity: string) {
    const matching = [...this.sessions.values()].filter((session) => stableTerminalSessionIdentity(session) === identity);
    return matching.length === 1 ? matching[0] : undefined;
  }

  put(value: unknown) {
    const watch = normalizeDesktopWatch(value);
    const existing = this.watches.find((entry) => entry.rule.sessionKey === watch.rule.sessionKey && entry.rule.fieldKey === watch.rule.fieldKey);
    // Reattaching a saved analysis must not re-arm a latched watch or duplicate it.
    if (existing) return existing.rule.id;
    if (this.watches.some((entry) => entry.rule.id === watch.rule.id)) throw new Error('This watch ID is already in use.');
    if (this.watches.length >= 48) throw new Error('Up to 48 signal watches can be armed.');
    // All signals from one device use one parser. A saved analysis adding a
    // signal must not replace the decoder of watches that are already armed.
    const sibling = this.watches.find((entry) => entry.rule.sessionKey === watch.rule.sessionKey);
    if (sibling) watch.decoder = sibling.decoder;
    const next = [...this.watches, watch];
    this.persist(next); this.watches = next;
    const currentDecoder = this.store.getSnapshot(watch.rule.sessionKey).decoderProfile;
    if (JSON.stringify(currentDecoder ?? null) !== JSON.stringify(watch.decoder ?? null)) this.store.setDecoderProfile(watch.rule.sessionKey, watch.decoder);
    this.engine.setRules(next.map((entry) => entry.rule));
    return watch.rule.id;
  }

  remove(ids: string[]) {
    if (!Array.isArray(ids) || ids.length > 48 || ids.some((id) => typeof id !== 'string')) throw new Error('Invalid watch selection.');
    const next = this.watches.filter((watch) => !ids.includes(watch.rule.id));
    this.persist(next); this.watches = next;
    this.engine.setRules(next.map((watch) => watch.rule));
  }

  decoder(identity: string, value?: TelemetryDecoderProfile) {
    if (typeof identity !== 'string' || !identity.startsWith('serial:') || identity.length > 8192) throw new Error('Invalid watch device identity.');
    const decoder = value === undefined ? undefined : normalizeTelemetryDecoderProfile(value);
    if (value !== undefined && !decoder) throw new Error('Invalid watch decoder.');
    const matching = this.watches.filter((watch) => watch.rule.sessionKey === identity);
    if (!matching.length) return;
    const encoded = JSON.stringify(decoder ?? null);
    if (matching.every((watch) => JSON.stringify(watch.decoder ?? null) === encoded)
      && JSON.stringify(this.store.getSnapshot(identity).decoderProfile ?? null) === encoded) return;
    const next = this.watches.map((watch) => watch.rule.sessionKey === identity ? { ...watch, decoder: decoder ?? undefined } : watch);
    this.persist(next); this.watches = next;
    this.store.setDecoderProfile(identity, decoder ?? undefined);
  }

  feed({ info, data }: WatchFeedEvent) {
    const previousSequence = this.sequences.get(info.id);
    if (previousSequence !== undefined && data.sequence <= previousSequence) return;
    const identity = stableTerminalSessionIdentity(info);
    if (previousSequence !== undefined && data.sequence !== previousSequence + 1) this.gap(identity);
    const isNew = !this.sessions.has(info.id);
    this.sessions.set(info.id, info); this.sequences.set(info.id, data.sequence);
    if (!this.uniqueSession(identity)) { this.gap(identity, 'Watches paused: more than one active terminal has the same device identity.'); return; }
    if (isNew) {
      const decoder = this.watches.find((watch) => watch.rule.sessionKey === identity)?.decoder;
      this.store.setDecoderProfile(identity, decoder);
    }
    this.store.ingestOrderedSerialEvent(identity, data);
  }

  status(event: SerialStatusEvent) {
    if (event.status === 'connected') return;
    const session = this.sessions.get(event.sessionId);
    if (session) {
      this.sessions.delete(session.id); this.sequences.delete(session.id);
      const identity = stableTerminalSessionIdentity(session);
      this.store.removeSession(identity);
      this.store.setDecoderProfile(identity, this.watches.find((watch) => watch.rule.sessionKey === identity)?.decoder);
    }
  }

  gap(identity?: string, reason = 'Watch monitoring missed some readings. Raw capture continues; sustained conditions restart with fresh evidence.') {
    this.interruption = reason;
    for (const key of new Set(this.watches.map((watch) => watch.rule.sessionKey))) if (!identity || identity === key) {
      this.store.removeSession(key);
      this.store.setDecoderProfile(key, this.watches.find((watch) => watch.rule.sessionKey === key)?.decoder);
    }
  }

  snapshot(): DesktopWatchSnapshot {
    return { interruption: this.interruption, historyError: this.historyError, watches: this.watches.map(({ rule, sourceName, decoder }) => ({
      rule, sourceName, decoder, nativeSessionId: this.uniqueSession(rule.sessionKey)?.id,
      lastReading: this.engine.lastReadings.get(rule.id), breached: this.engine.isBreached(rule.id),
      pending: this.engine.isPending(rule.id), occurrence: this.occurrences.get(rule.id) ?? 0,
    })) };
  }

  dispose() { this.engine.dispose(); }
}
