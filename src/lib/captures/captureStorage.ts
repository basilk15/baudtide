export type StoragePressure = 'normal' | 'warning' | 'critical' | 'full';
export function captureStoragePressure(used: number, limit: number): StoragePressure {
  if (used >= limit) return 'full';
  if (used >= limit * 0.95) return 'critical';
  return used >= limit * 0.8 ? 'warning' : 'normal';
}
export function formatCaptureBytes(bytes: number) {
  const unit = bytes >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2;
  return `${(bytes / unit).toFixed(1)} ${unit === 1024 ** 3 ? 'GiB' : 'MiB'}`;
}
