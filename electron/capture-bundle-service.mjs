import { mkdir, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { exportCaptureBundle, importCaptureBundle, inspectCaptureTiming, inspectCaptureBundleFile } from './capture-bundle.mjs';

/** The renderer never chooses staging paths or bypasses sidecar capture leases. */
export class CaptureBundleService {
  constructor({ invoke, stagingRoot, validateDestination, removeStaging = rm }) {
    this.invoke = invoke;
    this.stagingRoot = path.resolve(stagingRoot);
    this.validateDestination = validateDestination;
    this.removeStaging = removeStaging;
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
    const available = await statfs(this.stagingRoot, { bigint: true });
    if (available.bavail * available.bsize < BigInt(payloadBytes) * 2n + 64n * 1024n * 1024n) {
      throw new Error('Not enough free disk space to stage and import this capture. Free space and try again.');
    }
    const reservation = await this.invoke('reserve_capture_bundle_import', { size: payloadBytes });
    let staged;
    try {
      staged = await importCaptureBundle({ source, stagingRoot: this.stagingRoot, maxBytes: payloadBytes });
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
