import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

const MAGIC = Buffer.from('BTBND002');
// Magic, manifest length, then the SHA-256 digest of the exact manifest bytes.
const PREFIX_SIZE = 44;
const MAX_MANIFEST = 256 * 1024;
const MAX_CAPTURE = 8 * 1024 * 1024 * 1024;
const MAX_TIMING = 256 * 1024 * 1024;
const CHUNK = 64 * 1024;

function invalid(message) { return new Error(`Invalid capture bundle: ${message}`); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validText(value, maximum, allowEmpty = false) {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.trim().length > 0) && !value.includes('\0');
}
function validateMetadata(metadata) {
  if (!object(metadata) || !validText(metadata.name, 160) || !Array.isArray(metadata.notes) || metadata.notes.length > 5000) throw invalid('capture details are malformed.');
  for (const note of metadata.notes) {
    if (!object(note) || !validText(note.timestamp, 80) || !Number.isFinite(Date.parse(note.timestamp))
      || !validText(note.label, 120) || !validText(note.note, 2000, true) || !validText(note.sourceName, 160, true)) throw invalid('a capture note is malformed.');
  }
  if (metadata.decoder !== null) {
    const decoder = metadata.decoder;
    if (!object(decoder) || decoder.version !== 1 || !validText(decoder.id, 128) || !validText(decoder.name, 80)
      || /[\r\n]/.test(decoder.name) || !validText(decoder.prefix, 80, true) || /[\r\n]/.test(decoder.prefix)
      || !['whitespace', 'comma', 'tab', 'pipe', 'semicolon'].includes(decoder.separator)
      || !Number.isFinite(decoder.createdAt) || !Number.isFinite(decoder.updatedAt)
      || !Array.isArray(decoder.fields) || !decoder.fields.length || decoder.fields.length > 32) throw invalid('decoder details are malformed.');
    const columns = new Set(); const names = new Set();
    for (const field of decoder.fields) {
      if (!object(field) || !Number.isInteger(field.column) || field.column < 1 || field.column > 64 || columns.has(field.column)
        || !validText(field.name, 64) || /[\r\n\x00-\x1f]/.test(field.name) || names.has(field.name.trim().toLowerCase())
        || (field.unit !== undefined && (!validText(field.unit, 24, true) || /[\r\n\x00-\x1f]/.test(field.unit)))) throw invalid('decoder fields are malformed.');
      columns.add(field.column); names.add(field.name.trim().toLowerCase());
    }
  }
  for (const key of ['startedAt', 'endedAt', 'modifiedAt']) {
    if (metadata[key] !== undefined && (!validText(metadata[key], 80) || !Number.isFinite(Date.parse(metadata[key])))) throw invalid('capture time is malformed.');
  }
  if (metadata.state !== undefined && !['saved', 'disconnected', 'error', 'quota-reached', 'interrupted', 'unknown'].includes(metadata.state)) throw invalid('capture state is invalid.');
}
function portableMetadata(metadata) {
  const decoder = metadata.decoder && {
    version: metadata.decoder.version, id: metadata.decoder.id, name: metadata.decoder.name,
    prefix: metadata.decoder.prefix, separator: metadata.decoder.separator,
    fields: Array.isArray(metadata.decoder.fields) ? metadata.decoder.fields.map((field) => ({
      column: field.column, name: field.name, ...(field.unit === undefined ? {} : { unit: field.unit }),
    })) : metadata.decoder.fields,
    createdAt: metadata.decoder.createdAt, updatedAt: metadata.decoder.updatedAt,
  };
  return {
    name: metadata.name,
    notes: metadata.notes.map(({ timestamp, sourceName, label, note }) => ({ timestamp, sourceName, label, note })),
    decoder,
    ...(metadata.state === undefined ? {} : { state: metadata.state }),
    ...Object.fromEntries(['startedAt', 'endedAt', 'modifiedAt'].filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]])),
  };
}
function validatePart(part, max, optional = false) {
  if (optional && part === null) return;
  if (!object(part) || !Number.isSafeInteger(part.size) || part.size < 0 || part.size > max
    || typeof part.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(part.sha256)) throw invalid('a file descriptor is malformed.');
}
function validateManifest(manifest) {
  if (!object(manifest) || manifest.version !== 2) throw invalid('this bundle version is not supported.');
  validateMetadata(manifest.metadata);
  validatePart(manifest.raw, MAX_CAPTURE);
  validatePart(manifest.timing, MAX_TIMING, true);
}
async function readManifest(input) {
  const prefix = Buffer.alloc(PREFIX_SIZE);
  await readExact(input.file, prefix, 0);
  if (!prefix.subarray(0, 8).equals(MAGIC)) throw invalid('unrecognized file format.');
  const length = prefix.readUInt32BE(8);
  if (!length || length > MAX_MANIFEST) throw invalid('manifest exceeds the permitted size.');
  const bytes = Buffer.alloc(length);
  await readExact(input.file, bytes, PREFIX_SIZE);
  if (!createHash('sha256').update(bytes).digest().equals(prefix.subarray(12))) throw invalid('manifest checksum does not match.');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw invalid('manifest is not valid JSON.'); }
  validateManifest(manifest);
  const dataStart = PREFIX_SIZE + length;
  const payloadBytes = manifest.raw.size + (manifest.timing?.size ?? 0);
  if (input.size !== dataStart + payloadBytes) throw invalid('file length does not match the manifest.');
  return { manifest, dataStart, payloadBytes };
}

