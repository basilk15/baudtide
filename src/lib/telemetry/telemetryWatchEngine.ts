import { evaluateTelemetryAlerts, watchOptionsError, type TelemetryAlertEvent, type TelemetryAlertRule } from './telemetryAlerts';
import type { TelemetrySessionStore } from './telemetry';

/** Watches observe accepted records before bounded chart history can overwrite them. */
export class TelemetryWatchEngine {
  private rules: readonly TelemetryAlertRule[] = [];
  private active = new Map<string, boolean>();
  private readonly pending = new Map<string, { since: number; last: number }>();
  private readonly subscriptions = new Map<string, () => void>();
  readonly lastReadings = new Map<string, number>();

  constructor(private readonly store: TelemetrySessionStore, private readonly onEvent: (event: TelemetryAlertEvent) => void,
    private readonly now: () => number = Date.now) {}

  private reset(id: string) { this.active.delete(id); this.pending.delete(id); this.lastReadings.delete(id); }

  setRules(rules: readonly TelemetryAlertRule[]) {
    const previous = new Map(this.rules.map((rule) => [rule.id, rule]));
    const next = new Map(rules.map((rule) => [rule.id, rule]));
    for (const id of previous.keys()) if (!next.has(id) || JSON.stringify(previous.get(id)) !== JSON.stringify(next.get(id))) this.reset(id);
    this.rules = rules;
    const keys = new Set(rules.filter((rule) => rule.enabled && !watchOptionsError(rule)).map((rule) => rule.sessionKey));
    for (const [key, unsubscribe] of this.subscriptions) if (!keys.has(key)) { unsubscribe(); this.subscriptions.delete(key); }
    for (const key of keys) {
      if (this.subscriptions.has(key)) continue;
      this.subscriptions.set(key, this.store.subscribeRecords(key, (observation) => {
        const matching = this.rules.filter((rule) => rule.sessionKey === key && rule.enabled && !watchOptionsError(rule));
        if (observation.type === 'boundary') { matching.forEach((rule) => this.reset(rule.id)); return; }
        for (const rule of matching) {
          const value = observation.sample.values[rule.fieldKey];
          if (!value || !Number.isFinite(value.value) || (rule.unit !== undefined && rule.unit.trim() !== (value.unit ?? '').trim())) continue;
          const arrival = this.now();
          const previousReading = this.lastReadings.get(rule.id);
          if (previousReading !== undefined && (arrival < previousReading || arrival - previousReading > (rule.staleAfterMs ?? 10_000))) this.reset(rule.id);
          this.lastReadings.set(rule.id, arrival);
          const evaluated = evaluateTelemetryAlerts(key, [observation.sample], [rule], this.active);
          const wasActive = this.active.get(rule.id) === true;
          if (wasActive || !evaluated.events.length) {
            this.active.set(rule.id, evaluated.activeStates.get(rule.id) === true);
            this.pending.delete(rule.id);
            continue;
          }
          const sampleTime = Date.parse(observation.sample.timestamp);
          const sustain = rule.sustainMs ?? 0;
          if (sustain > 0) {
            if (!Number.isFinite(sampleTime)) { this.pending.delete(rule.id); continue; }
            let candidate = this.pending.get(rule.id);
            if (!candidate || sampleTime < candidate.last || sampleTime - candidate.last > (rule.staleAfterMs ?? 10_000)) {
              candidate = { since: sampleTime, last: sampleTime }; this.pending.set(rule.id, candidate);
            }
            candidate.last = sampleTime;
            if (sampleTime - candidate.since < sustain) continue;
          }
          this.active.set(rule.id, true); this.pending.delete(rule.id);
          // A failing notification/persistence consumer must not interrupt other watches.
          try { this.onEvent(evaluated.events[0]); } catch { /* The caller owns reporting of observer failures. */ }
        }
      }));
    }
  }

  isBreached(id: string) { return this.active.get(id) === true; }
  isPending(id: string) { return this.pending.has(id); }
  dispose() {
    this.subscriptions.forEach((unsubscribe) => unsubscribe()); this.subscriptions.clear();
    this.active.clear(); this.pending.clear(); this.lastReadings.clear();
  }
}
