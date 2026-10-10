import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TelemetryExportStreams } from './telemetry-export.mjs';

describe('desktop telemetry contracts and exports', () => {
  it('keeps the sandboxed preload and main-process command allowlists identical', async () => {
    const contract = createRequire(import.meta.url)('./contract.cjs');
    const preload = await fs.readFile(new URL('./preload.cjs', import.meta.url), 'utf8');
    const list = preload.match(/const commands = Object\.freeze\(\[([\s\S]*?)\]\)/)[1];
    expect([...list.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort()).toEqual([...contract.commands].sort());
  });
  it('publishes bounded chunks atomically and cancellation preserves an existing destination', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baudtide-export-regression-'));
    const destination = path.join(directory, 'result.csv');
    await fs.writeFile(destination, 'previous export');
    const streams = new TelemetryExportStreams();
    const cancelled = await streams.begin(destination);
    await streams.append(cancelled, 'unfinished');
    expect(await fs.readFile(destination, 'utf8')).toBe('previous export');
    await streams.cancel(cancelled);
    expect(await fs.readFile(destination, 'utf8')).toBe('previous export');
    const id = await streams.begin(destination);
    await streams.append(id, 'header\n'); await streams.append(id, 'first\nsecond\n');
    await expect(streams.append(id, 'x'.repeat(256 * 1024 + 1))).rejects.toThrow('256 KB');
    expect(await streams.finish(id)).toBe(destination);
    expect(await fs.readFile(destination, 'utf8')).toBe('header\nfirst\nsecond\n');
    await expect(streams.append(id, 'later')).rejects.toThrow('unavailable');
    await streams.dispose();
    // Retain the isolated result fixture; no user files are modified by this test.
  });
});

describe('export lifecycle regressions', () => {
  it('preserves the previous destination when renderer cleanup interrupts final validation', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baudtide-export-publish-dispose-'));
    const destination = path.join(directory, 'result.csv');
    await fs.writeFile(destination, 'previous export');
    let releaseValidation; let reachedValidation;
    const gate = new Promise((resolve) => { releaseValidation = resolve; });
    const ready = new Promise((resolve) => { reachedValidation = resolve; });
    let validations = 0;
    const streams = new TelemetryExportStreams(async () => {
      if (++validations === 2) { reachedValidation(); await gate; }
    });
    const id = await streams.begin(destination);
    await streams.append(id, 'interrupted export');
    const publication = streams.finish(id);
    const result = Promise.allSettled([publication]);
    await ready;
    const cleanup = streams.dispose();
    releaseValidation();
    const [settled] = await result;
    await cleanup;
    expect(settled.status).toBe('rejected');
    expect(settled.reason.message).toContain('interrupted');
    expect(await fs.readFile(destination, 'utf8')).toBe('previous export');
    expect(await fs.readdir(directory)).toEqual(['result.csv']);
    // Cleanup releases the slot and the next renderer can still export normally.
    const next = await streams.begin(destination);
    await streams.append(next, 'completed export');
    expect(await streams.finish(next)).toBe(destination);
    await streams.dispose();
    expect(await fs.readFile(destination, 'utf8')).toBe('completed export');
  });

  it.each(['before', 'after'])('does not publish a new destination when finalization is queued %s cleanup starts', async (order) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baudtide-export-queued-finish-'));
    const destination = path.join(directory, 'result.csv');
    const streams = new TelemetryExportStreams();
    const id = await streams.begin(destination);
    const append = streams.append(id, 'new export');
    let result; let cleanup;
    if (order === 'before') {
      result = Promise.allSettled([streams.finish(id)]);
      cleanup = streams.dispose();
    } else {
      cleanup = streams.dispose();
      result = Promise.allSettled([streams.finish(id)]);
    }
    await append;
    const [settled] = await result;
    await cleanup;
    expect(settled.status).toBe('rejected');
    expect(settled.reason.message).toContain('interrupted');
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('retains a completed publication when its renderer is subsequently disposed', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baudtide-export-completed-'));
    const destination = path.join(directory, 'result.csv');
    const streams = new TelemetryExportStreams();
    const id = await streams.begin(destination);
    await streams.append(id, 'completed export');
    expect(await streams.finish(id)).toBe(destination);
    await streams.dispose();
    expect(await fs.readFile(destination, 'utf8')).toBe('completed export');
    expect(await fs.readdir(directory)).toEqual(['result.csv']);
  });

  it('waits for an in-flight append during renderer disposal and preserves the destination', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baudtide-export-dispose-'));
    const destination = path.join(directory, 'result.json'); await fs.writeFile(destination, 'previous');
    const streams = new TelemetryExportStreams(); const id = await streams.begin(destination);
    const append = streams.append(id, 'x'.repeat(256 * 1024));
    await streams.dispose(); await append;
    expect(await fs.readFile(destination, 'utf8')).toBe('previous');
    expect((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
  it('serializes concurrent appends and reserves all four stream slots before async opening', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baudtide-export-concurrent-'));
    const streams = new TelemetryExportStreams();
    const ids = [0, 1, 2, 3].map((index) => streams.begin(path.join(directory, `${index}.csv`)));
    await expect(streams.begin(path.join(directory, 'extra.csv'))).rejects.toThrow('Finish');
    const opened = await Promise.all(ids);
    await Promise.all([streams.append(opened[0], 'one\n'), streams.append(opened[0], 'two\n')]);
    const destination = await streams.finish(opened[0]);
    expect(await fs.readFile(destination, 'utf8')).toBe('one\ntwo\n'); await streams.dispose();
  });
  it('rechecks protected destinations at publication and preserves the previous file if validation fails', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baudtide-export-protected-'));
    const destination = path.join(directory, 'result.csv'); await fs.writeFile(destination, 'previous');
    let protectedNow = false;
    const streams = new TelemetryExportStreams(async () => { if (protectedNow) throw new Error('protected'); });
    const id = await streams.begin(destination); await streams.append(id, 'new'); protectedNow = true;
    await expect(streams.finish(id)).rejects.toThrow('protected');
    expect(await fs.readFile(destination, 'utf8')).toBe('previous'); await streams.cancel(id);
  });
  it('protects captures, timing, and application data through directory aliases', async () => {
    const { assertExportDestinationSafe } = await import('./telemetry-export.mjs');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baudtide-export-alias-'));
    const managed = path.join(directory, 'managed'); await fs.mkdir(managed);
    const alias = path.join(directory, 'alias'); await fs.symlink(managed, alias);
    const raw = path.join(managed, 'capture.log'); await fs.writeFile(raw, 'capture');
    await expect(assertExportDestinationSafe(path.join(alias, 'capture.log'), { files: [raw] })).rejects.toThrow('raw capture');
    await expect(assertExportDestinationSafe(path.join(alias, 'history.json'), { directories: [managed] })).rejects.toThrow('managed application data');
    await expect(assertExportDestinationSafe(path.join(directory, 'export.csv'), { directories: [managed] })).resolves.toBeUndefined();
    expect(await fs.readFile(raw, 'utf8')).toBe('capture');
  });
});

