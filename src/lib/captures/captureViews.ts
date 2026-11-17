import { parseCaptureTags } from './captureOrganization';

export type CaptureViewFilters = {
  query: string;
  fullSearch: boolean;
  state: 'all' | 'active' | 'completed' | 'attention';
  sort: 'newest' | 'oldest' | 'largest' | 'name';
  favoritesOnly: boolean;
  tag: string;
  notebookQuery: string;
};
export type CaptureView = { id: string; name: string; filters: CaptureViewFilters };
type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'baudtide.capture-views.v1';
const LIMIT = 24;
// Search and notebook queries can expand sixfold when JSON-escaped.
const MAX_SERIALIZED_LENGTH = 1_000_000;
export class CaptureViewsReadError extends Error {}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function normalizeName(value: string) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Use a view name without control characters.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) throw new Error('Use a view name between 1 and 60 characters.');
  return name;
}

function validateFilters(value: unknown, stored = false): CaptureViewFilters {
  if (!object(value) || typeof value.query !== 'string' || value.query.length > 2000
    || typeof value.fullSearch !== 'boolean' || typeof value.favoritesOnly !== 'boolean'
    || !['all', 'active', 'completed', 'attention'].includes(value.state as string)
    || !['newest', 'oldest', 'largest', 'name'].includes(value.sort as string)
    || typeof value.notebookQuery !== 'string' || value.notebookQuery.length > 4000
    || typeof value.tag !== 'string' || value.tag.length > 24
    || (!stored && value.tag !== '' && (value.tag.includes(',') || parseCaptureTags(value.tag)[0] !== value.tag))) {
    throw new Error('These filters cannot be saved. Use a search of at most 2000 characters, a notebook search of at most 4000 characters, and a valid capture tag.');
  }
  return { query: value.query, fullSearch: value.fullSearch, state: value.state as CaptureViewFilters['state'], sort: value.sort as CaptureViewFilters['sort'], favoritesOnly: value.favoritesOnly, tag: value.tag, notebookQuery: value.notebookQuery };
}

export function loadCaptureViews(storage: Pick<Storage, 'getItem'> = localStorage): CaptureView[] {
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) return [];
    if (raw.length > MAX_SERIALIZED_LENGTH) throw new Error();
    const data: unknown = JSON.parse(raw);
    if (!object(data) || data.version !== 1 || !Array.isArray(data.views) || data.views.length > LIMIT) throw new Error();
    const ids = new Set<string>(); const names = new Set<string>();
    const reservedIds = new Set(data.views.filter(object).map(row => row.id));
    return data.views.map((row: unknown, index: number) => {
      if (!object(row) || typeof row.name !== 'string' || !object(row.filters)) throw new Error();
      const name = row.name;
      // The upstream format allowed longer names and repeated internal spaces.
      normalizeName(name);
      if (name !== name.trim() || name.length > 60 || names.has(name.toLowerCase())) throw new Error();
      let id = row.id;
      if (id === undefined) {
        if (typeof row.filters.favorites !== 'boolean') throw new Error();
        id = `legacy-${index}`;
        while (reservedIds.has(id) || ids.has(id as string)) id = `${id}-m`;
      }
      if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id) || ids.has(id)) throw new Error();
      ids.add(id); names.add(name.toLowerCase());
      const filters = { ...row.filters,
        favoritesOnly: row.filters.favoritesOnly === undefined ? row.filters.favorites : row.filters.favoritesOnly,
        notebookQuery: row.filters.notebookQuery === undefined ? '' : row.filters.notebookQuery };
      return { id, name, filters: validateFilters(filters, true) };
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
    && view.filters.favoritesOnly === filters.favoritesOnly && view.filters.tag === filters.tag
    && view.filters.notebookQuery === filters.notebookQuery;
}
