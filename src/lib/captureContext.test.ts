import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readCaptureContext } from './captureContext';
import type { CaptureAnalysisChunk, SavedLog } from './serial';
const native = vi.hoisted(() => ({ open: vi.fn(), read: vi.fn(), close: vi.fn() }));
vi.mock('./serial', () => ({ openNativeCaptureAnalysis: native.open, readNativeCaptureAnalysisChunk: native.read, closeNativeCaptureAnalysis: native.close }));
const log: SavedLog = { path: '/capture.log', fileName: 'capture.log', sessionName: 'Board', modifiedAt: new Date(1000).toISOString(),
  startedAt: new Date(1000).toISOString(), endedAt: new Date(4000).toISOString(), sizeBytes: 1, metadataAvailable: true, state: 'saved' };
function fixture(parts: Array<{ text?: string; bytes?: Uint8Array; time: number }>, approximate = false) {
  const buffers = parts.map((part) => part.bytes ?? new TextEncoder().encode(part.text!));
  const totalBytes = buffers.reduce((count, bytes) => count + bytes.length, 0);
  let offset = 0;
  native.open.mockResolvedValue({ id: 'reader', totalBytes, timingMode: approximate ? 'approximate' : 'recorded' });
  buffers.forEach((bytes, index) => {
    const chunk: CaptureAnalysisChunk = { offset, nextOffset: offset + bytes.length, totalBytes,
      rawBase64: btoa(String.fromCharCode(...bytes)), timing: approximate ? null : [{ endOffset: bytes.length, timestampMs: parts[index].time }] };
    native.read.mockResolvedValueOnce(chunk); offset += bytes.length;
  });
}
beforeEach(() => { vi.resetAllMocks(); native.close.mockResolvedValue(undefined); });
describe('original serial context', () => {
  it('includes nonnumeric lines, handles split CRLF and finishes partial lines in capture order', async () => {
    fixture([{ text: 'boot\r', time: 1000 }, { text: '\n{"temp":90}\nfan ', time: 2000 }, { text: 'started', time: 3000 }]);
    const result = await readCaptureContext(log, { start: 1000, end: 3000 }, 2000);
    expect(result.lines.map((line) => [line.timestampMs, line.text])).toEqual([[1000, 'boot'], [2000, '{"temp":90}'], [3000, 'fan started']]);
    expect(native.close).toHaveBeenCalledWith('reader');
  });
  it('decodes UTF-8 across byte chunks and associates the complete line with its receive time', async () => {
    const bytes = new TextEncoder().encode('motor → on\n');
    fixture([{ bytes: bytes.slice(0, 7), time: 1000 }, { bytes: bytes.slice(7), time: 2000 }]);
    const result = await readCaptureContext(log, { start: 1500, end: 2500 }, 2000);
    expect(result.lines[0].text).toBe('motor → on');
    expect(result.lines[0].timestampMs).toBe(2000);
  });
  it('bounds long lines and keeps the closest 300 lines while reporting the full count', async () => {
    fixture([{ text: 'x'.repeat(6000) + '\n', time: 2000 }, { text: Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\n', time: 3000 }]);
    const result = await readCaptureContext(log, { start: 1000, end: 4000 }, 2000);
    expect(result.matched).toBe(401); expect(result.lines).toHaveLength(300);
    expect(result.lines[0].shortened).toBe(true); expect(result.lines[0].text.length).toBe(4096);
  });
  it('labels legacy timing as approximate and handles empty windows', async () => {
    fixture([{ text: 'one\ntwo\n', time: 0 }], true);
    const result = await readCaptureContext(log, { start: 0, end: 5000 }, 2000);
    expect(result.timingMode).toBe('approximate');
    expect(result.lines.map((line) => line.text)).toEqual(['one', 'two']);
    fixture([{ text: 'none\n', time: 1000 }]);
    expect((await readCaptureContext(log, { start: 2000, end: 3000 }, 2000)).lines).toEqual([]);
  });
  it('closes the reader when cancelled midread or when chunk offsets are damaged', async () => {
    fixture([{ text: 'line\n', time: 2000 }]);
    native.read.mockReset();
    const abort = new AbortController();
    native.read.mockImplementationOnce(async () => { abort.abort(); return {}; });
    await expect(readCaptureContext(log, { start: 0, end: 3000 }, 2000, abort.signal)).rejects.toThrow();
    expect(native.close).toHaveBeenCalledOnce();
    native.read.mockResolvedValueOnce({ offset: 10, nextOffset: 11, totalBytes: 5 });
    await expect(readCaptureContext(log, { start: 0, end: 3000 }, 2000)).rejects.toThrow('capture changed');
    expect(native.close).toHaveBeenCalledTimes(2);
  });
});
