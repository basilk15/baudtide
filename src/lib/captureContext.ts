import { openNativeCaptureAnalysis, readNativeCaptureAnalysisChunk, closeNativeCaptureAnalysis, type SavedLog } from './serial';
import type { CaptureRange } from './captureAnalysis';

export type CaptureContextLine = { timestampMs: number; text: string; shortened: boolean };
export type CaptureContext = { lines: CaptureContextLine[]; matched: number; timingMode: 'recorded' | 'approximate' };
const MAX_LINE_LENGTH = 4096;
const MAX_LINES = 300;

/** Stream original bytes, including nonnumeric output, retaining only bounded context near the event. */
export async function readCaptureContext(log: SavedLog, range: CaptureRange, anchorMs: number, signal?: AbortSignal): Promise<CaptureContext> {
  signal?.throwIfAborted();
  const handle = await openNativeCaptureAnalysis(log.path);
  const decoder = new TextDecoder();
  let line = ''; let shortened = false; let previousCR = false; let lastTime = 0; let matched = 0;
  const lines: CaptureContextLine[] = [];
  const start = Date.parse(log.startedAt ?? log.modifiedAt) || 0;
  const end = Date.parse(log.endedAt ?? '') || start + Math.max(1, handle.totalBytes) * 2;
  const finishLine = (time: number) => {
    if (time >= range.start && time <= range.end) {
      matched += 1;
      lines.push({ timestampMs: time, text: line, shortened });
      // Keep the closest lines to the event; stable order preserves same-read lines.
      if (lines.length > MAX_LINES) {
        let farthest = 0;
        for (let i = 1; i < lines.length; i += 1) {
          if (Math.abs(lines[i].timestampMs - anchorMs) > Math.abs(lines[farthest].timestampMs - anchorMs)) farthest = i;
        }
        lines.splice(farthest, 1);
      }
    }
    line = ''; shortened = false;
  };
  const consume = (text: string, time: number) => {
    for (const character of text) {
      if (character === '\n' && previousCR) { previousCR = false; continue; }
      if (character === '\r' || character === '\n') { finishLine(time); previousCR = character === '\r'; }
      else { previousCR = false; if (line.length < MAX_LINE_LENGTH) line += character; else shortened = true; }
    }
  };
  try {
    let offset = 0;
    while (offset < handle.totalBytes) {
      signal?.throwIfAborted();
      const chunk = await readNativeCaptureAnalysisChunk(handle.id);
      signal?.throwIfAborted();
      if (chunk.offset !== offset || chunk.nextOffset <= offset || chunk.totalBytes !== handle.totalBytes)
        throw new Error('The capture changed while reading context. Inspect the event again to retry.');
      const bytes = Uint8Array.from(atob(chunk.rawBase64), (character) => character.charCodeAt(0));
      if (bytes.length !== chunk.nextOffset - offset) throw new Error('The capture context was incomplete. Inspect the event again to retry.');
      const timing = chunk.timing ?? (() => {
        const boundaries: number[] = [];
        bytes.forEach((byte, position) => { if (byte === 10 || byte === 13) boundaries.push(position + 1); });
        if (boundaries[boundaries.length - 1] !== bytes.length) boundaries.push(bytes.length);
        return boundaries.map((endOffset) => ({ endOffset, timestampMs: start + Math.max(0, end - start) * (offset + endOffset) / Math.max(1, handle.totalBytes) }));
      })();
      let from = 0;
      for (const record of timing) {
        if (!Number.isFinite(record.timestampMs) || record.endOffset <= from || record.endOffset > bytes.length)
          throw new Error('The capture timing is incomplete. Reopen the capture to retry.');
        lastTime = record.timestampMs;
        consume(decoder.decode(bytes.subarray(from, record.endOffset), { stream: true }), lastTime);
        from = record.endOffset;
      }
      if (from !== bytes.length) throw new Error('The capture timing is incomplete. Reopen the capture to retry.');
      offset = chunk.nextOffset;
    }
    consume(decoder.decode(), lastTime);
    if (line || shortened) finishLine(lastTime);
    signal?.throwIfAborted();
    return { lines, matched, timingMode: handle.timingMode };
  } finally { await closeNativeCaptureAnalysis(handle.id).catch(() => undefined); }
}
