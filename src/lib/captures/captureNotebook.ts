export type CaptureNotebook = { title: string; notes: string };
export type CaptureNotebooks = Record<string, CaptureNotebook>;
type NotebookStorage = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'baudtide.capture-notebooks.v1';
function validate(value: CaptureNotebook) {
  if (typeof value.title !== 'string' || typeof value.notes !== 'string' || value.title.length > 80 || value.notes.length > 4000
    || /[\x00-\x1f\x7f]/.test(value.title) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.notes)) throw Error('Use a title up to 80 characters and notes up to 4000 characters, without control characters.');
}
export function loadCaptureNotebooks(storage: Pick<Storage, 'getItem'> = localStorage): CaptureNotebooks {
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) return Object.create(null);
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries) || Object.keys(parsed.entries).length > 10000) throw Error();
    const result: CaptureNotebooks = Object.create(null);
    for (const [path, entry] of Object.entries(parsed.entries)) {
      if (!path || path.length > 4096 || path.includes('\0') || !entry || typeof entry !== 'object') throw Error();
      validate(entry as CaptureNotebook);
      result[path] = { title: (entry as CaptureNotebook).title, notes: (entry as CaptureNotebook).notes };
    }
    return result;
  } catch { throw Error('Capture notebooks could not be read. Existing data is preserved. Restore local storage, then retry.'); }
}
export function saveCaptureNotebook(path: string, value: CaptureNotebook | null, storage: NotebookStorage = localStorage) {
  if (!path || path.length > 4096 || path.includes('\0')) throw Error('Invalid capture path.');
  if (value) validate(value);
  const library = loadCaptureNotebooks(storage);
  if (value && (value.title.trim() || value.notes.trim())) library[path] = { title: value.title.trim(), notes: value.notes.trim() };
  else delete library[path];
  if (Object.keys(library).length > 10000) throw Error('The notebook library is full.');
  try { storage.setItem(KEY, JSON.stringify({version: 1, entries: library})); }
  catch { throw Error('Capture notebook could not be saved. Free local storage and try again.'); }
  return library;
}
export function removeCaptureNotebook(path: string, storage: NotebookStorage = localStorage) { return saveCaptureNotebook(path, null, storage); }
