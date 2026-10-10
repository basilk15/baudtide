/** Main-process ownership survives a renderer disappearing without running finally. */
export class CaptureAnalysisReaders {
  #readers = new Map();
  #opening = new Set();
  #generation = 0;
  #cleanup = null;

  constructor(invoke) { this.invoke = invoke; }

  open(args) {
    const generation = this.#generation;
    const opening = (async () => {
      if (this.#cleanup) await this.#cleanup;
      if (generation !== this.#generation) throw new Error('The capture load was interrupted. Reopen the capture.');
      const handle = await this.invoke('open_capture_analysis', args);
      this.#readers.set(handle.id, { closing: null });
      // A native open can finish after navigation/crash cleanup has begun.
      if (generation !== this.#generation) {
        await this.close({ id: handle.id });
        throw new Error('The capture load was interrupted. Reopen the capture.');
      }
      return handle;
    })();
    this.#opening.add(opening);
    opening.then(() => this.#opening.delete(opening), () => this.#opening.delete(opening));
    return opening;
  }

  async read(args) {
    const reader = this.#readers.get(args.id);
    if (!reader || reader.closing) throw new Error('That capture load is no longer open.');
    const generation = this.#generation;
    const chunk = await this.invoke('read_capture_analysis_chunk', args);
    if (generation !== this.#generation) throw new Error('The capture load was interrupted. Reopen the capture.');
    return chunk;
  }

  close(args) {
    const reader = this.#readers.get(args.id);
    if (!reader) return Promise.resolve();
    if (reader.closing) return reader.closing;
    reader.closing = this.invoke('close_capture_analysis', { id: args.id }).then(() => {
      this.#readers.delete(args.id);
    }, (error) => {
      reader.closing = null;
      throw error;
    });
    return reader.closing;
  }

  dispose() {
    this.#generation += 1;
    if (this.#cleanup) return this.#cleanup;
    const opening = [...this.#opening];
    const cleanup = (async () => {
      // Late opens close themselves before their promises settle. New-renderer
      // opens wait for cleanup, so stale readers cannot consume its four slots.
      await Promise.allSettled(opening);
      const closed = await Promise.allSettled([...this.#readers.keys()].map((id) => this.close({ id })));
      const failed = closed.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    this.#cleanup = cleanup;
    const settled = () => { if (this.#cleanup === cleanup) this.#cleanup = null; };
    cleanup.then(settled, settled);
    return cleanup;
  }
}
