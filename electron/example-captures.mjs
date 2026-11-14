import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const exampleCaptures = require('./examples/catalog.json');

/** Resolve an allowlisted ID, never a renderer-provided path. */
export function exampleCaptureFilename(id = 'temperature-spike') {
  const example = exampleCaptures.find((entry) => entry.id === id);
  if (!example) throw new Error('Unknown example capture. Choose an example from the gallery.');
  return example.fileName;
}