describe('interrupted export opening', () => {
  it('rejects destinations returned by dialogs from a departed renderer without leaking export slots', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baudtide-export-dialog-'));
    const destination = path.join(directory, 'result.csv');
    await fs.writeFile(destination, 'previous export');
    const streams = new TelemetryExportStreams();
    const resolvers = [];
    const openings = [0, 1, 2, 3].map(() => streams.beginWithDestination(() => new Promise((resolve) => resolvers.push(resolve))));
    const results = Promise.allSettled(openings);
    await streams.dispose();
    resolvers.forEach((resolve) => resolve(destination));
    const settled = await results;
    expect(settled.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
    for (const result of settled) expect(result.reason.message).toContain('interrupted');
    expect(await fs.readdir(directory)).toEqual(['result.csv']);
    expect(await fs.readFile(destination, 'utf8')).toBe('previous export');
    const id = await streams.beginWithDestination(async () => destination);
    await streams.append(id, 'new export');
    expect(await streams.finish(id)).toBe(destination);
    expect(await fs.readFile(destination, 'utf8')).toBe('new export');
  });

  it('preserves dialog cancellation and propagates dialog errors without opening a stream', async () => {
    const streams = new TelemetryExportStreams(() => { throw new Error('must not validate a cancelled dialog'); });
    await expect(streams.beginWithDestination(async () => null)).resolves.toBeNull();
    await expect(streams.beginWithDestination(async () => { throw new Error('dialog failed'); })).rejects.toThrow('dialog failed');
  });

  it('invalidates legacy publication waiting on a save dialog', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baudtide-export-legacy-dialog-'));
    const destination = path.join(directory, 'result.csv');
    await fs.writeFile(destination, 'previous export');
    const streams = new TelemetryExportStreams();
    let resolveDialog;
    const publication = (async () => {
      const id = await streams.beginWithDestination(() => new Promise((resolve) => { resolveDialog = resolve; }));
      if (!id) return null;
      await streams.append(id, 'legacy export');
      return streams.finish(id);
    })();
    const result = Promise.allSettled([publication]);
    await streams.dispose(); resolveDialog(destination);
    expect((await result)[0].status).toBe('rejected');
    expect(await fs.readFile(destination, 'utf8')).toBe('previous export');
    expect(await fs.readdir(directory)).toEqual(['result.csv']);
  });

  it('invalidates a pending open when its renderer reloads', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'baudtide-export-opening-'));
    let proceed; const gate = new Promise((resolve) => { proceed = resolve; });
    const streams = new TelemetryExportStreams(() => gate);
    const opening = streams.begin(path.join(directory, 'result.csv'));
    await streams.dispose(); proceed();
    await expect(opening).rejects.toThrow('interrupted');
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
