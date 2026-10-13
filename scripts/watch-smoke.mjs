// Runs only against desktop-smoke-server's isolated PTY. It never opens hardware.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const origin = 'http://127.0.0.1:1421';
async function post(route, body) {
  const response = await fetch(`${origin}${route}`, { method: 'POST', body: JSON.stringify(body) });
  const result = await response.json();
  assert(response.ok, result.error); return result;
}
const invoke = async (command, args = {}) => (await post('/smoke/invoke', { command, args })).value;
async function until(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('Watch smoke condition timed out.');
}
const fixture = await (await fetch(`${origin}/smoke/state`)).json();
assert.match(fixture.pty, /^\/dev\/pts\/\d+$/u);
assert.equal((await invoke('list_active_sessions')).length, 0, 'Start this check with a fresh smoke server.');
const session = await invoke('start_serial_session', { request: { port: fixture.pty, sessionName: 'Watch smoke', baudRate: 115200,
  settings: { dataBits: 8, parity: 'none', stopBits: 'one', flowControl: 'none' } } });
const identity = `serial:${encodeURIComponent(session.port)}:115200:8:none:one:none`;
await post('/smoke/fixture', { temperatures: [20, 21] });
await new Promise((resolve) => setTimeout(resolve, 250));
const historyBefore = await invoke('watch_history_summary');
await invoke('watch_put', { watch: { sourceName: 'Watch smoke', rule: { id: 'smoke-watch', sessionKey: identity,
  fieldKey: 'temperature', condition: 'above', threshold: 50, enabled: true } } });

// Discovery puts the renderer stream back into startup buffering. No renderer
// drains it during the burst, and its 4 MiB cap must not govern the watch feed.
await invoke('list_active_sessions');
await post('/smoke/fixture', { temperatures: [99, 20], burst: 150000 });
await until(async () => (await stat(session.logPath)).size > 6 * 1024 * 1024);
await until(async () => (await invoke('watch_history_summary')).count === historyBefore.count + 1);
const pending = await invoke('take_pending_serial_data', { sessionId: session.id });
assert(pending.droppedEventCount > 0, 'The renderer buffer did not overflow; this would not exercise the missing-feed regression.');
const raw = await readFile(session.logPath, 'utf8');
assert(raw.includes('"temperature": 99.0'), 'The brief breach was not captured.');
const historyAfter = await invoke('watch_history_summary');
const [breach] = await invoke('watch_history_page', { after: historyBefore.through, through: historyAfter.through, limit: 256 });
assert.equal(breach.event.value, 99); assert.equal(breach.event.capturePath, session.logPath);
await invoke('send_serial_text', { sessionId: session.id, text: 'WATCH-SMOKE-SEND\n' });
await until(async () => (await (await fetch(`${origin}/smoke/state`)).json()).received.some((entry) =>
  entry.receivedHex && Buffer.from(entry.receivedHex, 'hex').toString().includes('WATCH-SMOKE-SEND')));
console.log(JSON.stringify({ verified: 'Breach recorded once with no renderer, overflowing UI buffer, intact capture and command sending',
  droppedDisplayEvents: pending.droppedEventCount, capturedBytes: raw.length, artifacts: fixture.data, sessionId: session.id }));
// Retain the fixture and armed watch for browser reattachment/reload checks.
