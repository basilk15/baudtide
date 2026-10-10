import { lineEndingText, type LineEnding } from './preferences';
export const MAX_SERIAL_WRITE_BYTES = 64 * 1024;
export const MAX_COMMAND_PRESETS = 24;
export type SerialCommand = { id: string; name: string; payload: string; mode: 'text' | 'hex'; lineEnding: LineEnding };

export function parseHexBytes(input: string): { bytes: number[] } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: 'Enter at least one byte, for example 48 65 6C 6C 6F.' };
  // Commas and whitespace may be freely combined around one separator, but a
  // comma can never stand in for a byte.
  const normalizedSeparators = trimmed.replace(/\s*,\s*/g, ',');
  if (normalizedSeparators.startsWith(',') || normalizedSeparators.endsWith(',') || normalizedSeparators.includes(',,')) {
    return { error: 'Use one comma or whitespace separator between each byte.' };
  }
  const tokens = trimmed.split(/[\s,]+/);
  if (tokens.length > MAX_SERIAL_WRITE_BYTES) {
    return { error: `Hex sends are limited to ${MAX_SERIAL_WRITE_BYTES.toLocaleString()} bytes.` };
  }
  const bytes: number[] = [];
  for (const token of tokens) {
    if (!/^(?:0x)?[\da-f]{2}$/i.test(token)) {
      return { error: `“${token}” is not a byte. Use two hex digits such as 7E or 0x7E.` };
    }
    bytes.push(Number.parseInt(token.replace(/^0x/i, ''), 16));
  }
  return { bytes };
}


export function commandBytes(command: Pick<SerialCommand, 'payload' | 'mode' | 'lineEnding'>): number[] {
  if (!command.payload.trim()) throw new Error('Enter a command before sending or saving.');
  if (command.mode === 'hex') {
    const parsed = parseHexBytes(command.payload);
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed.bytes;
  }
  const bytes = new TextEncoder().encode(command.payload + lineEndingText(command.lineEnding));
  if (bytes.length > MAX_SERIAL_WRITE_BYTES) throw new Error('Commands are limited to 65,536 bytes including the line ending.');
  return Array.from(bytes);
}

export function normalizeCommandPresets(value: unknown): SerialCommand[] | null {
  if (!Array.isArray(value) || value.length > MAX_COMMAND_PRESETS) return null;
  const seen = new Set<string>();
  const result: SerialCommand[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const c = entry as SerialCommand;
    if (typeof c.id !== 'string' || !c.id || c.id.length > 160 || seen.has(c.id)
      || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80
      || typeof c.payload !== 'string' || c.payload.length > MAX_SERIAL_WRITE_BYTES * 5
      || !['text', 'hex'].includes(c.mode) || !['lf', 'crlf', 'cr', 'none'].includes(c.lineEnding)) return null;
    try { commandBytes(c); } catch { return null; }
    seen.add(c.id);
    result.push({ id: c.id, name: c.name.trim(), payload: c.payload, mode: c.mode, lineEnding: c.lineEnding });
  }
  return result;
}

const storageKey = (identity: string) => `baudtide.command-presets.v1.${identity}`;
export function loadCommandPresets(identity: string): SerialCommand[] {
  const raw = window.localStorage.getItem(storageKey(identity));
  if (raw === null) return [];
  const parsed = normalizeCommandPresets(JSON.parse(raw));
  if (!parsed) throw new Error('Saved command presets could not be read.');
  return parsed;
}
export function saveCommandPresets(identity: string, presets: SerialCommand[]) {
  const normalized = normalizeCommandPresets(presets);
  if (!normalized) throw new Error('Invalid command presets.');
  window.localStorage.setItem(storageKey(identity), JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent('baudtide:command-presets', { detail: identity }));
}

/** Serializes writes; Stop invalidates pending timers without restarting after a late write. */
export class CommandRepeater {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  stop() { this.generation += 1; clearTimeout(this.timer); this.timer = undefined; }
  start(send: () => Promise<void>, intervalMs: number, onError: (error: unknown) => void) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 3_600_000) throw new Error('Repeat interval must be between 0.1 and 3,600 seconds.');
    this.stop();
    const generation = this.generation;
    const tick = async () => {
      if (generation !== this.generation) return;
      try { await send(); }
      catch (error) { if (generation === this.generation) { this.stop(); onError(error); } return; }
      if (generation === this.generation) this.timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();
  }
}
