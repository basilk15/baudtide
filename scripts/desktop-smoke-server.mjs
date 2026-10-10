// Development-only browser bridge to the real Rust backend and isolated PTYs.
// Binds loopback, restricts connections to fixtures, and retains all artifacts.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { TelemetryExportStreams } from '../electron/telemetry-export.mjs';
import { CaptureAnalysisReaders } from '../electron/capture-analysis.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'baudtide-desktop-smoke-'));
const backend = spawn(path.join(root, 'src-native/target/debug/baudtide-backend'), ['--app-data-dir', data], { stdio: ['pipe', 'pipe', 'inherit'] });
const fixture = spawn('python3', [path.join(root, 'scripts/desktop-smoke-pty.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
const fixtureOutput = readline.createInterface({ input: fixture.stdout });
const pty = await new Promise((resolve) => fixtureOutput.once('line', resolve));
fixtureOutput.on('line', (line) => { try { received.push(JSON.parse(line)); } catch { /* Fixture diagnostics only. */ } });
const received = [];
const clients = new Set(); const pending = new Map(); let nextId = 1; let exportCount = 0;
const exports = new TelemetryExportStreams();
const commands = new Set(createRequire(import.meta.url)('../electron/contract.cjs').commands);
readline.createInterface({ input: backend.stdout }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.event) { for (const client of clients) client.write(`data: ${JSON.stringify(message)}\n\n`); }
  else {
    const request = pending.get(message.id); pending.delete(message.id);
    if (message.error !== undefined) request?.reject(new Error(message.error)); else request?.resolve(message.result);
  }
});
function invoke(method, params = {}) {
  return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); backend.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
}
const captureAnalyses = new CaptureAnalysisReaders(invoke);
const bridge = `const listeners = new Map();
const events = new EventSource('/smoke/events');
events.onmessage = (event) => { const message = JSON.parse(event.data); for (const callback of listeners.get(message.event) ?? []) callback(message.payload); };
window.baudtideDesktop = {
 invoke: async (command, args = {}) => { const response = await fetch('/smoke/invoke', { method: 'POST', body: JSON.stringify({command,args}) }); const result = await response.json(); if (result.error) throw new Error(result.error); return result.value; },
 listen: (event, callback) => { const callbacks = listeners.get(event) ?? new Set(); callbacks.add(callback); listeners.set(event, callbacks); return () => callbacks.delete(callback); }
};`;
function json(response, value, status = 200) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }
async function body(request) { let data = ''; for await (const part of request) { data += part; if (data.length > 1024 * 1024) throw new Error('Request too large'); } return JSON.parse(data || '{}'); }
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1:1421');
    if (url.pathname === '/smoke/bridge.js') {
      // Mirror the Electron main process's renderer-navigation cleanup.
      await captureAnalyses.dispose();
      response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(bridge); return;
    }
    if (url.pathname === '/smoke/events') { response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); response.write(': connected\n\n'); clients.add(response); request.on('close', () => clients.delete(response)); return; }
    if (url.pathname === '/smoke/state') { json(response, { pty, data, received }); return; }
    if (url.pathname === '/smoke/fixture') { fixture.stdin.write(JSON.stringify(await body(request)) + '\n'); json(response, { ok: true }); return; }
    if (url.pathname === '/smoke/invoke') {
      const { command, args } = await body(request);
      if (!commands.has(command) || command === 'delete_saved_log') throw new Error('Command unavailable in the isolated smoke fixture');
      if (command === 'start_serial_session' && args.request.port !== pty) throw new Error('Smoke connections are restricted to the fixture PTY');
      let value;
      if (command === 'begin_telemetry_export') value = await exports.begin(path.join(data, `export-${++exportCount}.${args.format === 'json' ? 'json' : 'csv'}`));
      else if (command === 'append_telemetry_export') value = await exports.append(args.id, args.contents);
      else if (command === 'finish_telemetry_export') value = await exports.finish(args.id);
      else if (command === 'cancel_telemetry_export') value = await exports.cancel(args.id);
      else if (command === 'open_capture_analysis') value = await captureAnalyses.open(args);
      else if (command === 'read_capture_analysis_chunk') value = await captureAnalyses.read(args);
      else if (command === 'close_capture_analysis') value = await captureAnalyses.close(args);
      else value = await invoke(command, args);
      json(response, { value }); return;
    }
    const upstream = await fetch(`http://127.0.0.1:1420${request.url}`);
    let contents = Buffer.from(await upstream.arrayBuffer());
    if (url.pathname === '/') contents = Buffer.from(contents.toString().replace(/(<script type="module" src="\/src\/main\.tsx[^"]*">)/u, '<script src="/smoke/bridge.js"></script>$1'));
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' }); response.end(contents);
  } catch (error) { json(response, { error: error.message }, 400); }
});
server.listen(1421, '127.0.0.1', () => process.stdout.write(JSON.stringify({ url: 'http://localhost:1421', pty, data }) + '\n'));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await exports.dispose();
  await captureAnalyses.dispose();
  fixture.stdin.end();
  // A fixture can be blocked writing an unopened PTY, so EOF alone is insufficient.
  fixture.kill('SIGTERM');
  backend.stdin.end();
  for (const client of clients) client.end();
  server.close();
  server.closeAllConnections();
}
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
