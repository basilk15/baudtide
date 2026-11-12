// Rebuild the small, synthetic capture shipped with BaudTide.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportCaptureBundle } from '../../electron/capture-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'baudtide-example-'));
try {
  const start = Date.parse('2026-01-01T12:00:00.000Z');
  let raw = ''; const records = [];
  for (let second = 0; second < 60; second += 1) {
    const temperature = +(22 + Math.sin(second / 9) * 0.7 + (second >= 29 && second <= 33 ? 4 : 0)).toFixed(2);
    raw += `${JSON.stringify({ temperature, voltage: +(3.3 + Math.sin(second / 12) * 0.03).toFixed(3) })}\n`;
    records.push({ offset: Buffer.byteLength(raw), timestamp: start + second * 1000 });
  }
  const timing = Buffer.alloc(8 + records.length * 16); timing.write('BTIME001');
  records.forEach((record, index) => { timing.writeBigUInt64LE(BigInt(record.offset), 8 + index * 16); timing.writeBigInt64LE(BigInt(record.timestamp), 16 + index * 16); });
  const rawPath = path.join(temporary, 'capture.log'); await writeFile(rawPath, raw); await writeFile(`${rawPath}.timing`, timing);
  const destination = path.join(root, 'electron', 'examples', 'temperature-demo.btbundle');
  await mkdir(path.dirname(destination), { recursive: true });
  await exportCaptureBundle({ rawPath, timingPath: `${rawPath}.timing`, destination, metadata: {
    name: 'Example temperature capture', state: 'saved', decoder: null,
    startedAt: new Date(start).toISOString(), endedAt: new Date(start + 59000).toISOString(),
    notes: [{ timestamp: new Date(start + 30000).toISOString(), sourceName: 'Example temperature capture', label: 'Temperature spike', note: 'Synthetic example: inspect the nearby output and chart.' }],
  } });
} finally { if (path.dirname(temporary) === path.resolve(os.tmpdir())) await rm(temporary, { recursive: true, force: true }); }
