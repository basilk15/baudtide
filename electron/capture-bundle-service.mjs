import { lstat, mkdir, readFile, readdir, realpath, rm, stat, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { exportCaptureBundle, importCaptureBundle, inspectCaptureTiming, inspectCaptureBundleFile } from './capture-bundle.mjs';

async function filesystemSpace(directory) {
  const [file, space] = await Promise.all([stat(directory, { bigint: true }), statfs(directory, { bigint: true })]);
  return { device: file.dev, available: space.bavail * space.bsize };
}

function processIsRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** Remove only recognizable artifacts whose owning process no longer exists. */
export async function cleanupInterruptedBundleImports({ stagingRoot, captureDirectories, isProcessRunning = processIsRunning }) {
  const appData = path.dirname(path.resolve(stagingRoot));
  const regularJson = async (file) => {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > 300 * 1024) return null;
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  };
  const removeIfPresent = async (file) => {
    try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  const cleanOrphan = async (directory, id) => {
    const recovery = path.join(appData, 'bundle-imports', `${id}.json`);
    try { await lstat(recovery); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    const value = await regularJson(recovery);
    if (!value || value.id !== id || typeof value.capturePath !== 'string') return false;
    const capture = path.resolve(value.capturePath);
    const [captureParent, actualDirectory] = await Promise.all([realpath(path.dirname(capture)), realpath(directory)]);
    if (path.relative(captureParent, actualDirectory) !== '' || !path.basename(capture).endsWith(`-${id}.log`)) return false;
    try { await lstat(capture); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const timing = `${capture}.timing`;
    try {
      const info = await lstat(timing);
      if (!info.isFile()) return false;
      await unlink(timing);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const index = path.join(appData, 'logs', 'index', `${id}.json`);
    const record = await regularJson(index);
    if (record?.sessionId === id && typeof record.logPath === 'string' && path.resolve(record.logPath) === capture) await removeIfPresent(index);
    await removeIfPresent(recovery);
    return true;
  };
  const clean = async (directory, pattern, ownerCount, expectedType, remove) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const match = pattern.exec(entry.name);
      if (!match || !entry[expectedType]()) continue;
      const owners = match.slice(1, 1 + ownerCount).map(Number);
      if (owners.some((pid) => !Number.isSafeInteger(pid) || pid <= 0 || isProcessRunning(pid))) continue;
      await remove(path.join(directory, entry.name), match);
    }
  };
  await clean(stagingRoot, /^bundle-(\d+)-(\d+)-[a-zA-Z0-9]{6}$/, 2, 'isDirectory', (target) => rm(target, { recursive: true, force: true }));
  const tempPattern = /^\.bundle-(\d+)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(\.timing)?\.tmp$/;
  for (const directory of new Set(captureDirectories)) await clean(directory, tempPattern, 1, 'isFile', async (target, match) => {
    if (!match[3] && !await cleanOrphan(directory, match[2])) return;
    await removeIfPresent(target);
  });
}

/** The renderer never chooses staging paths or bypasses sidecar capture leases. */
export class CaptureBundleService {
  constructor({ invoke, stagingRoot, validateDestination, removeStaging = rm, getDiskSpace = filesystemSpace }) {
    this.invoke = invoke;
    this.stagingRoot = path.resolve(stagingRoot);
    this.validateDestination = validateDestination;
    this.removeStaging = removeStaging;
    this.getDiskSpace = getDiskSpace;
  }
  async inspect(sourcePath) {
    const lease = await this.invoke('begin_capture_bundle_export', { sourcePath });
    try { return { timingMode: lease.timingMode === 'recorded' ? await inspectCaptureTiming(lease.path) : 'approximate' }; }
    finally { await this.invoke('end_capture_bundle_export', { id: lease.id }); }
  }
  async exportBundle({ sourcePath, destination, metadata }) {
    await this.validateDestination(destination);
    const lease = await this.invoke('begin_capture_bundle_export', { sourcePath });
    try {
      const timingMode = lease.timingMode === 'recorded' ? await inspectCaptureTiming(lease.path) : 'approximate';
      const capture = lease.capture;
      if (!capture || capture.state === 'capturing') throw new Error('The capture is no longer available for export.');
      const portable = { name: capture.sessionName, state: capture.state, notes: metadata.notes, decoder: metadata.decoder,
        ...(capture.startedAt ? { startedAt: capture.startedAt } : {}), ...(capture.endedAt ? { endedAt: capture.endedAt } : {}), modifiedAt: capture.modifiedAt };
      await exportCaptureBundle({ rawPath: lease.path, timingPath: timingMode === 'recorded' ? `${lease.path}.timing` : null, destination, metadata: portable, validateBeforePublish: this.validateDestination });
      return { destination, timingMode };
    } finally { await this.invoke('end_capture_bundle_export', { id: lease.id }); }
  }
  async importBundle(source) {
    await mkdir(this.stagingRoot, { recursive: true });
    const { payloadBytes } = await inspectCaptureBundleFile(source);
    const reservation = await this.invoke('reserve_capture_bundle_import', { size: payloadBytes });
    let staged;
    try {
      const [stagingSpace, destinationSpace] = await Promise.all([
        this.getDiskSpace(this.stagingRoot), this.getDiskSpace(reservation.directory),
      ]);
      const payload = BigInt(payloadBytes); const margin = 64n * 1024n * 1024n;
      const requiredStaging = payload * (stagingSpace.device === destinationSpace.device ? 2n : 1n) + margin;
      if (stagingSpace.available < requiredStaging || destinationSpace.available < payload + margin) {
        throw new Error('Not enough free disk space to stage and import this capture. Free space and try again.');
      }
      staged = await importCaptureBundle({ source, stagingRoot: this.stagingRoot, maxBytes: payloadBytes, ownerPid: reservation.ownerPid });
      return await this.invoke('publish_capture_bundle', { stage: staged.stagingDirectory, metadata: staged.metadata, reservation: reservation.id });
    }
    finally {
      await this.invoke('release_capture_bundle_import', { id: reservation.id }).catch((error) => console.warn('Could not release bundle reservation:', error.message));
      if (staged && path.dirname(staged.stagingDirectory) === this.stagingRoot) {
        await this.removeStaging(staged.stagingDirectory, { recursive: true, force: true })
          .catch((error) => console.warn('Could not remove private bundle staging:', error.message));
      }
    }
  }
}
