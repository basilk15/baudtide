// Rebuild deterministic synthetic recordings and the shared catalogue.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportCaptureBundle } from '../../electron/capture-bundle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'baudtide-example-'));
const start = Date.parse('2026-01-01T12:00:00.000Z');
const decoder = { version: 1, id: 'example-motor', name: 'Motor columns', prefix: 'MOTOR,', separator: 'comma', fields: [{ column: 1, name: 'speed', unit: 'rpm' }, { column: 2, name: 'current', unit: 'A' }], createdAt: start, updatedAt: start };
const examples = [
  { id: 'temperature-spike', fileName: 'temperature-demo.btbundle', name: 'Example temperature capture', title: 'Temperature spike', description: 'A short sensor recording with a brief rise and recovery.', format: 'JSON', durationSeconds: 60, signals: ['temperature', 'voltage'], decoderName: null, previewLabel: 'Temperature', previewUnit: '°C', guide: 'Open in Visualize, select temperature, and inspect the note at 30 seconds. Compare the spike with the steady voltage trace.' },
  { id: 'motor-columns', fileName: 'motor-demo.btbundle', name: 'Example motor capture', title: 'Motor speed step', description: 'Prefixed numeric columns with an included decoder and signal units.', format: 'Custom CSV', durationSeconds: 60, signals: ['speed', 'current'], decoderName: decoder.name, previewLabel: 'Speed', previewUnit: 'rpm', guide: 'Open in Visualize to use the included Motor columns decoder. Inspect the speed change at 30 seconds alongside the current signal.' },
];
try {
  const destination = path.join(root, 'electron', 'examples'); await mkdir(destination, { recursive: true });
  for (const example of examples) {
    let raw = ''; const records = []; const preview = [];
    for (let second = 0; second <= example.durationSeconds; second += 1) {
      const temperature = +(22 + Math.sin(second / 9) * 0.7 + (second >= 29 && second <= 33 ? 4 : 0)).toFixed(2);
      const speed = Math.round(1200 + 25 * Math.sin(second / 6) + (second >= 30 ? 400 : 0));
      const motor = example.id === 'motor-columns';
      raw += motor ? `MOTOR,${speed},${(0.4 + (second >= 30 ? 0.2 : 0) + Math.sin(second / 8) * 0.02).toFixed(3)}\n` : `${JSON.stringify({ temperature, voltage: +(3.3 + Math.sin(second / 12) * 0.03).toFixed(3) })}\n`;
      preview.push(motor ? speed : temperature);
      records.push({ offset: Buffer.byteLength(raw), timestamp: start + second * 1000 });
    }
    example.preview = preview;
    const timing = Buffer.alloc(8 + records.length * 16); timing.write('BTIME001');
    records.forEach((record, index) => { timing.writeBigUInt64LE(BigInt(record.offset), 8 + index * 16); timing.writeBigInt64LE(BigInt(record.timestamp), 16 + index * 16); });
    const rawPath = path.join(temporary, 'capture.log'); await writeFile(rawPath, raw); await writeFile(`${rawPath}.timing`, timing);
    await exportCaptureBundle({ rawPath, timingPath: `${rawPath}.timing`, destination: path.join(destination, example.fileName), metadata: {
      name: example.name, state: 'saved', decoder: example.id === 'motor-columns' ? decoder : null,
      startedAt: new Date(start).toISOString(), endedAt: new Date(start + example.durationSeconds * 1000).toISOString(),
      notes: [{ timestamp: new Date(start + 30000).toISOString(), sourceName: example.name, label: example.title, note: `Synthetic example. ${example.guide}` }],
    } });
  }
  await writeFile(path.join(destination, 'catalog.json'), `${JSON.stringify(examples, null, 2)}\n`);
} finally { if (path.dirname(temporary) === path.resolve(os.tmpdir())) await rm(temporary, { recursive: true, force: true }); }
