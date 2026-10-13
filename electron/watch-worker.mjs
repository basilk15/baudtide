import { parentPort, workerData } from 'node:worker_threads';
import { WatchJournal } from './watch-journal.mjs';
import { DesktopWatchRuntime } from './watch-runtime/core.mjs';

const journal = new WatchJournal(workerData.directory);
const runtime = new DesktopWatchRuntime(journal.rules(), (rules) => journal.saveRules(rules),
  (row) => journal.append(row), (event) => parentPort.postMessage({ event: 'watch-event', payload: event }));
if (workerData.restarted) runtime.gap(undefined, 'Watch monitoring restarted after an interruption. Raw capture continued; sustained conditions need fresh evidence.');
const snapshot = () => ({ ...runtime.snapshot(), historyCount: journal.summary().count });
const timer = setInterval(() => parentPort.postMessage({ event: 'watch-state', payload: snapshot() }), 500);
parentPort.on('message', (message) => {
  if (message.kind === 'feed') {
    try { runtime.feed(message.payload); }
    catch { runtime.gap(undefined, 'Watch monitoring interrupted by an invalid serial event. Raw capture continues.'); }
    finally { parentPort.postMessage({ ack: message.bytes }); }
    return;
  }
  if (message.kind === 'status') { runtime.status(message.payload); return; }
  if (message.kind === 'gap') { runtime.gap(); return; }
  try {
    const args = message.args ?? {};
    let result;
    switch (message.command) {
      case 'watch_snapshot': result = snapshot(); break;
      case 'watch_put': result = runtime.put(args.watch); break;
      case 'watch_remove': result = runtime.remove(args.ids); break;
      case 'watch_decoder': result = runtime.decoder(args.identity, args.decoder); break;
      case 'watch_history_import': result = journal.import(args.events); break;
      case 'watch_history_summary': result = journal.summary(); break;
      case 'watch_history_latest': result = journal.latest(args.limit); break;
      case 'watch_history_page': result = journal.page(args.after, args.through, args.limit); break;
      case 'close': clearInterval(timer); runtime.dispose(); journal.close(); result = true; break;
      default: throw new Error('Unsupported watch command.');
    }
    parentPort.postMessage({ id: message.id, result });
    if (message.command === 'close') parentPort.close();
    else parentPort.postMessage({ event: 'watch-state', payload: snapshot() });
  } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
});
parentPort.postMessage({ ready: true, snapshot: snapshot() });
