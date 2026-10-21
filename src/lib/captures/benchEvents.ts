import { invokeDesktop } from '../desktop';
import type { CaptureEvent } from './captureEvents';
import type { LogRule, LogRuleSnapshot } from '../serial/logRules';

export const logRuleSnapshot = () => invokeDesktop<LogRuleSnapshot>('log_rules_snapshot');
export const putLogRule = (rule: LogRule) => invokeDesktop<string>('log_rule_put', { rule });
export type BenchEventPage = { events: CaptureEvent[]; nextBefore: number | null };
export const listBenchEvents = (capturePath: string, before?: number) => invokeDesktop<BenchEventPage>('bench_events_list', { capturePath, before, limit: 100 });
export const recordCommandEvent = (event: CaptureEvent) => invokeDesktop<CaptureEvent>('bench_event_append', { event });
