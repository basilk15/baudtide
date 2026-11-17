import type { SavedLog } from '../serial/serial';
import type { CaptureNotebooks } from './captureNotebook';
import type { CaptureOrganizationLibrary } from './captureOrganization';
function cell(value: unknown) {
  let text=String(value ?? '');
  // Keep spreadsheet applications from evaluating user/device text as formulas.
  if (/^[\s]*[=+\-@]/u.test(text)) text="'"+text;
  return /[",\r\n]/u.test(text) ? '"'+text.replace(/"/gu,'""')+'"' : text;
}
/** Export exactly the provided order; deliberately excludes filesystem paths and raw bytes. */
export function captureInventoryCsv(logs: readonly SavedLog[], notebooks: CaptureNotebooks, organization: CaptureOrganizationLibrary) {
  const header=['experiment_title','capture_name','file_name','state','started_at','ended_at','modified_at','size_bytes','baud_rate','favorite','tags','notes'];
  return [header.join(','),...logs.map(log=>[
    notebooks[log.path]?.title ?? '',log.sessionName,log.fileName,log.state,log.startedAt,log.endedAt,log.modifiedAt,log.sizeBytes,log.baudRate,
    organization[log.path]?.favorite ? 'true':'false',organization[log.path]?.tags.join('; ') ?? '',notebooks[log.path]?.notes ?? '',
  ].map(cell).join(','))].join('\r\n')+'\r\n';
}
