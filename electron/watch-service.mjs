import { Worker } from 'node:worker_threads';

export const watchCommands = Object.freeze(['watch_snapshot', 'watch_put', 'watch_remove', 'watch_decoder',
  'watch_history_import', 'watch_history_summary', 'watch_history_latest', 'watch_history_page',
  'log_rules_snapshot', 'log_rule_put', 'bench_events_list', 'bench_event_append']);

/** Owns the worker for the application lifetime, including renderer reloads. */
export class DesktopWatchService {
  constructor(directory, onEvent = () => {}, { maxFeedBytes = 8 * 1024 * 1024 } = {}) {
    this.directory = directory; this.onEvent = onEvent; this.maxFeedBytes = maxFeedBytes;
    this.worker = null; this.starting = null; this.pending = new Map(); this.nextId = 1;
    this.feedBytes = 0; this.gapQueued = false; this.stopping = false; this.starts = 0;
  }
  start() {
    if (this.starting) return this.starting;
    if (this.stopping) return Promise.reject(new Error('Watch monitoring is shutting down.'));
    const worker = new Worker(new URL('./watch-worker.mjs', import.meta.url), { workerData: { directory: this.directory, restarted: this.starts++ > 0 } });
    this.worker = worker;
    this.starting = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { fail(new Error('Watch monitoring did not start.')); void worker.terminate(); }, 10000);
      const fail = (error) => {
        clearTimeout(timeout);
        if (this.worker !== worker) return;
        this.worker = null; this.starting = null; this.feedBytes = 0; this.gapQueued = false;
        for (const request of this.pending.values()) { clearTimeout(request.timeout); request.reject(error); }
        this.pending.clear(); reject(error);
        if (!this.stopping) {
          this.onEvent('watch-state', { unavailable: true, interruption: 'Watch monitoring stopped. Raw capture continues. Retry monitoring to resume.', historyError: error.message });
          this.onEvent('log-state', { rules: [], error: 'Log monitoring stopped. Raw capture continues. Retry monitoring to resume.', interruption: error.message });
        }
      };
      worker.on('error', fail);
      worker.on('exit', (code) => { if (!this.stopping) fail(new Error(`Watch monitor exited (${code}).`)); });
      worker.on('message', (message) => {
        if (this.worker !== worker) return;
        if (message.ready) { clearTimeout(timeout); resolve(message.snapshot); this.onEvent('watch-state', message.snapshot); return; }
        if (message.ack !== undefined) { this.feedBytes = Math.max(0, this.feedBytes - message.ack); if (!this.feedBytes) this.gapQueued = false; return; }
        if (message.event) { this.onEvent(message.event, message.payload); return; }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timeout);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
      });
    });
    return this.starting;
  }
  async invoke(command, args = {}) {
    if (!watchCommands.includes(command) && command !== 'close') throw new Error('Unsupported watch command.');
    await this.start();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('Watch monitor did not respond.')); }, 10000);
      this.pending.set(id, { resolve, reject, timeout });
      this.worker.postMessage({ id, command, args });
    });
  }
  feed(payload) {
    if (!this.worker || this.stopping) return;
    const bytes = payload.data.bytes.length;
    if (this.feedBytes + bytes > this.maxFeedBytes) {
      if (!this.gapQueued) { this.gapQueued = true; this.worker.postMessage({ kind: 'gap' }); }
      return;
    }
    this.feedBytes += bytes;
    this.worker.postMessage({ kind: 'feed', payload, bytes });
  }
  status(payload) { this.worker?.postMessage({ kind: 'status', payload }); }
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    try { if (this.worker) await this.invoke('close'); }
    finally { if (this.worker) await this.worker.terminate(); this.worker = null; }
  }
}
