import { expect, it } from 'vitest';
import { loadCaptureViews, saveCaptureView, deleteCaptureView, type CaptureViewFilters } from './captureViews';
const filters: CaptureViewFilters = {query:'panic',fullSearch:true,state:'attention',sort:'oldest',favorites:true,tag:'bench a',notebookQuery:'firmware v2'};
function memory() {const data=new Map<string,string>();return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);}};}
it('round trips every filter and explicitly deletes a saved view',()=>{
  const storage=memory(); saveCaptureView('Investigation',filters,storage);
  expect(loadCaptureViews(storage)).toEqual([{name:'Investigation',filters}]);
  expect(()=>saveCaptureView(' investigation ',filters,storage)).toThrow(/already exists/);
  deleteCaptureView('Investigation',storage); expect(loadCaptureViews(storage)).toEqual([]);
});
it('rejects invalid filters, full libraries and corrupt data without overwrite',()=>{
  const storage=memory();
  expect(()=>saveCaptureView('Run',{...filters,sort:'bad'} as unknown as CaptureViewFilters,storage)).toThrow();
  for(let i=0;i<20;i++) saveCaptureView('Run '+i,filters,storage);
  expect(()=>saveCaptureView('Too many',filters,storage)).toThrow(/20/);
  storage.setItem('baudtide.capture-views.v1','broken');
  expect(()=>saveCaptureView('Run',filters,storage)).toThrow(/preserved/);
  expect(storage.getItem('baudtide.capture-views.v1')).toBe('broken');
});
