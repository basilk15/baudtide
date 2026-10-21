import { parentPort, workerData } from 'node:worker_threads';
import { WatchJournal } from './watch-journal.mjs';
import { DesktopWatchRuntime, DesktopLogRuntime } from './watch-runtime/core.mjs';
import { BenchJournal } from './bench-journal.mjs';

const journal = new WatchJournal(workerData.directory);
const runtime = new DesktopWatchRuntime(journal.rules(), (rules) => journal.saveRules(rules),
  (row) => journal.append(row), (event) => parentPort.postMessage({ event: 'watch-event', payload: event }));
let benchJournal;
let logs;
let logError = '';
try {
  benchJournal = new BenchJournal(workerData.directory);
  logs = new DesktopLogRuntime(benchJournal.rules(), (rules) => benchJournal.saveRules(rules),
    (event) => benchJournal.append(event), (event) => parentPort.postMessage({ event: 'log-event', payload: event }));
} catch (error) { logError = `Log monitoring is unavailable: ${error.message}`; }
const logSnapshot = () => logs?.snapshot() ?? { rules: [], error: logError, interruption: '' };
if (workerData.restarted) runtime.gap(undefined, 'Watch monitoring restarted after an interruption. Raw capture continued; sustained conditions need fresh evidence.');
if (workerData.restarted) logs?.gap();
const snapshot = () => ({ ...runtime.snapshot(), historyCount: journal.summary().count });
const timer = setInterval(() => {
  parentPort.postMessage({ event: 'watch-state', payload: snapshot() });
  parentPort.postMessage({ event: 'log-state', payload: logSnapshot() });
}, 500);
parentPort.on('message', (message) => {
  if (message.kind === 'feed') {
    try { runtime.feed(message.payload); }
    catch { runtime.gap(undefined, 'Watch monitoring interrupted by an invalid serial event. Raw capture continues.'); }
    try { logs?.feed(message.payload); }
    catch { logs?.gap(); }
    parentPort.postMessage({ ack: message.bytes });
    return;
  }
  if (message.kind === 'status') { runtime.status(message.payload); logs?.status(message.payload); return; }
  if (message.kind === 'gap') { runtime.gap(); logs?.gap(); return; }
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
      case 'log_rules_snapshot': result = logSnapshot(); break;
      case 'log_rule_put': if (!logs) throw new Error(logError); result = logs.put(args.rule); break;
      case 'bench_events_list': if (!benchJournal) throw new Error(logError); result = benchJournal.list(args); break;
      case 'bench_event_append':
        if (!benchJournal) throw new Error(logError);
        if (args.event?.kind !== 'command') throw new Error('Only command results can be appended from the application.');
        result = benchJournal.append(args.event);
        parentPort.postMessage({ event: 'bench-event', payload: result }); break;
      case 'close': clearInterval(timer); runtime.dispose(); journal.close(); benchJournal?.close(); result = true; break;
      default: throw new Error('Unsupported watch command.');
    }
    parentPort.postMessage({ id: message.id, result });
    if (message.command === 'close') parentPort.close();
    else parentPort.postMessage({ event: 'watch-state', payload: snapshot() });
    if (message.command === 'log_rule_put') parentPort.postMessage({ event: 'log-state', payload: logSnapshot() });
  } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
});
parentPort.postMessage({ ready: true, snapshot: snapshot() });
