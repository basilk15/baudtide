import { parseCaptureTags } from './captureOrganization';

export type CaptureViewFilters = {
  query: string;
  fullSearch: boolean;
  state: 'all' | 'active' | 'completed' | 'attention';
  sort: 'newest' | 'oldest' | 'largest' | 'name';
  favoritesOnly: boolean;
  tag: string;
};
export type CaptureView = { id: string; name: string; filters: CaptureViewFilters };
type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'baudtide.capture-views.v1';
const LIMIT = 24;
// 24 maximum-length queries can expand to 288,000 characters when JSON-escaped.
const MAX_SERIALIZED_LENGTH = 400_000;
export class CaptureViewsReadError extends Error {}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function normalizeName(value: string) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Use a view name without control characters.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 48) throw new Error('Use a view name between 1 and 48 characters.');
  return name;
}

function validateFilters(value: unknown): CaptureViewFilters {
  if (!object(value) || typeof value.query !== 'string' || value.query.length > 2000
    || typeof value.fullSearch !== 'boolean' || typeof value.favoritesOnly !== 'boolean'
    || !['all', 'active', 'completed', 'attention'].includes(value.state as string)
    || !['newest', 'oldest', 'largest', 'name'].includes(value.sort as string)
    || typeof value.tag !== 'string' || (value.tag !== '' && (value.tag.includes(',') || parseCaptureTags(value.tag)[0] !== value.tag))) {
    throw new Error('These filters cannot be saved. Use a search of at most 2000 characters and a valid capture tag.');
  }
  return { query: value.query, fullSearch: value.fullSearch, state: value.state as CaptureViewFilters['state'], sort: value.sort as CaptureViewFilters['sort'], favoritesOnly: value.favoritesOnly, tag: value.tag };
}

export function loadCaptureViews(storage: Pick<Storage, 'getItem'> = localStorage): CaptureView[] {
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) return [];
    if (raw.length > MAX_SERIALIZED_LENGTH) throw new Error();
    const data: unknown = JSON.parse(raw);
    if (!object(data) || data.version !== 1 || !Array.isArray(data.views) || data.views.length > LIMIT) throw new Error();
    const ids = new Set<string>(); const names = new Set<string>();
    return data.views.map((row: unknown) => {
      if (!object(row) || typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(row.id) || typeof row.name !== 'string') throw new Error();
      const name = normalizeName(row.name);
      if (name !== row.name || ids.has(row.id) || names.has(name.toLowerCase())) throw new Error();
      ids.add(row.id); names.add(name.toLowerCase());
      return { id: row.id, name, filters: validateFilters(row.filters) };
    });
  } catch {
    throw new CaptureViewsReadError('Saved views could not be read. Existing data is preserved. Restore local storage, then retry.');
  }
}

function writeViews(views: CaptureView[], storage: ViewStorage) {
  const raw = JSON.stringify({ version: 1, views });
  if (raw.length > MAX_SERIALIZED_LENGTH) throw new Error('These saved views are too large. Shorten a search query and try again.');
  try { storage.setItem(KEY, raw); }
  catch { throw new Error('Saved views could not be saved. Free local storage and try again.'); }
  return views;
}

export function saveCaptureView(name: string, filters: CaptureViewFilters, storage: ViewStorage = localStorage): CaptureView[] {
  const normalized = normalizeName(name); const settings = validateFilters(filters);
  const views = loadCaptureViews(storage);
  if (views.some(view => view.name.toLowerCase() === normalized.toLowerCase())) throw new Error('A view with that name already exists. Choose another name.');
  if (views.length >= LIMIT) throw new Error('You can save up to 24 views. Remove an unused view first.');
  return writeViews([...views, { id: crypto.randomUUID(), name: normalized, filters: settings }], storage);
}

export function removeCaptureView(id: string, storage: ViewStorage = localStorage): CaptureView[] {
  return writeViews(loadCaptureViews(storage).filter(view => view.id !== id), storage);
}

export function captureViewMatches(view: CaptureView, filters: CaptureViewFilters) {
  return view.filters.query === filters.query && view.filters.fullSearch === filters.fullSearch
    && view.filters.state === filters.state && view.filters.sort === filters.sort
    && view.filters.favoritesOnly === filters.favoritesOnly && view.filters.tag === filters.tag;
}
