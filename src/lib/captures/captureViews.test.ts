import { describe, expect, it } from 'vitest';
import { captureViewMatches, CaptureViewsReadError, loadCaptureViews, removeCaptureView, saveCaptureView, type CaptureViewFilters } from './captureViews';

const key = 'baudtide.capture-views.v1';
const filters: CaptureViewFilters = { query: 'motor', fullSearch: true, state: 'completed', sort: 'oldest', favoritesOnly: true, tag: 'baseline' };
function memory(raw: string | null = null) {
  let value = raw;
  return { getItem: (k: string) => k === key ? value : null, setItem: (k: string, v: string) => { if (k === key) value = v; } };
}

describe('saved capture views', () => {
  it('round-trips all filters, normalizes names and returns independent snapshots', () => {
    const storage = memory();
    expect(loadCaptureViews(storage)).toEqual([]);
    const saved = saveCaptureView('  Motor   baseline  ', filters, storage);
    expect(saved[0]).toMatchObject({ name: 'Motor baseline', filters });
    expect(saved[0].id).toBeTruthy();
    saved[0].filters.query = 'changed in memory';
    expect(loadCaptureViews(storage)[0].filters.query).toBe('motor');
    expect(captureViewMatches(loadCaptureViews(storage)[0], filters)).toBe(true);
    for (const field of Object.keys(filters) as (keyof CaptureViewFilters)[]) {
      const changed = { ...filters, [field]: typeof filters[field] === 'boolean' ? !filters[field] : `${filters[field]} changed` };
      expect(captureViewMatches(loadCaptureViews(storage)[0], changed as CaptureViewFilters)).toBe(false);
    }
  });

  it('rejects duplicates and invalid names or filters without changing existing views', () => {
    const storage = memory(); saveCaptureView('Bench A', filters, storage); const before = storage.getItem(key);
    for (const name of ['', '  ', 'x'.repeat(49), 'bad\nname', ' bench a ']) expect(() => saveCaptureView(name, filters, storage)).toThrow();
    for (const change of [{ query: 'x'.repeat(2001) }, { state: 'unknown' }, { sort: 'size' }, { fullSearch: 1 }, { favoritesOnly: 'yes' }, { tag: 'Mixed Case' }, { tag: 'two,tags' }]) {
      expect(() => saveCaptureView('New view', { ...filters, ...change } as CaptureViewFilters, storage)).toThrow();
    }
    expect(storage.getItem(key)).toBe(before);
  });

  it('preserves damaged or unsupported data, including invalid rows and duplicate identities', () => {
    const row = { id: 'a', name: 'Bench A', filters };
    const bad = ['{broken', JSON.stringify({ version: 2, views: [] }), JSON.stringify({ version: 1, views: [null] }),
      JSON.stringify({ version: 1, views: [row, row] }), JSON.stringify({ version: 1, views: [row, { ...row, id: 'b', name: 'bench a' }] }),
      JSON.stringify({ version: 1, views: [{ ...row, filters: { ...filters, tag: 12 } }] }),
      JSON.stringify({ version: 1, views: [{ ...row, id: '' }] })];
    for (const raw of bad) {
      const storage = memory(raw);
      expect(() => loadCaptureViews(storage)).toThrow(CaptureViewsReadError);
      expect(() => saveCaptureView('New view', filters, storage)).toThrow('preserved');
      expect(() => removeCaptureView('a', storage)).toThrow('preserved');
      expect(storage.getItem(key)).toBe(raw);
    }
    expect(() => loadCaptureViews({ getItem: () => { throw new Error('denied'); } })).toThrow(CaptureViewsReadError);
  });

  it('bounds the library and removes only the requested view using the latest saved data', () => {
    const storage = memory();
    for (let i = 0; i < 24; i++) saveCaptureView(`View ${i}`, filters, storage);
    expect(() => saveCaptureView('Extra', filters, storage)).toThrow('24');
    const first = loadCaptureViews(storage)[0];
    const remaining = removeCaptureView(first.id, storage);
    expect(remaining).toHaveLength(23);
    expect(remaining.some(v => v.id === first.id)).toBe(false);
    expect(saveCaptureView('Replacement', filters, storage)).toHaveLength(24);
    expect(removeCaptureView('missing-id', storage)).toHaveLength(24);
  });

  it('reports quota/write errors and leaves existing data intact', () => {
    const storage = memory(); saveCaptureView('Baseline', filters, storage); const before = storage.getItem(key);
    const denied = { getItem: storage.getItem, setItem: () => { throw new Error('quota'); } };
    expect(() => saveCaptureView('Candidate', filters, denied)).toThrow('could not be saved');
    expect(() => removeCaptureView(loadCaptureViews(storage)[0].id, denied)).toThrow('could not be saved');
    expect(storage.getItem(key)).toBe(before);
  });

  it('reopens a full library whose valid queries expand when JSON-escaped', () => {
    const storage = memory();
    const escaped = { ...filters, query: '\u0001'.repeat(2000), tag: '"'.repeat(24) };
    for (let i = 0; i < 24; i++) saveCaptureView(`View ${i} ${'"'.repeat(38)}`, escaped, storage);
    const loaded = loadCaptureViews(storage);
    expect(loaded).toHaveLength(24);
    expect(loaded.every(view => view.filters.query === escaped.query)).toBe(true);
    expect(removeCaptureView(loaded[0].id, storage)).toHaveLength(23);
  });
});
