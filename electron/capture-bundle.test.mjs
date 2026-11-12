import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll as after, beforeAll as before, it as test } from 'vitest';
import { exportCaptureBundle, importCaptureBundle } from './capture-bundle.mjs';

let directory;
before(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'baudtide-bundle-test-')); });
after(async () => {
  if (path.dirname(directory) !== path.resolve(os.tmpdir())) throw new Error('Unexpected test directory');
  await rm(directory, { recursive: true, force: true });
});

const note = { timestamp: '2026-01-01T00:00:01.000Z', label: 'Spike', note: 'Before reset', sourceName: 'Board' };
const metadata = { name: 'Board', notes: [note], decoder: null };
const raw = Buffer.from([0, 255, 13, 10, 49, 44, 50, 10]);
const timing = Buffer.alloc(24);
timing.write('BTIME001');
timing.writeBigUInt64LE(BigInt(raw.length), 8);
timing.writeBigInt64LE(1767225601000n, 16);
const prefixSize = 44;
function encodeBundle(manifest, payload) {
  const header = Buffer.from(JSON.stringify(manifest));
  const prefix = Buffer.alloc(prefixSize);
  prefix.write('BTBND002');
  prefix.writeUInt32BE(header.length, 8);
  createHash('sha256').update(header).digest().copy(prefix, 12);
  return Buffer.concat([prefix, header, payload]);
}

test('exports and imports exact raw bytes, receive timing and notes', async () => {
  const rawPath = path.join(directory, 'original.log');
  const timingPath = `${rawPath}.timing`;
  const bundlePath = path.join(directory, 'recording.btbundle');
  await writeFile(rawPath, raw);
  await writeFile(timingPath, timing);
  await exportCaptureBundle({ rawPath, timingPath, destination: bundlePath, metadata });
  const result = await importCaptureBundle({ source: bundlePath, stagingRoot: directory });
  assert.deepEqual(await readFile(result.rawPath), raw);
  assert.deepEqual(await readFile(result.timingPath), timing);
  assert.deepEqual(result.metadata, metadata);
});

test('shipped example opens with recorded timing and a note', async () => {
  const example = new URL('./examples/temperature-demo.btbundle', import.meta.url);
  const result = await importCaptureBundle({ source: example, stagingRoot: directory });
  assert.match((await readFile(result.rawPath)).toString(), /"temperature"/);
  assert.equal(result.metadata.notes[0].label, 'Temperature spike');
  assert.notEqual(result.timingPath, null);
});

test('preserves absent timing as absent', async () => {
  const rawPath = path.join(directory, 'legacy.log');
  const bundlePath = path.join(directory, 'legacy.btbundle');
  await writeFile(rawPath, raw);
  await exportCaptureBundle({ rawPath, destination: bundlePath, metadata });
  const result = await importCaptureBundle({ source: bundlePath, stagingRoot: directory });
  assert.equal(result.timingPath, null);
  assert.deepEqual(await readFile(result.rawPath), raw);
});

test('rejects a valid-JSON change to capture notes', async () => {
  const bundle = await readFile(path.join(directory, 'recording.btbundle'));
  const original = Buffer.from('Before reset');
  const position = bundle.indexOf(original);
  assert.notEqual(position, -1);
  bundle[position] = 'b'.charCodeAt(0);
  const source = path.join(directory, 'corrupt-metadata.btbundle');
  await writeFile(source, bundle);
  await assert.rejects(importCaptureBundle({ source, stagingRoot: directory }), /checksum/i);
});

test.skipIf(process.platform === 'win32')('exports bundles with private file permissions', async () => {
  const rawPath = path.join(directory, 'private.log');
  const destination = path.join(directory, 'private.btbundle');
  await writeFile(rawPath, raw);
  await writeFile(destination, 'old', { mode: 0o644 });
  await exportCaptureBundle({ rawPath, destination, metadata });
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
});

test('does not add local device paths or unrelated metadata to the bundle', async () => {
  const rawPath = path.join(directory, 'privacy.log');
  const bundlePath = path.join(directory, 'privacy.btbundle');
  await writeFile(rawPath, raw);
  await exportCaptureBundle({ rawPath, destination: bundlePath, metadata: { ...metadata, port: '/dev/ttyUSB0', deviceSerial: 'private' } });
  const result = await importCaptureBundle({ source: bundlePath, stagingRoot: directory });
  assert.deepEqual(result.metadata, metadata);
  assert.equal((await readFile(bundlePath)).includes(Buffer.from('/dev/ttyUSB0')), false);
});

