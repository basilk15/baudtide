import { describe, expect, it, vi } from 'vitest';
import { CaptureAnalysisReaders } from './capture-analysis.mjs';

function fixture() {
  const active = new Set();
  let sequence = 0;
  const invoke = vi.fn(async (command, args) => {
    if (command === 'open_capture_analysis') {
      if (active.size >= 4) throw new Error('Reader limit reached');
      const id = `reader-${++sequence}`; active.add(id);
      return { id, totalBytes: 100, timingMode: 'recorded' };
    }
    if (command === 'close_capture_analysis') { active.delete(args.id); return null; }
    if (command === 'read_capture_analysis_chunk') {
      if (!active.has(args.id)) throw new Error('Unknown reader');
      return { offset: 0, nextOffset: 100, totalBytes: 100, rawBase64: '', timing: [] };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  return { active, invoke, readers: new CaptureAnalysisReaders(invoke) };
}

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

describe('capture reader ownership across renderer lifetimes', () => {
  it('forwards normal reads and closes, and makes repeated close harmless', async () => {
    const { readers, invoke, active } = fixture();
    const args = { path: '/capture.log' };
    const handle = await readers.open(args);
    expect(invoke).toHaveBeenCalledWith('open_capture_analysis', args);
    expect((await readers.read({ id: handle.id })).nextOffset).toBe(100);
    await readers.close({ id: handle.id }); await readers.close({ id: handle.id });
    expect(active.size).toBe(0);
    expect(invoke.mock.calls.filter(([command]) => command === 'close_capture_analysis')).toHaveLength(1);
    await expect(readers.read({ id: handle.id })).rejects.toThrow('no longer open');
  });

  it('releases all four slots through repeated renderer reloads without restarting the backend', async () => {
    const { readers, active } = fixture();
    for (let reload = 0; reload < 6; reload += 1) {
      const handles = await Promise.all(Array.from({ length: 4 }, () => readers.open({ path: '/capture.log' })));
      expect(active.size).toBe(4);
      await readers.dispose();
      expect(active.size).toBe(0);
      await expect(readers.read({ id: handles[0].id })).rejects.toThrow('no longer open');
    }
    const handle = await readers.open({ path: '/capture.log' });
    await readers.close({ id: handle.id });
  });

  it('closes an open that completes after reload and lets the new renderer wait for freed slots', async () => {
    const { active, invoke } = fixture();
    const openingGate = gate(); const entered = gate(); let first = true;
    const readers = new CaptureAnalysisReaders(async (command, args) => {
      if (command === 'open_capture_analysis' && first) { first = false; entered.release(); await openingGate.promise; }
      return invoke(command, args);
    });
    const oldOpen = readers.open({ path: '/old.log' });
    const interrupted = expect(oldOpen).rejects.toThrow('interrupted');
    await entered.promise;
    const disposing = readers.dispose();
    const newOpen = readers.open({ path: '/new.log' });
    openingGate.release();
    await interrupted; await disposing;
    const next = await newOpen;
    expect([...active]).toEqual([next.id]);
    expect(invoke).toHaveBeenCalledWith('close_capture_analysis', { id: 'reader-1' });
    await readers.dispose();
  });

  it('invalidates another renderer reload while an open is waiting for cleanup', async () => {
    const { active, invoke } = fixture();
    const closeGate = gate(); const entered = gate();
    const readers = new CaptureAnalysisReaders(async (command, args) => {
      if (command === 'close_capture_analysis') { entered.release(); await closeGate.promise; }
      return invoke(command, args);
    });
    await readers.open({ path: '/old.log' });
    const disposing = readers.dispose(); await entered.promise;
    const waiting = readers.open({ path: '/waiting.log' });
    const interrupted = expect(waiting).rejects.toThrow('interrupted');
    const secondDispose = readers.dispose(); closeGate.release();
    await disposing; await secondDispose; await interrupted;
    expect(active.size).toBe(0);
    expect(invoke.mock.calls.filter(([command]) => command === 'open_capture_analysis')).toHaveLength(1);
  });

  it('rejects late read results from an abandoned renderer', async () => {
    const { invoke } = fixture(); const readGate = gate(); const entered = gate();
    const readers = new CaptureAnalysisReaders(async (command, args) => {
      if (command === 'read_capture_analysis_chunk') { const result = await invoke(command, args); entered.release(); await readGate.promise; return result; }
      return invoke(command, args);
    });
    const { id } = await readers.open({ path: '/capture.log' });
    const reading = readers.read({ id }); const interrupted = expect(reading).rejects.toThrow('interrupted');
    await entered.promise; await readers.dispose(); readGate.release(); await interrupted;
  });

  it('retains ownership after a failed native close so cleanup can retry', async () => {
    const { active, invoke } = fixture(); let fail = true;
    const readers = new CaptureAnalysisReaders(async (command, args) => {
      if (command === 'close_capture_analysis' && fail) { fail = false; throw new Error('Native close failed'); }
      return invoke(command, args);
    });
    await readers.open({ path: '/capture.log' });
    await expect(readers.dispose()).rejects.toThrow('Native close failed');
    expect(active.size).toBe(1);
    await readers.dispose(); expect(active.size).toBe(0);
    const handle = await readers.open({ path: '/capture.log' });
    await readers.close({ id: handle.id }); expect(active.size).toBe(0);
  });
});
