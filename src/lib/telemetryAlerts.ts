import type { TelemetrySample } from './telemetry';

/** Conditions supported by the live telemetry watcher. */
export type TelemetryAlertCondition = 'above' | 'below' | 'outsideRange';

/**
 * A live-only alert rule. Above/below rules use `threshold`; range rules use
 * `min` and `max`. A range is inclusive, so its endpoints are safe and only
 * values below/above them are considered outside.
 */
export type TelemetryAlertRule = Readonly<{
  id: string;
  sessionKey: string;
  fieldKey: string;
  unit?: string;
  condition: TelemetryAlertCondition;
  threshold?: number;
  min?: number;
  max?: number;
  enabled: boolean;
}>;

/** State retained by a caller between batches, keyed by rule ID. */
export type TelemetryAlertState = ReadonlyMap<string, boolean>;

/** Emitted only when a rule transitions from normal to breaching. */
export type TelemetryAlertEvent = Readonly<{
  ruleId: string;
  sessionKey: string;
  fieldKey: string;
  sampleId: string;
  timestamp: string;
  value: number;
  unit?: string;
  condition: TelemetryAlertCondition;
  threshold?: number;
  min?: number;
  max?: number;
}>;

export type TelemetryAlertEvaluation = Readonly<{
  events: readonly TelemetryAlertEvent[];
  activeStates: ReadonlyMap<string, boolean>;
}>;

type WatchTarget =
  | Readonly<{ kind: 'threshold'; threshold: number }>
  | Readonly<{ kind: 'range'; min: number; max: number }>;

/** Some UI adapters attach the stable key while handing a batch to a rule. */
type SessionTaggedSample = TelemetrySample & { sessionKey?: unknown };

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizedUnit(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function setState(states: Map<string, boolean>, id: string, active: boolean) {
  states.set(id, active);
}

function wasActive(states: ReadonlyMap<string, boolean>, ruleId: string): boolean {
  return states.get(ruleId) === true;
}

function targetForRule(rule: TelemetryAlertRule): WatchTarget | null {
  if (
    typeof rule.id !== 'string'
    || !rule.id.trim()
    || typeof rule.sessionKey !== 'string'
    || !rule.sessionKey.trim()
    || typeof rule.fieldKey !== 'string'
    || !rule.fieldKey.trim()
    || typeof rule.enabled !== 'boolean'
    || !rule.enabled
    || (rule.unit !== undefined && typeof rule.unit !== 'string')
  ) return null;

  if (rule.condition === 'above' || rule.condition === 'below') {
    return finite(rule.threshold) ? { kind: 'threshold', threshold: rule.threshold } : null;
  }
  if (rule.condition !== 'outsideRange') return null;
  if (!finite(rule.min) || !finite(rule.max) || rule.min > rule.max) return null;
  return { kind: 'range', min: rule.min, max: rule.max };
}

function sampleBelongsToSession(sample: TelemetrySample, sessionKey: string): boolean {
  const taggedSessionKey = (sample as SessionTaggedSample).sessionKey;
  // The stable UI session is supplied separately by the caller. If an
  // adapter tagged an individual sample, honor that tag as an extra guard.
  return taggedSessionKey === undefined || taggedSessionKey === sessionKey;
}

function sampleFieldValue(
  rule: TelemetryAlertRule,
  sample: TelemetrySample,
): Readonly<{ value: number; unit?: string }> | null {
  const fieldValue = sample.values?.[rule.fieldKey];
  if (!fieldValue || !finite(fieldValue.value)) return null;

  const expectedUnit = normalizedUnit(rule.unit);
  const actualUnit = normalizedUnit(fieldValue.unit);
  if (expectedUnit !== undefined && actualUnit !== expectedUnit) return null;
  return { value: fieldValue.value, ...(actualUnit === undefined ? {} : { unit: actualUnit }) };
}

function isBreaching(
  condition: TelemetryAlertCondition,
  value: number,
  target: WatchTarget,
): boolean {
  if (target.kind === 'threshold') {
    if (condition === 'above') return value > target.threshold;
    if (condition === 'below') return value < target.threshold;
    return false;
  }
  return condition === 'outsideRange' && (value < target.min || value > target.max);
}

function createEvent(
  rule: TelemetryAlertRule,
  sample: TelemetrySample,
  fieldValue: Readonly<{ value: number; unit?: string }>,
  target: WatchTarget,
): TelemetryAlertEvent {
  const common = {
    ruleId: rule.id,
    sessionKey: rule.sessionKey,
    fieldKey: rule.fieldKey,
    sampleId: sample.id,
    timestamp: sample.timestamp,
    value: fieldValue.value,
    condition: rule.condition,
    ...(fieldValue.unit === undefined ? {} : { unit: fieldValue.unit }),
  };
  return target.kind === 'threshold'
    ? { ...common, threshold: target.threshold }
    : { ...common, min: target.min, max: target.max };
}

/**
 * Evaluate newly arrived live samples and return edge-triggered events.
 *
 * This function is pure: it does not mutate the rules, samples, or previous
 * state map. Samples are evaluated in the order supplied. A recovery updates
 * the returned active state without emitting an event; a later breach can
 * therefore trigger again. Mismatched sessions/fields/units, nonfinite
 * values, disabled rules, and malformed ranges are ignored.
 */
export function evaluateTelemetryAlerts(
  sessionKey: string,
  samples: readonly TelemetrySample[],
  rules: readonly TelemetryAlertRule[],
  previousActiveStates: ReadonlyMap<string, boolean> = new Map(),
): TelemetryAlertEvaluation {
  const activeStates = new Map(previousActiveStates);
  const targets = new Map<TelemetryAlertRule, WatchTarget | null>();

  for (const rule of rules) {
    const target = targetForRule(rule);
    targets.set(rule, target);
    if (target === null || rule.sessionKey !== sessionKey) {
      // A disabled/malformed rule is definitely inactive. A rule belonging to
      // another session is untouched because this batch has no evidence about
      // its current value.
      if (target === null) setState(activeStates, rule.id, false);
    } else if (!activeStates.has(rule.id)) {
      setState(activeStates, rule.id, false);
    }
  }

  const events: TelemetryAlertEvent[] = [];
  for (const sample of samples) {
    if (!sampleBelongsToSession(sample, sessionKey)) continue;
    for (const rule of rules) {
      const target = targets.get(rule) ?? null;
      if (target === null || rule.sessionKey !== sessionKey) continue;

      const fieldValue = sampleFieldValue(rule, sample);
      if (fieldValue === null) continue;

      const breaching = isBreaching(rule.condition, fieldValue.value, target);
      if (breaching && !wasActive(activeStates, rule.id)) {
        events.push(createEvent(rule, sample, fieldValue, target));
      }
      setState(activeStates, rule.id, breaching);
    }
  }

  return { events, activeStates };
}

