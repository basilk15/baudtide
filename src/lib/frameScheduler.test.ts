import { describe, expect, it, vi } from 'vitest';
import { frameScheduler } from './frameScheduler';

function frames() {
  let id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    request(callback: FrameRequestCallback) { callbacks.set(++id, callback); return id; },
    cancel(frame: number) { callbacks.delete(frame); },
    flush() { const current = [...callbacks.values()]; callbacks.clear(); current.forEach((callback) => callback(0)); },
    count() { return callbacks.size; },
  };
}

describe('coalesced display work', () => {
  it('paints the latest dimensions once for a burst of resize notifications', () => {
    const clock = frames();
    let width = 900;
    const paint = vi.fn(() => width);
    const work = frameScheduler(paint, clock);
    for (let step = 0; step < 100; step++) { width++; work.schedule(); }
    expect(clock.count()).toBe(1);
    expect(paint).not.toHaveBeenCalled();
    clock.flush();
    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint).toHaveReturnedWith(1000);
    work.schedule(); clock.flush();
    expect(paint).toHaveBeenCalledTimes(2);
  });

  it('cancels hidden or disposed work and can schedule a fresh paint after returning', () => {
    const clock = frames(); const paint = vi.fn();
    const work = frameScheduler(paint, clock);
    work.schedule(); work.cancel(); work.cancel(); clock.flush();
    expect(paint).not.toHaveBeenCalled();
    work.schedule(); clock.flush();
    expect(paint).toHaveBeenCalledTimes(1);
    expect(clock.count()).toBe(0);
  });
});
