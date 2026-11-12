// Exercises the real sidecar and bundle service with an isolated synthetic capture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CaptureBundleService } from '../../electron/capture-bundle-service.mjs';
import { importCaptureBundle } from '../../electron/capture-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const data = await mkdtemp(path.join(os.tmpdir(), 'baudtide-bundle-smoke-'));
const executable = path.join(root, 'src-native', 'target', 'debug', process.platform === 'win32' ? 'baudtide-backend.exe' : 'baudtide-backend');
const child = spawn(executable, ['--app-data-dir', data], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map(); let sequence = 0;
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line); const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
});
child.on('exit', (code) => { for (const request of pending.values()) request.reject(new Error(`Sidecar exited: ${code}`)); pending.clear(); });
function invoke(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); });
}
try {
  const service = new CaptureBundleService({ invoke, stagingRoot: path.join(data, 'bundle-staging'), validateDestination: async () => {} });
  const original = path.join(root, 'electron', 'examples', 'temperature-demo.btbundle');
  const imported = await service.importBundle(original);
  assert.equal(imported.metadata.notes[0].label, 'Temperature spike');
  const logs = await invoke('list_saved_logs');
  assert.equal(logs.length, 1); assert.equal(logs[0].state, 'saved');
  const analysis = await invoke('open_capture_analysis', { path: logs[0].path });
  assert.equal(analysis.timingMode, 'recorded');
  const chunk = await invoke('read_capture_analysis_chunk', { id: analysis.id });
  await invoke('close_capture_analysis', { id: analysis.id });
  const raw = Buffer.from(chunk.rawBase64, 'base64'); assert.match(raw.toString(), /"temperature"/);
  const destination = path.join(data, 'roundtrip.btbundle');
  await service.exportBundle({ sourcePath: logs[0].path, destination, metadata: imported.metadata });
  const extracted = await importCaptureBundle({ source: destination, stagingRoot: data });
  assert.deepEqual(await readFile(extracted.rawPath), raw);
  assert.equal(extracted.metadata.notes[0].label, 'Temperature spike');
  assert.equal((await invoke('pending_capture_bundle_imports')).length, 1);
  await invoke('finish_capture_bundle_import', { id: imported.id });
  assert.deepEqual(await invoke('pending_capture_bundle_imports'), []);
  console.log('Bundle smoke passed: sidecar import, timing, export, and recovery.');
  await invoke('shutdown');
} finally {
  if (child.exitCode === null) child.kill();
  if (path.dirname(data) === path.resolve(os.tmpdir())) await rm(data, { recursive: true, force: true });
}
