import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

async function canonicalDestination(filename) {
  return path.join(await fs.realpath(path.dirname(filename)), path.basename(filename));
}

/** Protect managed data even when an export folder is reached through a symlink. */
export async function assertExportDestinationSafe(destination, { directories = [], files = [] } = {}) {
  const target = await canonicalDestination(destination);
  for (const directory of directories) {
    const root = await fs.realpath(directory).catch((error) => {
      if (error.code === 'ENOENT') return path.resolve(directory);
      throw error;
    });
    const relative = path.relative(root, target);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Choose an export location outside BaudTide’s managed application data.');
    }
  }
  for (const filename of files) {
    if (target === await canonicalDestination(filename)) throw new Error('An export cannot replace a raw capture or its receive timing. Choose another filename.');
  }
}

/** Each export owns a temporary sibling. Publishing never truncates the destination. */
export class TelemetryExportStreams {
  #streams = new Map();
  #starting = 0;
  #generation = 0;
  #disposal = null;
  constructor(validateDestination = async () => {}) { this.validateDestination = validateDestination; }
  async beginWithDestination(chooseDestination) {
    // The save dialog belongs to the renderer that requested it, even before
    // a destination exists and begin() can reserve an export stream.
    const generation = this.#generation;
    const destination = await chooseDestination();
    if (generation !== this.#generation) throw new Error('The export was interrupted while choosing a destination.');
    return destination ? this.begin(destination) : null;
  }
  async begin(destination) {
    if (this.#disposal) throw new Error('Export cleanup is in progress. Try again in a moment.');
    const generation = this.#generation;
    if (this.#streams.size + this.#starting >= 4) throw new Error('Finish the current telemetry export before starting another.');
    this.#starting += 1;
    try {
      await this.validateDestination(destination);
      if (generation !== this.#generation) throw new Error('The export was interrupted before opening.');
      const id = randomUUID();
      const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.baudtide-${id}.tmp`);
      const file = await fs.open(temporary, 'wx', 0o600);
      this.#streams.set(id, { destination, temporary, file, generation, tail: Promise.resolve(), closing: false });
      if (generation !== this.#generation) { await this.cancel(id); throw new Error('The export was interrupted while opening.'); }
      return id;
    } finally { this.#starting -= 1; }
  }
  #get(id) {
    const stream = this.#streams.get(id);
    if (!stream || stream.closing) throw new Error('That telemetry export is unavailable or busy.');
    return stream;
  }
  #enqueue(stream, operation) {
    const result = stream.tail.then(operation);
    stream.tail = result.catch(() => undefined);
    return result;
  }
  async append(id, contents) {
    if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > 256 * 1024) throw new Error('Export chunks must contain at most 256 KB of text.');
    const stream = this.#get(id);
    return this.#enqueue(stream, () => stream.file.writeFile(contents, 'utf8'));
  }
  async finish(id) {
    const stream = this.#get(id);
    if (stream.generation !== this.#generation) throw new Error('The export was interrupted before publication.');
    stream.closing = true;
    try {
      return await this.#enqueue(stream, async () => {
        await stream.file.sync(); await stream.file.close();
        await this.validateDestination(stream.destination);
        // Cleanup can begin while sync, close, or destination validation waits.
        // Only the renderer that opened this stream may publish its result.
        if (stream.generation !== this.#generation) throw new Error('The export was interrupted before publication.');
        await fs.rename(stream.temporary, stream.destination);
        this.#streams.delete(id);
        return stream.destination;
      });
    } catch (error) { stream.closing = false; throw error; }
  }
  async cancel(id) {
    const stream = this.#get(id); stream.closing = true;
    try {
      await this.#enqueue(stream, async () => {
        await stream.file.close(); await fs.unlink(stream.temporary); this.#streams.delete(id);
      });
    } catch (error) { stream.closing = false; throw error; }
  }
  dispose() {
    this.#generation += 1;
    if (this.#disposal) return this.#disposal;
    const streams = [...this.#streams];
    const disposal = (async () => {
      for (const [id, stream] of streams) {
        await stream.tail;
        if (this.#streams.has(id)) await this.cancel(id).catch(() => undefined);
      }
    })();
    this.#disposal = disposal;
    void disposal.finally(() => { if (this.#disposal === disposal) this.#disposal = null; });
    return disposal;
  }
}
