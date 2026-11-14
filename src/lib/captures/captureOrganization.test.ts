import { describe, expect, it } from 'vitest';
import { loadCaptureOrganization, parseCaptureTags, setCaptureFavorite, setCaptureTags, removeCaptureOrganization } from './captureOrganization';
const key = 'baudtide.capture-organization.v1';
function memory(initial: string | null = null) { const data = new Map<string, string>(); if (initial !== null) data.set(key, initial); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } }; }
describe('capture organization', () => {
  it('normalizes and deduplicates tags, and persists favorites independently', () => {
    const storage = memory();
    expect(parseCaptureTags(' Firmware A, firmware a,  bench   2, ')).toEqual(['firmware a', 'bench 2']);
    setCaptureTags('/a.log', 'Firmware A, bench 2', storage);
    setCaptureFavorite('/a.log', true, storage);
    setCaptureTags('/b.log', 'baseline', storage);
    setCaptureTags('/a.log', 'candidate', storage);
    expect(loadCaptureOrganization(storage)).toMatchObject({ '/a.log': { favorite: true, tags: ['candidate'] }, '/b.log': { favorite: false, tags: ['baseline'] } });
    setCaptureFavorite('/a.log', false, storage);
    expect(loadCaptureOrganization(storage)['/a.log'].tags).toEqual(['candidate']);
    removeCaptureOrganization('/a.log', storage);
    expect(loadCaptureOrganization(storage)['/a.log']).toBeUndefined();
    expect(loadCaptureOrganization(storage)['/b.log'].tags).toEqual(['baseline']);
  });
  it('rejects invalid input instead of truncating it', () => {
    for (const tags of ['x'.repeat(25), 'bad\nlabel', Array.from({ length: 9 }, (_, i) => `tag${i}`).join(',')]) expect(() => parseCaptureTags(tags)).toThrow();
    const storage = memory(); setCaptureTags('/a.log', '', storage);
    expect(Object.keys(loadCaptureOrganization(storage))).toHaveLength(0);
  });
  it('preserves damaged and unsupported libraries without writing', () => {
    for (const value of ['{bad', '{"version":9,"entries":{}}', '{"version":1,"entries":{"/a":{"favorite":true,"tags":[3]}}}']) {
      const storage = memory(value);
      expect(() => setCaptureFavorite('/new.log', true, storage)).toThrow('preserved');
      expect(storage.getItem(key)).toBe(value);
    }
  });
  it('does not report a successful write when storage is full', () => {
    const storage = memory(); setCaptureTags('/a.log', 'baseline', storage);
    const before = storage.getItem(key);
    expect(() => setCaptureFavorite('/a.log', true, { getItem: storage.getItem, setItem: () => { throw new Error('full'); } })).toThrow('could not be saved');
    expect(storage.getItem(key)).toBe(before);
  });
  it('treats unusual path keys as data and preserves edits made since an earlier read', () => {
    const storage = memory(); loadCaptureOrganization(storage);
    setCaptureFavorite('__proto__', true, storage); setCaptureTags('__proto__', 'safe', storage);
    expect(loadCaptureOrganization(storage)['__proto__']).toEqual({ favorite: true, tags: ['safe'] });
  });
  it('bounds new entries without blocking updates to existing ones', () => {
    const entries = Object.fromEntries(Array.from({length:10000},(_,i)=>[`/${i}.log`,{favorite:true,tags:[]}]));
    const storage=memory(JSON.stringify({version:1,entries}));
    expect(()=>setCaptureFavorite('/extra.log',true,storage)).toThrow('full');
    setCaptureTags('/0.log','baseline',storage);
    expect(loadCaptureOrganization(storage)['/0.log'].tags).toEqual(['baseline']);
  });
});
