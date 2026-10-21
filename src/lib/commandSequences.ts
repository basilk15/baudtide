import { commandBytes, type SerialCommand } from './serialCommands';
import type { SerialDataEvent } from './serial';
import type { CaptureEvent } from './captureEvents';

export type CommandStep = { id: string; name: string; command: Pick<SerialCommand, 'payload' | 'mode' | 'lineEnding'>; expect: string; timeoutMs: number; delayMs: number };
export type CommandSequence = { id: string; name: string; steps: CommandStep[] };
export type StepResult = { stepId: string; name: string; state: 'pending' | 'sending' | 'waiting' | 'delay' | 'passed' | 'failed' | 'stopped'; detail: string; timestamp?: string };
export type SequenceRunState = { running: boolean; name: string; status: string; steps: StepResult[] };
export const MAX_SEQUENCE_STEPS = 16;
export const MAX_COMMAND_SEQUENCES = 24;

export function normalizeCommandSequences(value: unknown): CommandSequence[] | null {
  if (!Array.isArray(value) || value.length > MAX_COMMAND_SEQUENCES) return null;
  const result: CommandSequence[] = [];
  const text = (v: unknown, max: number) => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\r\n\0]/u.test(v);
  for (const seq of value as CommandSequence[]) {
    if (!seq || !text(seq.id, 160) || !text(seq.name, 80) || result.some((s) => s.id === seq.id)
      || !Array.isArray(seq.steps) || !seq.steps.length || seq.steps.length > MAX_SEQUENCE_STEPS) return null;
    const steps: CommandStep[] = [];
    for (const step of seq.steps) {
      if (!step || !text(step.id, 160) || !text(step.name, 80) || steps.some((s) => s.id === step.id)
        || !step.command || !['text', 'hex'].includes(step.command.mode) || !['none', 'lf', 'cr', 'crlf'].includes(step.command.lineEnding)
        || typeof step.command.payload !== 'string' || !step.command.payload.trim() || step.command.payload.length > 65536
        || typeof step.expect !== 'string' || step.expect.length > 256 || /[\r\n\0]/u.test(step.expect)
        || !Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > 3_600_000
        || !Number.isSafeInteger(step.delayMs) || step.delayMs < 0 || step.delayMs > 3_600_000) return null;
      try { commandBytes(step.command); } catch { return null; }
      steps.push({ id: step.id, name: step.name.trim(), command: { payload: step.command.payload, mode: step.command.mode, lineEnding: step.command.lineEnding },
        expect: step.expect, timeoutMs: step.timeoutMs, delayMs: step.delayMs });
    }
    result.push({ id: seq.id, name: seq.name.trim(), steps });
  }
  return result;
}
const key = (identity: string) => `baudtide.command-sequences.v1.${identity}`;
export function loadCommandSequences(identity: string): CommandSequence[] {
  const raw = localStorage.getItem(key(identity));
  if (raw === null) return [];
  try {
    const result = normalizeCommandSequences(JSON.parse(raw));
    if (!result) throw new Error();
    return result;
  } catch { throw new Error('Saved command sequences could not be read. Existing sequences are preserved.'); }
}
export function saveCommandSequences(identity: string, sequences: CommandSequence[]) {
  const result = normalizeCommandSequences(sequences);
  if (!result) throw new Error('Use named steps, valid commands, and delays and timeouts up to one hour.');
  const contents = JSON.stringify(result);
  if (contents.length > 512 * 1024) throw new Error('The sequence library is too large. Shorten commands before saving.');
  localStorage.setItem(key(identity), contents);
  window.dispatchEvent(new CustomEvent('baudtide:command-sequences', { detail: identity }));
}

class SequenceStopped extends Error {}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stopped = () => reject(signal.reason ?? new SequenceStopped('Sequence stopped.'));
    if (signal.aborted) { stopped(); return; }
    signal.addEventListener('abort', stopped, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stopped));
  });
}
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const stopped = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stopped); resolve(); }, ms);
    signal.addEventListener('abort', stopped, { once: true });
  });
}

