import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CaptureBundleService } from './capture-bundle-service.mjs';
const capture = { sessionName: 'Board', state: 'saved', modifiedAt: '2026-01-01T00:00:00.000Z' };
async function cleanup(directory) {
  if (path.dirname(directory) !== path.resolve(os.tmpdir())) throw new Error('Unexpected test directory');
  await rm(directory, { recursive: true, force: true });
}

describe('capture bundle desktop service', () => {
  it('exports through a capture lease and always releases it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bt-service-'));
    const raw = path.join(dir, 'source.log'); await writeFile(raw, 'temperature=20\n');
    const calls = [];
    const invoke = async (command) => { calls.push(command); if (command === 'begin_capture_bundle_export') return { id: 'lease', path: raw, timingMode: 'approximate', capture }; };
    const service = new CaptureBundleService({ invoke, stagingRoot: path.join(dir, 'staging'), validateDestination: async () => {} });
    const destination = path.join(dir, 'one.btbundle');
    await service.exportBundle({ sourcePath: raw, destination, metadata: { name: 'Board', notes: [], decoder: null } });
    expect((await readFile(destination)).subarray(0, 8).toString()).toBe('BTBND001');
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
      if (command === 'reserve_capture_bundle_import') return { id: 'reservation' };
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
      if (command === 'reserve_capture_bundle_import') return { id: 'reservation' };
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
