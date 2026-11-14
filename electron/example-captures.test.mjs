import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exampleCaptures, exampleCaptureFilename } from './example-captures.mjs';
import { importCaptureBundle } from './capture-bundle.mjs';
import { parseCustomTelemetryLine } from '../src/lib/telemetry/telemetryDecoders.ts';

describe('packaged example captures', () => {
  it('resolves only known IDs and preserves the legacy default', () => {
    expect(exampleCaptureFilename()).toBe('temperature-demo.btbundle');
    for (const id of ['../secret', '', 'unknown', null, 5, '__proto__']) expect(() => exampleCaptureFilename(id)).toThrow('Unknown example');
  });
  it('ships both catalogue recordings with recorded timing, notes, and the expected decoder', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bt-examples-'));
    try {
      expect(exampleCaptures).toHaveLength(2);
      for (const example of exampleCaptures) {
        const staged = await importCaptureBundle({ source: new URL(`./examples/${exampleCaptureFilename(example.id)}`, import.meta.url), stagingRoot: dir });
        const raw = (await readFile(staged.rawPath)).toString();
        const lines = raw.trim().split('\n');
        expect(lines).toHaveLength(example.durationSeconds + 1);
        expect(lines.map(line => example.id === 'motor-columns' ? Number(line.split(',')[1]) : JSON.parse(line).temperature)).toEqual(example.preview);
        expect(staged.timingPath).not.toBeNull();
        expect(staged.metadata.name).toBe(example.name);
        expect(staged.metadata.notes).toHaveLength(1);
        expect(staged.metadata.decoder?.name ?? null).toBe(example.decoderName);
        expect(example.preview).toHaveLength(example.durationSeconds + 1);
        if (example.id === 'motor-columns') {
          expect(parseCustomTelemetryLine(lines[0], staged.metadata.decoder)).toEqual({ speed: { value: 1200, unit: 'rpm' }, current: { value: 0.4, unit: 'A' } });
        }
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