export async function inspectCaptureBundleFile(source) {
  const input = await openRegular(source);
  try { return { payloadBytes: (await readManifest(input)).payloadBytes }; }
  finally { await input.file.close(); }
}
async function writeAll(file, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
    if (!bytesWritten) throw new Error('Could not finish writing the capture bundle.');
    offset += bytesWritten;
  }
}
async function readExact(file, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesRead) throw invalid('the file is truncated.');
    offset += bytesRead;
  }
}
async function transfer(input, output, start, size) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(CHUNK);
  let count = 0;
  while (count < size) {
    const length = Math.min(buffer.length, size - count);
    const { bytesRead } = await input.read(buffer, 0, length, start + count);
    if (!bytesRead) throw invalid('the file is truncated or changed while reading.');
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    if (output) await writeAll(output, chunk);
    count += bytesRead;
  }
  return hash.digest('hex');
}
async function openRegular(filePath) {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw invalid('a source is not a regular file.');
    return { file, size: stat.size };
  } catch (error) { await file.close(); throw error; }
}
async function validateTiming(file, size, rawSize) {
  if (size < 24 || (size - 8) % 16 !== 0 || rawSize === 0) throw invalid('recorded timing is incomplete.');
  const header = Buffer.alloc(8);
  await readExact(file, header, 0);
  if (header.toString('ascii') !== 'BTIME001') throw invalid('recorded timing has an invalid header.');
  const buffer = Buffer.allocUnsafe(CHUNK);
  let offset = 8;
  let previous = 0n;
  while (offset < size) {
    const length = Math.min(buffer.length, size - offset);
    await readExact(file, buffer.subarray(0, length), offset);
    for (let i = 0; i < length; i += 16) {
      const end = buffer.readBigUInt64LE(i);
      const timestamp = buffer.readBigInt64LE(i + 8);
      if (end <= previous || end > BigInt(rawSize) || timestamp < -8640000000000000n || timestamp > 8640000000000000n) throw invalid('recorded timing contains invalid entries.');
      previous = end;
    }
    offset += length;
  }
  if (previous !== BigInt(rawSize)) throw invalid('recorded timing does not cover the capture.');
}

export async function inspectCaptureTiming(rawPath) {
  const raw = await openRegular(rawPath);
  let timing;
  try {
    timing = await openRegular(`${rawPath}.timing`);
    if (timing.size > MAX_TIMING) return 'approximate';
    await validateTiming(timing.file, timing.size, raw.size);
    return 'recorded';
  } catch { return 'approximate'; }
  finally { await raw.file.close(); await timing?.file.close(); }
}

