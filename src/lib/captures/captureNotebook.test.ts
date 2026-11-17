import { describe, expect, it } from 'vitest';
import { loadCaptureNotebooks, saveCaptureNotebook, removeCaptureNotebook } from './captureNotebook';
function memory() { const data = new Map<string,string>(); return { getItem:(k:string)=>data.get(k) ?? null, setItem:(k:string,v:string)=>{data.set(k,v);} }; }
describe('capture notebooks', () => {
  it('persists trimmed titles and multiline notes without touching other captures', () => {
    const storage=memory();
    saveCaptureNotebook('/a',{title:'  Thermal run  ',notes:'Firmware v2\nAmbient 20°C'},storage);
    saveCaptureNotebook('/b',{title:'Baseline',notes:''},storage);
    expect(loadCaptureNotebooks(storage)['/a']).toEqual({title:'Thermal run',notes:'Firmware v2\nAmbient 20°C'});
    removeCaptureNotebook('/a',storage);
    expect(Object.keys(loadCaptureNotebooks(storage))).toEqual(['/b']);
  });
  it('validates limits and preserves corrupt storage', () => {
    const storage=memory();
    expect(()=>saveCaptureNotebook('/a',{title:'x'.repeat(81),notes:''},storage)).toThrow();
    storage.setItem('baudtide.capture-notebooks.v1','broken');
    expect(()=>saveCaptureNotebook('/a',{title:'Run',notes:''},storage)).toThrow(/preserved/);
    expect(storage.getItem('baudtide.capture-notebooks.v1')).toBe('broken');
  });
  it('surfaces write failures', () => {
    expect(()=>saveCaptureNotebook('/a',{title:'Run',notes:''},{getItem:()=>null,setItem:()=>{throw Error();}})).toThrow(/could not be saved/);
  });
});
