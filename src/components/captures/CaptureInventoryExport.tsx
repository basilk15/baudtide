import { useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { SavedLog } from '../../lib/serial/serial';
import type { CaptureNotebooks } from '../../lib/captures/captureNotebook';
import type { CaptureOrganizationLibrary } from '../../lib/captures/captureOrganization';
import { captureInventoryCsv } from '../../lib/captures/captureInventory';
type Props={logs:readonly SavedLog[];notebooks:CaptureNotebooks;organization:CaptureOrganizationLibrary;disabled:boolean;onExport:()=>void};
export function CaptureInventoryExport({logs,notebooks,organization,disabled,onExport}:Props) {
  const [review,setReview]=useState(false);const [error,setError]=useState('');
  const trigger=useRef<HTMLButtonElement>(null);
  const close=()=>{setReview(false);trigger.current?.focus();};
  return <section className="bt-library-tools" aria-label="Capture inventory export">
    <button ref={trigger} type="button" className="sd-secondary-button" disabled={disabled || !logs.length} aria-expanded={review} onClick={()=>{setReview(!review);setError('');}}><Download size={15} />Export inventory · {logs.length}</button>
    <p>CSV of the current filtered library, in the displayed order.</p>
    {review && <div className="bt-library-form" onKeyDown={event=>{if(event.key==='Escape')close();}}>
      <strong>Export {logs.length} capture{logs.length===1?'':'s'}?</strong><p>Includes experiment titles, notes, tags, favorites, filenames, dates, connection baud rate, state, and byte counts. Review your notes before sharing. Raw serial output and filesystem paths are excluded.</p>
      {error && <p role="alert">{error}</p>}
      <div><button type="button" className="sd-primary-button" disabled={disabled || !logs.length} onClick={()=>{
        let url='';
        try {
          url=URL.createObjectURL(new Blob(['\uFEFF',captureInventoryCsv(logs,notebooks,organization)],{type:'text/csv;charset=utf-8'}));
          const link=document.createElement('a');link.href=url;link.download='baudtide-capture-inventory.csv';document.body.append(link);link.click();link.remove();
          const downloadUrl=url;window.setTimeout(()=>URL.revokeObjectURL(downloadUrl),1000);
          onExport();close();
        } catch {if(url)URL.revokeObjectURL(url);setError('Inventory could not be exported. Try again.');}
      }}>Download CSV</button><button type="button" className="sd-secondary-button" onClick={close}>Cancel</button></div>
    </div>}
  </section>;
}
