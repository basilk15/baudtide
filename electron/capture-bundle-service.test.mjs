import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CaptureBundleService } from './capture-bundle-service.mjs';
const capture = { sessionName: 'Board', state: 'saved', modifiedAt: '2026-01-01T00:00:00.000Z' };
async function cleanup(directory) {
  if (path.dirname(directory) !== path.resolve(os.tmpdir())) throw new Error('Unexpected test directory');
  await rm(directory, { recursive: true, force: true });
}

describe('capture bundle desktop service', () => {
  it('cleans abandoned imports without touching live or unrelated files', async () => {
    const { cleanupInterruptedBundleImports } = await import('./capture-bundle-service.mjs');
    expect(cleanupInterruptedBundleImports).toBeTypeOf('function');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bt-service-cleanup-'));
    const staging = path.join(dir, 'staging'); const captures = path.join(dir, 'captures');
    await mkdir(staging); await mkdir(captures);
    await mkdir(path.join(staging, 'bundle-222-333-abcdef'));
    await mkdir(path.join(staging, 'bundle-111-222-ghijkl'));
    await mkdir(path.join(staging, 'bundle-222-111-mnopqr'));
    await mkdir(path.join(staging, 'unrelated'));
    const id = 'bbcd04f3-42f3-4db9-9412-a775e89631bc';
    for (const name of [`.bundle-222-${id}.tmp`, `.bundle-222-${id}.timing.tmp`, `.bundle-111-${id}.tmp`, '.bundle-personal.tmp']) {
      await writeFile(path.join(captures, name), 'data');
    }
    await cleanupInterruptedBundleImports({ stagingRoot: staging, captureDirectories: [captures], isProcessRunning: (pid) => pid === 111 });
    expect((await readdir(staging)).sort()).toEqual(['bundle-111-222-ghijkl', 'bundle-222-111-mnopqr', 'unrelated']);
    expect((await readdir(captures)).sort()).toEqual([`.bundle-111-${id}.tmp`, '.bundle-personal.tmp'].sort());
    await cleanup(dir);
  });
  it('removes orphan timing and metadata only when the imported raw capture was never published', async () => {
    const { cleanupInterruptedBundleImports } = await import('./capture-bundle-service.mjs');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bt-service-orphan-'));
    const staging = path.join(dir, 'bundle-staging'); const captures = path.join(dir, 'captures');
    const recovery = path.join(dir, 'bundle-imports'); const index = path.join(dir, 'logs', 'index');
    await Promise.all([mkdir(staging), mkdir(captures), mkdir(recovery), mkdir(index, { recursive: true })]);
    const missingId = 'bbcd04f3-42f3-4db9-9412-a775e89631bc';
    const completedId = 'acbd04f3-42f3-4db9-9412-a775e89631bc';
    for (const id of [missingId, completedId]) {
      const capturePath = path.join(captures, `Board-${id}.log`);
      await writeFile(`${capturePath}.timing`, 'timing');
      await writeFile(path.join(captures, `.bundle-222-${id}.tmp`), 'partial');
      await writeFile(path.join(recovery, `${id}.json`), JSON.stringify({ id, capturePath }));
      await writeFile(path.join(index, `${id}.json`), JSON.stringify({ sessionId: id, logPath: capturePath }));
      if (id === completedId) await writeFile(capturePath, 'finished');
    }
    await cleanupInterruptedBundleImports({ stagingRoot: staging, captureDirectories: [captures], isProcessRunning: () => false });
    expect(await readdir(captures)).toEqual([`Board-${completedId}.log`, `Board-${completedId}.log.timing`]);
    expect(await readdir(recovery)).toEqual([`${completedId}.json`]);
    expect(await readdir(index)).toEqual([`${completedId}.json`]);
    await cleanup(dir);
  });
  it('cleans orphans through directory aliases and preserves anchors for invalid recovery metadata', async () => {
    const { cleanupInterruptedBundleImports } = await import('./capture-bundle-service.mjs');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bt-service-alias-'));
    const staging = path.join(dir, 'bundle-staging'); const captures = path.join(dir, 'captures');
    const alias = path.join(dir, 'alias'); const recovery = path.join(dir, 'bundle-imports');
    await Promise.all([mkdir(staging), mkdir(captures), mkdir(recovery)]);
    await symlink(captures, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const id = 'bbcd04f3-42f3-4db9-9412-a775e89631bc';
    const invalidId = 'acbd04f3-42f3-4db9-9412-a775e89631bc';
    const capturePath = path.join(await realpath(captures), `Board-${id}.log`);
    await writeFile(`${capturePath}.timing`, 'timing');
    await writeFile(path.join(captures, `.bundle-222-${id}.tmp`), 'partial');
    await writeFile(path.join(recovery, `${id}.json`), JSON.stringify({ id, capturePath }));
    await writeFile(path.join(captures, `.bundle-222-${invalidId}.tmp`), 'partial');
    await writeFile(path.join(recovery, `${invalidId}.json`), '{broken');
    await cleanupInterruptedBundleImports({ stagingRoot: staging, captureDirectories: [alias], isProcessRunning: () => false });
    expect(await readdir(captures)).toEqual([`.bundle-222-${invalidId}.tmp`]);
    expect(await readdir(recovery)).toEqual([`${invalidId}.json`]);
    await cleanup(dir);
  });
  it('checks staging and destination space separately across filesystems', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bt-service-volumes-'));
    const raw = path.join(dir, 'source.log'); const destination = path.join(dir, 'library');
    await mkdir(destination); await writeFile(raw, Buffer.alloc(8 * 1024 * 1024));
    let published = 0;
    const invoke = async (command) => {
      if (command === 'begin_capture_bundle_export') return { id: 'lease', path: raw, timingMode: 'approximate', capture };
      if (command === 'reserve_capture_bundle_import') return { id: 'reservation', directory: destination };
      if (command === 'publish_capture_bundle') { published += 1; return { id: 'published' }; }
    };
    let stageDevice = 1; let destinationFree = 80n * 1024n * 1024n;
    const getDiskSpace = async (directory) => directory === destination
      ? { device: 2, available: destinationFree }
      : { device: stageDevice, available: 75n * 1024n * 1024n };
    const service = new CaptureBundleService({ invoke, stagingRoot: path.join(dir, 'staging'), validateDestination: async () => {}, getDiskSpace });
    const bundle = path.join(dir, 'one.btbundle');
    await service.exportBundle({ sourcePath: raw, destination: bundle, metadata: { notes: [], decoder: null } });
    await expect(service.importBundle(bundle)).resolves.toMatchObject({ id: 'published' });
    destinationFree = 70n * 1024n * 1024n;
    await expect(service.importBundle(bundle)).rejects.toThrow('space');
    destinationFree = 80n * 1024n * 1024n; stageDevice = 2;
    await expect(service.importBundle(bundle)).rejects.toThrow('space');
    expect(published).toBe(1);
    await cleanup(dir);
  });
  it('exports through a capture lease and always releases it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bt-service-'));
    const raw = path.join(dir, 'source.log'); await writeFile(raw, 'temperature=20\n');
    const calls = [];
    const invoke = async (command) => { calls.push(command); if (command === 'begin_capture_bundle_export') return { id: 'lease', path: raw, timingMode: 'approximate', capture }; };
    const service = new CaptureBundleService({ invoke, stagingRoot: path.join(dir, 'staging'), validateDestination: async () => {} });
    const destination = path.join(dir, 'one.btbundle');
    await service.exportBundle({ sourcePath: raw, destination, metadata: { name: 'Board', notes: [], decoder: null } });
    expect((await readFile(destination)).subarray(0, 8).toString()).toBe('BTBND002');
    expect(calls).toEqual(['begin_capture_bundle_export', 'end_capture_bundle_export']);
    await expect(service.exportBundle({ sourcePath: raw, destination, metadata: { name: '', notes: 'invalid', decoder: null } })).rejects.toThrow();
    expect(calls.at(-1)).toBe('end_capture_bundle_export');
    await cleanup(dir);
  });
  it('publishes verified staged bytes and removes the private staging directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bt-service-'));
    const raw = path.join(dir, 'source.log'); await writeFile(raw, 'temperature=20\n');
    const stagingRoot = path.join(dir, 'staging'); await mkdir(stagingRoot);
    let published = '';
    const invoke = async (command, args) => {
      if (command === 'begin_capture_bundle_export') return { id: 'lease', path: raw, timingMode: 'approximate', capture };
      if (command === 'reserve_capture_bundle_import') return { id: 'reservation', directory: dir };
      if (command === 'publish_capture_bundle') { published = (await readFile(path.join(args.stage, 'capture.log'))).toString(); return { id: 'new-id', capturePath: '/library/new.log', metadata: args.metadata }; }
    };
    const service = new CaptureBundleService({ invoke, stagingRoot, validateDestination: async () => {} });
    const destination = path.join(dir, 'one.btbundle');
    await service.exportBundle({ sourcePath: raw, destination, metadata: { name: 'Board', notes: [], decoder: null } });
    const result = await service.importBundle(destination);
    expect(published).toBe('temperature=20\n'); expect(result.capturePath).toBe('/library/new.log');
    expect(await readdir(stagingRoot)).toEqual([]);
    await cleanup(dir);
  });
  it('rechecks the export destination before publishing and preserves an existing file on failure', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bt-service-'));
    const raw = path.join(dir, 'source.log'); const destination = path.join(dir, 'result.btbundle');
    await writeFile(raw, 'hello'); await writeFile(destination, 'keep'); let checks = 0;
    const invoke = async (command) => command === 'begin_capture_bundle_export' ? { id: 'lease', path: raw, timingMode: 'approximate', capture } : undefined;
    const service = new CaptureBundleService({ invoke, stagingRoot: dir, validateDestination: async () => { if (++checks === 2) throw new Error('Destination became protected'); } });
    await expect(service.exportBundle({ sourcePath: raw, destination, metadata: { name: 'Board', notes: [], decoder: null } })).rejects.toThrow('protected');
    expect((await readFile(destination)).toString()).toBe('keep');
    await cleanup(dir);
  });
  it('reserves capacity before extracting bundle bytes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bt-service-')); const raw = path.join(dir, 'source.log');
    await writeFile(raw, 'hello'); const stagingRoot = path.join(dir, 'staging');
    const invoke = async (command) => {
      if (command === 'begin_capture_bundle_export') return { id: 'lease', path: raw, timingMode: 'approximate', capture };
      if (command === 'reserve_capture_bundle_import') throw new Error('Capture library full');
    };
    const service = new CaptureBundleService({ invoke, stagingRoot, validateDestination: async () => {} });
    const bundle = path.join(dir, 'one.btbundle');
    await service.exportBundle({ sourcePath: raw, destination: bundle, metadata: { name: 'Board', notes: [], decoder: null } });
    await expect(service.importBundle(bundle)).rejects.toThrow('library full');
    expect(await readdir(stagingRoot)).toEqual([]);
    await cleanup(dir);
  });
  it('returns a published import even if private staging cleanup fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bt-service-')); const raw = path.join(dir, 'source.log'); await writeFile(raw, 'hello');
    const invoke = async (command) => {
      if (command === 'begin_capture_bundle_export') return { id: 'lease', path: raw, timingMode: 'approximate', capture };
      if (command === 'reserve_capture_bundle_import') return { id: 'reservation', directory: dir };
      if (command === 'publish_capture_bundle') return { id: 'published', capturePath: '/library/new.log' };
    };
    const service = new CaptureBundleService({ invoke, stagingRoot: path.join(dir, 'staging'), validateDestination: async () => {}, removeStaging: async () => { throw new Error('busy'); } });
    const bundle = path.join(dir, 'one.btbundle');
    await service.exportBundle({ sourcePath: raw, destination: bundle, metadata: { name: 'Board', notes: [], decoder: null } });
    expect((await service.importBundle(bundle)).id).toBe('published');
    await cleanup(dir);
  });
  it('exports the native capture state rather than trusting stale renderer metadata', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bt-service-')); const raw = path.join(dir, 'source.log'); await writeFile(raw, 'hello');
    const invoke = async (command) => command === 'begin_capture_bundle_export' ? { id: 'lease', path: raw, timingMode: 'approximate', capture: { ...capture, state: 'interrupted' } } : undefined;
    const service = new CaptureBundleService({ invoke, stagingRoot: dir, validateDestination: async () => {} });
    const bundle = path.join(dir, 'one.btbundle');
    await service.exportBundle({ sourcePath: raw, destination: bundle, metadata: { name: 'Board', state: 'saved', notes: [], decoder: null } });
    const { importCaptureBundle } = await import('./capture-bundle.mjs');
    const staged = await importCaptureBundle({ source: bundle, stagingRoot: dir });
    expect(staged.metadata.state).toBe('interrupted');
    await cleanup(dir);
  });
});
