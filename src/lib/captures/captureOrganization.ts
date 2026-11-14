export type CaptureOrganization = { favorite: boolean; tags: string[] };
export type CaptureOrganizationLibrary = Record<string, CaptureOrganization>;
type OrganizationStorage = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'baudtide.capture-organization.v1';
const MAX_ENTRIES = 10000;
export class CaptureOrganizationReadError extends Error {}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function parseCaptureTags(text: string): string[] {
  if (text.length > 2000 || /[\x00-\x1f\x7f]/.test(text)) throw new Error('Tags cannot contain control characters.');
  const tags = [...new Set(text.split(',').map(tag => tag.trim().replace(/\s+/g, ' ').toLowerCase()).filter(Boolean))];
  if (tags.length > 8) throw new Error('Use up to 8 tags per capture.');
  if (tags.some(tag => tag.length > 24)) throw new Error('Each tag must be 24 characters or fewer.');
  return tags;
}

export function loadCaptureOrganization(storage: Pick<Storage, 'getItem'> = localStorage): CaptureOrganizationLibrary {
  try {
    const raw = storage.getItem(KEY);
    const result: CaptureOrganizationLibrary = Object.create(null);
    if (raw === null) return result;
    const parsed: unknown = JSON.parse(raw);
    if (!object(parsed) || parsed.version !== 1 || !object(parsed.entries) || Object.keys(parsed.entries).length > MAX_ENTRIES) throw new Error();
    for (const [path, value] of Object.entries(parsed.entries)) {
      if (!path || path.length > 4096 || path.includes('\0') || !object(value) || typeof value.favorite !== 'boolean' || !Array.isArray(value.tags)
        || value.tags.some(tag => typeof tag !== 'string' || !tag || tag.includes(','))) throw new Error();
      const tags = parseCaptureTags(value.tags.join(','));
      if (JSON.stringify(tags) !== JSON.stringify(value.tags)) throw new Error();
      result[path] = { favorite: value.favorite, tags };
    }
    return result;
  } catch { throw new CaptureOrganizationReadError('Capture organization could not be read. Existing data is preserved. Retry after restoring local storage.'); }
}

function update(path: string, change: (current: CaptureOrganization) => CaptureOrganization | undefined, storage: OrganizationStorage) {
  if (!path || path.length > 4096 || path.includes('\0')) throw new Error('Invalid capture path.');
  const library = loadCaptureOrganization(storage);
  const next = change(library[path] ?? { favorite: false, tags: [] });
  if (!next || (!next.favorite && !next.tags.length)) delete library[path];
  else library[path] = next;
  if (Object.keys(library).length > MAX_ENTRIES) throw new Error('The capture organization library is full. Remove unused tags or favorites before adding more.');
  try { storage.setItem(KEY, JSON.stringify({ version: 1, entries: library })); }
  catch { throw new Error('Capture organization could not be saved. Free local storage and try again.'); }
  return library;
}

export function setCaptureFavorite(path: string, favorite: boolean, storage: OrganizationStorage = localStorage) {
  return update(path, current => ({ ...current, favorite }), storage);
}
export function setCaptureTags(path: string, text: string, storage: OrganizationStorage = localStorage) {
  const tags = parseCaptureTags(text);
  return update(path, current => ({ ...current, tags }), storage);
}
export function removeCaptureOrganization(path: string, storage: OrganizationStorage = localStorage) {
  return update(path, () => undefined, storage);
}
