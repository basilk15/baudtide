import { Utf8LineAssembler } from '../telemetry/telemetry';
import { stableTerminalSessionIdentity } from '../workspaces/sessionWorkspaces';
import type { WatchFeedEvent } from '../telemetry/desktopWatchRuntime';
import type { SerialStatusEvent } from './serial';
import type { CaptureEvent } from '../captures/captureEvents';

export type LogRule = {
  id: string; identity: string; sourceName: string; name: string; pattern: string;
  caseSensitive: boolean; cooldownMs: number; enabled: boolean; desktopAlert: boolean;
};
export type LogMatchEvent = CaptureEvent & { kind: 'log'; ruleId: string; desktopAlert: boolean };
export type LogRuleSnapshot = { rules: LogRule[]; error: string; interruption: string };

export function normalizeLogRule(value: unknown): LogRule {
  const rule = value as LogRule | null;
  const text = (v: unknown, max: number) => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\r\n\0]/u.test(v);
  if (!rule || !text(rule.id, 160) || !text(rule.identity, 8192) || !rule.identity.startsWith('serial:')
    || !text(rule.sourceName, 200) || !text(rule.name, 80) || !text(rule.pattern, 256)
    || !Number.isSafeInteger(rule.cooldownMs) || rule.cooldownMs < 1000 || rule.cooldownMs > 86_400_000
    || [rule.caseSensitive, rule.enabled, rule.desktopAlert].some((v) => typeof v !== 'boolean')) {
    throw new Error('Use a title, matching text, and a cooldown between 1 and 86,400 seconds.');
  }
  return { id: rule.id, identity: rule.identity, sourceName: rule.sourceName, name: rule.name.trim(), pattern: rule.pattern,
    caseSensitive: rule.caseSensitive, cooldownMs: rule.cooldownMs, enabled: rule.enabled, desktopAlert: rule.desktopAlert };
}

/** Consumes the native feed, never terminal replay or filtered display lines. */
export class DesktopLogRuntime {
  private rules: LogRule[];
  private streams = new Map<string, { identity: string; sequence: number; parser: Utf8LineAssembler }>();
  private lastMatch = new Map<string, number>();
  private error = '';
  private interruption = '';
  constructor(rules: unknown[], private persist: (rules: LogRule[]) => void,
    private record: (event: LogMatchEvent) => void, private notify: (event: LogMatchEvent) => void,
    private now = Date.now) {
    if (!Array.isArray(rules) || rules.length > 48) throw new Error('Saved log rules are invalid. Existing data is preserved.');
    this.rules = rules.map(normalizeLogRule);
    if (new Set(this.rules.map((rule) => rule.id)).size !== this.rules.length) throw new Error('Saved log rule IDs are not unique.');
  }
  snapshot(): LogRuleSnapshot { return { rules: this.rules, error: this.error, interruption: this.interruption }; }
  put(value: unknown) {
    const rule = normalizeLogRule(value);
    if (!this.rules.some((r) => r.id === rule.id) && this.rules.length >= 48) throw new Error('Up to 48 log rules can be saved.');
    const next = [...this.rules.filter((r) => r.id !== rule.id), rule];
    this.persist(next); this.rules = next;
    // Editing a rule must not match text received before it was armed.
    for (const stream of this.streams.values()) if (stream.identity === rule.identity) stream.parser.reset();
    this.lastMatch.delete(rule.id);
    return rule.id;
  }
  feed({ info, data }: WatchFeedEvent) {
    let stream = this.streams.get(info.id);
    if (stream && data.sequence <= stream.sequence) return;
    const identity = stableTerminalSessionIdentity(info);
    if (!stream) {
      if (this.streams.size >= 96) { this.gap(); this.streams.clear(); }
      stream = { identity, sequence: data.sequence - 1, parser: new Utf8LineAssembler() };
      this.streams.set(info.id, stream);
    }
    if (data.sequence !== stream.sequence + 1) {
      stream.parser.reset(); this.interruption = 'Log monitoring missed serial data. Incomplete lines were discarded; raw capture continues.';
    }
    stream.sequence = data.sequence;
    if ([...this.streams.values()].filter((s) => s.identity === identity).length !== 1) {
      for (const s of this.streams.values()) if (s.identity === identity) s.parser.reset();
      this.interruption = 'Log rules paused for an ambiguous device identity. Keep one terminal per device identity.'; return;
    }
    const rules = this.rules.filter((r) => r.enabled && r.identity === identity);
    if (!rules.length) { stream.parser.reset(); return; }
    for (const line of stream.parser.push(data.bytes)) {
      for (const rule of rules) {
        const now = this.now();
        if (now - (this.lastMatch.get(rule.id) ?? -Infinity) < rule.cooldownMs) continue;
        if (!(rule.caseSensitive ? line.includes(rule.pattern) : line.toLowerCase().includes(rule.pattern.toLowerCase()))) continue;
        this.lastMatch.set(rule.id, now);
        const event: LogMatchEvent = { id: crypto.randomUUID(), kind: 'log', ruleId: rule.id, desktopAlert: rule.desktopAlert,
          capturePath: info.logPath, timestamp: data.timestamp, sourceName: info.sessionName, label: rule.name, note: line.slice(0, 2000) };
        try { this.record(event); this.error = ''; }
        catch { this.error = 'A log event could not be saved. Check disk space; monitoring continues.'; }
        try { this.notify(event); } catch { /* Notification failure must not stop serial processing. */ }
      }
    }
    if (stream.parser.takeDroppedLineCount()) this.interruption = 'Log rules skipped a line longer than 16 KiB. Raw capture contains the original output.';
  }
  status(event: SerialStatusEvent) { if (event.status !== 'connected') this.streams.delete(event.sessionId); }
  gap() {
    this.interruption = 'Log monitoring missed serial data. Incomplete lines were discarded; raw capture continues.';
    for (const stream of this.streams.values()) stream.parser.reset();
  }
}