/** One explicitly started run owns writes. Response checks see the ordered native stream. */
export class CommandSequenceRunner {
  private controller: AbortController | null = null;
  private waiter: { sessionId: string; accept: (event: SerialDataEvent) => void; fail: (error: Error) => void } | null = null;
  private latest = { sessionId: '', sequence: 0 };
  private state: SequenceRunState = { running: false, name: '', status: '', steps: [] };
  constructor(private changed: (state: SequenceRunState) => void) {}
  get running() { return this.controller !== null; }
  private publish() { this.changed({ ...this.state, steps: this.state.steps.map((step) => ({ ...step })) }); }
  observe(event: SerialDataEvent) {
    if (this.latest.sessionId === event.sessionId && event.sequence <= this.latest.sequence) return;
    const gap = this.latest.sessionId === event.sessionId && event.sequence !== this.latest.sequence + 1;
    this.latest = { sessionId: event.sessionId, sequence: event.sequence };
    if (!this.waiter || this.waiter.sessionId !== event.sessionId) return;
    if (gap) { this.waiter.fail(new Error('Serial data was missed while checking the response. Run stopped.')); return; }
    this.waiter.accept(event);
  }
  stop(reason = 'Stopped by you. An in-flight write may still complete.') { this.controller?.abort(new SequenceStopped(reason)); }
  private response(step: CommandStep, sessionId: string, signal: AbortSignal) {
    const decoder = new TextDecoder(); let tail = '';
    let cleanup = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      const stop = () => reject(signal.reason);
      const timer = setTimeout(() => reject(new Error(`No response containing “${step.expect}” within ${step.timeoutMs / 1000}s.`)), step.timeoutMs);
      cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); if (this.waiter === waiter) this.waiter = null; };
      signal.addEventListener('abort', stop, { once: true });
      const waiter = { sessionId, fail: reject, accept: (event: SerialDataEvent) => {
        const text = tail + decoder.decode(Uint8Array.from(event.bytes), { stream: true });
        if (text.includes(step.expect)) resolve();
        else tail = step.expect.length > 1 ? text.slice(-(step.expect.length - 1)) : '';
      } };
      this.waiter = waiter;
    });
    // Observe early timeouts while writes are pending and always release the matcher.
    void promise.then(cleanup, cleanup);
    return promise;
  }
  async run(sequence: CommandSequence, context: { sessionId: string; capturePath: string; sourceName: string },
    send: (command: CommandStep['command']) => Promise<void>, record: (event: CaptureEvent) => Promise<unknown>) {
    if (this.controller) throw new Error('A command sequence is already running.');
    const normalized = normalizeCommandSequences([sequence])?.[0];
    if (!normalized || !context.sessionId || !context.capturePath) throw new Error('Choose a valid sequence and connect a recording terminal.');
    const controller = new AbortController(); const signal = controller.signal; this.controller = controller;
    this.state = { running: true, name: normalized.name, status: 'Starting…', steps: normalized.steps.map((step) => ({ stepId: step.id, name: step.name, state: 'pending', detail: '' })) };
    this.publish();
    let current = -1;
    const event = (label: string, note: string): CaptureEvent => ({ id: crypto.randomUUID(), kind: 'command', capturePath: context.capturePath,
      sourceName: context.sourceName, timestamp: new Date().toISOString(), label: label.slice(0, 120), note: note.slice(0, 2000) });
    const update = (index: number, state: StepResult['state'], detail: string) => {
      this.state.steps[index] = { ...this.state.steps[index], state, detail, timestamp: new Date().toISOString() }; this.publish();
    };
    try {
      await abortable(record(event(`${normalized.name} · started`, `${normalized.steps.length} steps`)), signal);
      for (const [index, step] of normalized.steps.entries()) {
        signal.throwIfAborted(); current = index;
        this.state.status = `Step ${index + 1} of ${normalized.steps.length} · ${step.name}`;
        update(index, 'sending', 'Sending command…');
        // Install the matcher before writing: a device can answer before the write promise resolves.
        const response = step.expect ? this.response(step, context.sessionId, signal) : null;
        const write = Promise.resolve().then(() => { signal.throwIfAborted(); return send(step.command); }).then(() => {
          if (response && !signal.aborted) update(index, 'waiting', `Waiting for “${step.expect}”…`);
        });
        if (response) {
          await abortable(Promise.all([write, response]), signal);
        } else await abortable(write, signal);
        signal.throwIfAborted();
        if (step.delayMs) { update(index, 'delay', `Waiting ${step.delayMs / 1000}s before continuing…`); await delay(step.delayMs, signal); }
        signal.throwIfAborted();
        const detail = step.expect ? `Matched “${step.expect}”.` : 'Command sent; no response check configured.';
        await abortable(record(event(`${normalized.name} · ${step.name} passed`, detail)), signal);
        update(index, 'passed', detail);
      }
      this.state.status = 'All steps passed.';
      await abortable(record(event(`${normalized.name} · completed`, 'All steps passed.')), signal);
    } catch (error) {
      const stopped = error instanceof SequenceStopped;
      const detail = error instanceof Error ? error.message : 'The sequence failed.';
      controller.abort(error);
      if (current >= 0) update(current, stopped ? 'stopped' : 'failed', detail);
      this.state.status = detail;
      try { await record(event(`${normalized.name} · ${stopped ? 'stopped' : 'failed'}`, detail)); }
      catch { this.state.status += ' The result could not be saved; check disk space.'; }
    } finally {
      controller.abort(); this.waiter = null; this.controller = null; this.state.running = false; this.publish();
    }
  }
}