/** Write a bundle to a temporary sibling and publish it after every byte is checked. */
export async function exportCaptureBundle({ rawPath, timingPath, destination, metadata, validateBeforePublish = async () => {} }) {
  validateMetadata(metadata);
  metadata = portableMetadata(metadata);
  const raw = await openRegular(rawPath);
  let timing = null;
  let output = null;
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    if (raw.size > MAX_CAPTURE) throw new Error('This capture is too large for a bundle.');
    if (timingPath) {
      timing = await openRegular(timingPath);
      if (timing.size > MAX_TIMING) throw new Error('This capture has too much timing data for a bundle.');
      await validateTiming(timing.file, timing.size, raw.size);
    }
    const manifest = {
      version: 2, metadata,
      raw: { size: raw.size, sha256: await transfer(raw.file, null, 0, raw.size) },
      timing: timing ? { size: timing.size, sha256: await transfer(timing.file, null, 0, timing.size) } : null,
    };
    const header = Buffer.from(JSON.stringify(manifest));
    if (header.length > MAX_MANIFEST) throw new Error('Capture notes and decoder exceed the bundle metadata limit.');
    const prefix = Buffer.alloc(PREFIX_SIZE);
    MAGIC.copy(prefix);
    prefix.writeUInt32BE(header.length, 8);
    createHash('sha256').update(header).digest().copy(prefix, 12);
    output = await open(temporary, 'wx', 0o600);
    await writeAll(output, prefix);
    await writeAll(output, header);
    if (await transfer(raw.file, output, 0, raw.size) !== manifest.raw.sha256
      || (timing && await transfer(timing.file, output, 0, timing.size) !== manifest.timing.sha256)) throw new Error('Capture changed during export. Try again after it finishes recording.');
    if ((await raw.file.stat()).size !== raw.size || (timing && (await timing.file.stat()).size !== timing.size)) throw new Error('Capture changed during export. Try again after it finishes recording.');
    await output.sync();
    await output.close(); output = null;
    await validateBeforePublish(destination);
    await rename(temporary, destination);
  } finally {
    await output?.close().catch(() => {});
    await raw.file.close();
    await timing?.file.close();
    await unlink(temporary).catch(() => {});
  }
}

/** Validate before returning private staged files for publication by the library. */
export async function importCaptureBundle({ source, stagingRoot, maxBytes = MAX_CAPTURE + MAX_TIMING, ownerPid = process.pid }) {
  const input = await openRegular(source);
  let stage = null;
  try {
    const { manifest, dataStart, payloadBytes } = await readManifest(input);
    if (payloadBytes > maxBytes) throw invalid('the file changed after space was reserved.');
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw invalid('the import owner is unavailable.');
    stage = await mkdtemp(path.join(path.resolve(stagingRoot), `bundle-${process.pid}-${ownerPid}-`));
    const rawPath = path.join(stage, 'capture.log');
    const timingPath = manifest.timing ? `${rawPath}.timing` : null;
    const raw = await open(rawPath, 'wx');
    try {
      if (await transfer(input.file, raw, dataStart, manifest.raw.size) !== manifest.raw.sha256) throw invalid('raw capture checksum does not match.');
    } finally { await raw.close(); }
    if (timingPath) {
      const timing = await open(timingPath, 'wx+');
      try {
        if (await transfer(input.file, timing, dataStart + manifest.raw.size, manifest.timing.size) !== manifest.timing.sha256) throw invalid('timing checksum does not match.');
        await validateTiming(timing, manifest.timing.size, manifest.raw.size);
      } finally { await timing.close(); }
    }
    const result = { rawPath, timingPath, metadata: manifest.metadata, stagingDirectory: stage };
    stage = null;
    return result;
  } finally {
    await input.file.close();
    if (stage && path.dirname(stage) === path.resolve(stagingRoot)) await rm(stage, { recursive: true, force: true });
  }
}
