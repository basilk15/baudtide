export type CaptureViewFilters = { query: string; fullSearch: boolean; state: 'all'|'active'|'completed'|'attention'; sort: 'newest'|'oldest'|'largest'|'name'; favorites: boolean; tag: string; notebookQuery: string };
export type CaptureView = {name: string; filters: CaptureViewFilters};
type ViewStorage = Pick<Storage,'getItem'|'setItem'>;
const KEY='baudtide.capture-views.v1';
function validFilters(f: CaptureViewFilters) {
  return !!f && typeof f === 'object' && typeof f.query === 'string' && f.query.length <= 2000
    && typeof f.notebookQuery === 'string' && f.notebookQuery.length <= 4000 && typeof f.tag === 'string' && f.tag.length <= 24
    && typeof f.fullSearch === 'boolean' && typeof f.favorites === 'boolean'
    && ['all','active','completed','attention'].includes(f.state) && ['newest','oldest','largest','name'].includes(f.sort);
}
function validName(name: string) {return typeof name === 'string' && !!name.trim() && name.length <= 60 && !/[\x00-\x1f\x7f]/.test(name);}
export function loadCaptureViews(storage: Pick<Storage,'getItem'> = localStorage): CaptureView[] {
  try {
    const raw=storage.getItem(KEY); if(raw===null)return [];
    const data=JSON.parse(raw);
    if(data?.version!==1 || !Array.isArray(data.views) || data.views.length>20)throw Error();
    const names=new Set<string>();
    for(const view of data.views) {
      if(!view || !validName(view.name) || view.name!==view.name.trim() || !validFilters(view.filters) || names.has(view.name.toLowerCase()))throw Error();
      names.add(view.name.toLowerCase());
    }
    return data.views;
  } catch {throw Error('Saved views could not be read. Existing data is preserved. Restore local storage, then retry.');}
}
function write(views: CaptureView[], storage: ViewStorage) {
  try {storage.setItem(KEY,JSON.stringify({version:1,views}));}
  catch {throw Error('Saved views could not be saved. Free local storage and try again.');}
  return views;
}
export function saveCaptureView(name: string, filters: CaptureViewFilters, storage: ViewStorage = localStorage) {
  if(!validName(name) || !validFilters(filters))throw Error('Use a view name up to 60 characters and valid filters.');
  name=name.trim();
  const views=loadCaptureViews(storage);
  if(views.some(v=>v.name.toLowerCase()===name.toLowerCase()))throw Error('A view with this name already exists. Choose another name.');
  if(views.length>=20)throw Error('Keep up to 20 views. Remove an unused view first.');
  return write([...views,{name,filters:{...filters}}],storage);
}
export function deleteCaptureView(name: string, storage: ViewStorage = localStorage) {return write(loadCaptureViews(storage).filter(v=>v.name!==name),storage);}
