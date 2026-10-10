import { useEffect, useRef, useState } from 'react';
import { getNativeCaptureStorageUsage } from '../lib/serial';
import { captureStoragePressure, formatCaptureBytes, type StoragePressure } from '../lib/captureStorage';
import './bench-tools.css';

type Props = {
  nativeEnabled: boolean;
  limit: number;
  directory: string;
  stoppedCount: number;
  onSettings: () => void;
  onLogs: () => void;
  onRetry: () => Promise<void>;
  onWarning: (title: string, detail: string) => void;
};
export function CaptureStorageBanner({ nativeEnabled, limit, directory, stoppedCount, onSettings, onLogs, onRetry, onWarning }: Props) {
  const [used, setUsed] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState(false);
  const previous = useRef<StoragePressure>('normal');
  const warningRef = useRef(onWarning); warningRef.current = onWarning;
  useEffect(() => {
    if (!nativeEnabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setUsed(null); previous.current = 'normal';
    const poll = async () => {
      try {
        const bytes = await getNativeCaptureStorageUsage();
        if (cancelled) return;
        setUsed(bytes); setError('');
        const pressure = captureStoragePressure(bytes, limit);
        if (pressure !== 'normal' && pressure !== previous.current) {
          warningRef.current(pressure === 'full' ? 'Capture storage is full' : 'Capture storage is running low', `${formatCaptureBytes(bytes)} of ${formatCaptureBytes(limit)} used. Review saved logs or raise the limit before monitoring stops.`);
        }
        previous.current = pressure;
      } catch { if (!cancelled) setError('Could not check capture storage. Open Preferences to retry.'); }
      if (!cancelled) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [nativeEnabled, limit, directory]);
  if (!nativeEnabled) return null;
  const pressure = used === null ? 'normal' : captureStoragePressure(used, limit);
  if (pressure === 'normal' && !stoppedCount && !error) return null;
  return <aside className={`bt-capture-storage is-${pressure}`} aria-label="Capture storage warning">
    <div role="status"><strong>{stoppedCount ? `${stoppedCount} ${stoppedCount === 1 ? 'terminal stopped' : 'terminals stopped'} at the storage limit` : pressure === 'full' ? 'Capture storage is full' : error ? 'Storage status unavailable' : 'Capture storage is running low'}</strong>
      <p>{error || `${used === null ? 'Checking usage…' : `${formatCaptureBytes(used)} of ${formatCaptureBytes(limit)} used (${Math.floor(used / limit * 100)}%).`} Monitoring and watches stop when captures reach the limit. Review saved logs or raise the limit, then reconnect stopped terminals.`}</p></div>
    <div className="bt-storage-actions"><button type="button" onClick={onLogs}>Review saved logs</button><button type="button" onClick={onSettings}>Storage settings</button>
      {stoppedCount > 0 && <button type="button" disabled={retrying || used === null || used >= limit || Boolean(error)} onClick={async () => {
        setRetrying(true);
        try { await onRetry(); } catch (error) { setError(error instanceof Error ? error.message : 'Could not reconnect stopped terminals.'); }
        finally { setRetrying(false); }
      }}>{retrying ? 'Reconnecting…' : 'Reconnect stopped terminals'}</button>}</div>
  </aside>;
}
