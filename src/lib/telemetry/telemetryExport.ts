export type TelemetryExportRow = {
  source: string; sourceType: 'live' | 'recorded'; originalTimestamp: string; alignedTimestamp: string;
  elapsedMs: number; field: string; value: number; unit: string; timing: 'live' | 'recorded' | 'approximate';
};

function csvCell(value: unknown) {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/** Bounded text chunks; CSV and JSON export the same complete sequence of rows. */
export async function* telemetryExportChunks(rows: AsyncIterable<TelemetryExportRow>, format: 'csv' | 'json', alignment: string) {
  let chunk = format === 'json'
    ? `{"alignment":${JSON.stringify(alignment)},"exportedAt":${JSON.stringify(new Date().toISOString())},"rows":[`
    : 'source,source_type,original_timestamp,aligned_timestamp,elapsed_ms,signal,value,unit,timing\n';
  let first = true;
  for await (const row of rows) {
    chunk += format === 'json' ? `${first ? '' : ','}${JSON.stringify(row)}`
      : [row.source, row.sourceType, row.originalTimestamp, row.alignedTimestamp, row.elapsedMs, row.field, row.value, row.unit, row.timing].map(csvCell).join(',') + '\n';
    first = false;
    if (chunk.length >= 32 * 1024) { yield chunk; chunk = ''; }
  }
  if (format === 'json') chunk += ']}';
  if (chunk) yield chunk;
}
