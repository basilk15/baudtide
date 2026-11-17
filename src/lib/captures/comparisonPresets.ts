import { normalizeCheckSet, type CheckBinding, type ComparisonCheckSet } from './comparisonChecks';

export type ComparisonCheckPreset = { id: string; name: string; checkSet: ComparisonCheckSet };
type PresetStorage = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'baudtide.comparison-presets.v1';
const MAX_PRESETS = 24;
// Allows the full library even when every valid field/check identity needs JSON escaping.
const MAX_SERIALIZED_LENGTH = 400_000;
export class ComparisonPresetReadError extends Error {}
const readMessage = 'Check presets could not be read. Existing data is preserved. Restore local storage, then retry.';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function storeOrDefault<T extends Pick<Storage, 'getItem'>>(storage?: T): T | Storage {
  try { return storage ?? localStorage; }
  catch { throw new ComparisonPresetReadError(readMessage); }
}

function normalizeName(value: string) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Use a preset name without control characters.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 48) throw new Error('Use a preset name between 1 and 48 characters.');
  return name;
}

export function loadComparisonPresets(storage?: Pick<Storage, 'getItem'>): ComparisonCheckPreset[] {
  try {
    const raw = storeOrDefault(storage).getItem(KEY);
    if (raw === null) return [];
    if (raw.length > MAX_SERIALIZED_LENGTH) throw new Error();
    const data: unknown = JSON.parse(raw);
    if (!object(data) || data.version !== 1 || !Array.isArray(data.presets) || data.presets.length > MAX_PRESETS) throw new Error();
    const ids = new Set<string>(), names = new Set<string>();
    return data.presets.map((row: unknown) => {
      if (!object(row) || typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(row.id) || typeof row.name !== 'string') throw new Error();
      const name = normalizeName(row.name), checkSet = normalizeCheckSet(row.checkSet);
      if (name !== row.name || !checkSet || ids.has(row.id) || names.has(name.toLowerCase())) throw new Error();
      ids.add(row.id); names.add(name.toLowerCase());
      return { id: row.id, name, checkSet };
    });
  } catch { throw new ComparisonPresetReadError(readMessage); }
}

function write(presets: ComparisonCheckPreset[], storage: PresetStorage) {
  const raw = JSON.stringify({ version: 1, presets });
  if (raw.length > MAX_SERIALIZED_LENGTH) throw new Error('These presets are too large to save. Shorten signal names and try again.');
  try { storage.setItem(KEY, raw); }
  catch { throw new Error('Check presets could not be saved. Free local storage and try again.'); }
  return presets;
}

export function saveComparisonPreset(name: string, value: ComparisonCheckSet, storage?: PresetStorage): ComparisonCheckPreset[] {
  const normalized = normalizeName(name), checkSet = normalizeCheckSet(value);
  if (!checkSet) throw new Error('Save one to eight valid acceptance checks.');
  const store = storeOrDefault(storage), presets = loadComparisonPresets(store);
  if (presets.some(preset => preset.name.toLowerCase() === normalized.toLowerCase())) throw new Error('A preset with that name already exists. Choose another name.');
  if (presets.length >= MAX_PRESETS) throw new Error('You can save up to 24 presets. Remove an unused preset first.');
  return write([...presets, { id: crypto.randomUUID(), name: normalized, checkSet }], store);
}

export function removeComparisonPreset(id: string, storage?: PresetStorage): ComparisonCheckPreset[] {
  const store = storeOrDefault(storage);
  return write(loadComparisonPresets(store).filter(preset => preset.id !== id), store);
}

/** Copies definitions only; the caller reviews replacement and evaluates the new set normally. */
export function instantiateComparisonPreset(preset: ComparisonCheckPreset, binding: CheckBinding, createId: () => string = () => crypto.randomUUID()): ComparisonCheckSet {
  const saved = normalizeCheckSet(preset.checkSet), current = normalizeCheckSet({ binding, checks: saved?.checks });
  if (!saved || !current) throw new Error('Choose valid comparison signals and a valid preset.');
  if (saved.binding.unit !== current.binding.unit) throw new Error('Preset and selected signal units must match exactly. Numeric limits are not converted.');
  const checks = saved.checks.map(check => ({ ...check, id: createId() }));
  const result = normalizeCheckSet({ binding: current.binding, checks });
  if (!result || checks.some(check => saved.checks.some(previous => previous.id === check.id))) throw new Error('Independent checks could not be created. Try again.');
  return result;
}
