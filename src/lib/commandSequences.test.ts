import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandSequenceRunner, normalizeCommandSequences, type CommandSequence, type SequenceRunState } from './commandSequences';
import type { CaptureEvent } from './captureEvents';

const context = { sessionId: 'native', capturePath: '/board.log', sourceName: 'Board' };
const sequence: CommandSequence = { id: 'test', name: 'Calibration', steps: [
  { id: 'read', name: 'Read sensor', command: { payload: 'read', mode: 'text', lineEnding: 'crlf' }, expect: 'OK', timeoutMs: 1000, delayMs: 0 },
  { id: 'save', name: 'Save settings', command: { payload: 'AA FF', mode: 'hex', lineEnding: 'none' }, expect: '', timeoutMs: 1000, delayMs: 0 },
] };
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }
function fixture() {
  const states: SequenceRunState[] = []; const events: CaptureEvent[] = [];
  const runner = new CommandSequenceRunner((state) => states.push(state));
  let nextSequence = 0;
  const feed = (text: string, skipped = 0, sessionId = context.sessionId) => {
    nextSequence += skipped + 1;
    runner.observe({ sessionId, port: '/dev/test', sequence: nextSequence, timestamp: new Date().toISOString(), text, bytes: [...new TextEncoder().encode(text)] });
  };
  const record = vi.fn(async (event: CaptureEvent) => { events.push(event); });
  return { runner, states, events, feed, record };
}
afterEach(() => vi.useRealTimers());
describe('command sequence execution', () => {
  it('installs response checks before sending and records each result in its capture', async () => {
    const f = fixture();
    const send = vi.fn(async (_command: typeof sequence.steps[number]['command']) => { if (send.mock.calls.length === 1) { f.feed('O'); f.feed('K'); } });
    await f.runner.run(sequence, context, send, f.record);
    expect(send.mock.calls.map(([command]) => command)).toEqual(sequence.steps.map((s) => s.command));
    expect(f.states[f.states.length - 1]?.steps.every((step) => step.state === 'passed')).toBe(true);
    expect(f.events).toHaveLength(4);
    expect(f.events.every((event) => event.capturePath === context.capturePath && event.kind === 'command')).toBe(true);
    expect(f.events[f.events.length - 1]?.label).toContain('completed'); expect(f.runner.running).toBe(false);
  });
  it('stops immediately during a pending write and never sends the next command', async () => {
    const f = fixture(); let finish!: () => void;
    const send = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const promise = f.runner.run(sequence, context, send, f.record); await flush();
    expect(send).toHaveBeenCalledOnce(); f.runner.stop(); await promise;
    expect(f.states[f.states.length - 1]?.steps[0].state).toBe('stopped'); expect(f.runner.running).toBe(false);
    finish(); await flush(); expect(send).toHaveBeenCalledOnce();
    expect(f.events[f.events.length - 1]?.label).toContain('stopped');
  });
  it('fails on timeout while a write is pending, without waiting for that write', async () => {
    vi.useFakeTimers(); const f = fixture();
    const send = vi.fn(() => new Promise<void>(() => {}));
    const promise = f.runner.run(sequence, context, send, f.record); await flush();
    await vi.advanceTimersByTimeAsync(1000); await promise;
    expect(f.states[f.states.length - 1]?.steps[0].state).toBe('failed');
    expect(f.states[f.states.length - 1]?.status).toContain('No response'); expect(send).toHaveBeenCalledOnce();
  });
  it('does not reuse responses from previous steps or another session', async () => {
    vi.useFakeTimers(); const f = fixture();
    const both = { ...sequence, steps: sequence.steps.map((s) => ({ ...s, expect: 'OK' })) };
    const send = vi.fn(async () => { if (send.mock.calls.length === 1) f.feed('OKOK'); });
    const promise = f.runner.run(both, context, send, f.record); await flush();
    expect(send).toHaveBeenCalledTimes(2); f.feed('OK', 0, 'other');
    await vi.advanceTimersByTimeAsync(1000); await promise;
    expect(f.states[f.states.length - 1]?.steps.map((s) => s.state)).toEqual(['passed', 'failed']);
  });
  it('stops on missing receive chunks and cancels delays before another command', async () => {
    const f = fixture(); const send = vi.fn(async () => {});
    const promise = f.runner.run(sequence, context, send, f.record); await flush();
    f.feed('O'); f.feed('K', 1); await promise;
    expect(f.states[f.states.length - 1]?.status).toContain('missed'); expect(send).toHaveBeenCalledOnce();
    vi.useFakeTimers(); const d = fixture();
    const delayed = { ...sequence, steps: sequence.steps.map((s) => ({ ...s, expect: '', delayMs: 1000 })) };
    const pending = d.runner.run(delayed, context, send, d.record); await flush(); d.runner.stop(); await pending;
    await vi.advanceTimersByTimeAsync(2000); expect(send).toHaveBeenCalledTimes(2);
  });
  it('stops before transmitting if capture results cannot be saved', async () => {
    const f = fixture(); const send = vi.fn(async () => {});
    await f.runner.run(sequence, context, send, async () => { throw new Error('Disk full'); });
    expect(send).not.toHaveBeenCalled(); expect(f.states[f.states.length - 1]?.status).toContain('could not be saved');
  });
  it('validates all commands before starting, including malformed hex and nonfinite durations', async () => {
    const f = fixture(); const send = vi.fn(async () => {});
    const invalid = structuredClone(sequence); invalid.steps[1].command.payload = 'not hex';
    await expect(f.runner.run(invalid, context, send, f.record)).rejects.toThrow('valid sequence');
    expect(send).not.toHaveBeenCalled(); expect(normalizeCommandSequences([{ ...sequence, steps: [{ ...sequence.steps[0], delayMs: NaN }] }])).toBeNull();
  });
});