test('retains a selected decoder and original time bounds', async () => {
  const rawPath = path.join(directory, 'decoder.log');
  const bundlePath = path.join(directory, 'decoder.btbundle');
  const decoder = { version: 1, id: 'profile-1', name: 'Sensor', prefix: 'DATA', separator: 'comma', fields: [{ column: 1, name: 'temperature', unit: 'C' }], createdAt: 1, updatedAt: 2 };
  const withDecoder = { ...metadata, decoder, startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:03.000Z' };
  await writeFile(rawPath, raw);
  await exportCaptureBundle({ rawPath, destination: bundlePath, metadata: withDecoder });
  const result = await importCaptureBundle({ source: bundlePath, stagingRoot: directory });
  assert.deepEqual(result.metadata, withDecoder);
});

test('rejects an invalid decoder before publishing an imported capture', async () => {
  const original = await readFile(path.join(directory, 'recording.btbundle'));
  const length = original.readUInt32BE(8);
  const manifest = JSON.parse(original.subarray(prefixSize, prefixSize + length));
  manifest.metadata.decoder = { version: 1, id: 'x', name: 'Broken', prefix: '', separator: 'bogus', fields: [{ column: 1, name: 'x' }], createdAt: 1, updatedAt: 1 };
  const source = path.join(directory, 'invalid-decoder.btbundle');
  await writeFile(source, encodeBundle(manifest, original.subarray(prefixSize + length)));
  await assert.rejects(importCaptureBundle({ source, stagingRoot: directory }), /decoder details are malformed/);
});

test('rejects damaged, truncated and appended bundle data without leaving staged files', async () => {
  const original = await readFile(path.join(directory, 'recording.btbundle'));
  const damaged = Buffer.from(original);
  damaged[damaged.length - 1] ^= 0xff;
  for (const [name, bytes] of [
    ['bad-magic', Buffer.concat([Buffer.from('NOPE'), original.subarray(4)])],
    ['truncated', original.subarray(0, original.length - 1)],
    ['damaged', damaged],
    ['appended', Buffer.concat([original, Buffer.from('x')])],
  ]) {
    const source = path.join(directory, `${name}.btbundle`);
    const stagingRoot = path.join(directory, `stage-${name}`);
    await (await import('node:fs/promises')).mkdir(stagingRoot);
    await writeFile(source, bytes);
    await assert.rejects(importCaptureBundle({ source, stagingRoot }));
    assert.deepEqual(await (await import('node:fs/promises')).readdir(stagingRoot), []);
  }
});

test('rejects unsupported versions and oversized manifests before extraction', async () => {
  for (const [name, manifest] of [
    ['version', Buffer.from(JSON.stringify({ version: 99 }))],
    ['large', Buffer.alloc(256 * 1024 + 1, 32)],
  ]) {
    const prefix = Buffer.alloc(prefixSize);
    prefix.write('BTBND002');
    prefix.writeUInt32BE(manifest.length, 8);
    createHash('sha256').update(manifest).digest().copy(prefix, 12);
    const source = path.join(directory, `${name}.btbundle`);
    await writeFile(source, Buffer.concat([prefix, manifest]));
    await assert.rejects(importCaptureBundle({ source, stagingRoot: directory }));
  }
});

test('does not accept malformed timing even if its digest matches', async () => {
  const original = await readFile(path.join(directory, 'recording.btbundle'));
  const manifestLength = original.readUInt32BE(8);
  const manifest = JSON.parse(original.subarray(prefixSize, prefixSize + manifestLength));
  const invalidTiming = Buffer.from(timing);
  invalidTiming.writeBigUInt64LE(999n, 8);
  manifest.timing.sha256 = createHash('sha256').update(invalidTiming).digest('hex');
  const source = path.join(directory, 'invalid-timing.btbundle');
  await writeFile(source, encodeBundle(manifest, Buffer.concat([raw, invalidTiming])));
  await assert.rejects(importCaptureBundle({ source, stagingRoot: directory }), /timing contains invalid entries/);
});
