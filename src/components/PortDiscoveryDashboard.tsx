import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Bluetooth, ChevronRight, Cpu, LoaderCircle, Radio, RefreshCw, Usb } from 'lucide-react';
import type { NativeSerialPort } from '../lib/serial';
import './port-discovery-dashboard.css';

const AUTO_SCAN_INTERVAL_MS = 15_000;

type PortDiscoveryDashboardProps = {
  nativeEnabled: boolean;
  onScan: () => Promise<NativeSerialPort[]>;
  onConnect: (port: NativeSerialPort) => void;
  onRequestConnection: () => void;
};

function PortIcon({ transport }: { transport: NativeSerialPort['transport'] }) {
  if (transport === 'usb') return <Usb size={19} />;
  if (transport === 'bluetooth') return <Bluetooth size={19} />;
  return <Cpu size={19} />;
}

function displayDetails(port: NativeSerialPort) {
  return [...new Set([port.product, port.manufacturer].filter(Boolean))].join(' · ') || 'Serial device';
}

function deviceName(path: string, ports: NativeSerialPort[]) {
  const device = ports.find((port) => port.path === path);
  return device?.label || path;
}

function changeAnnouncement(previous: NativeSerialPort[], next: NativeSerialPort[]) {
  const previousPaths = new Set(previous.map((port) => port.path));
  const nextPaths = new Set(next.map((port) => port.path));
  const added = next.filter((port) => !previousPaths.has(port.path));
  const removed = previous.filter((port) => !nextPaths.has(port.path));

  if (!added.length && !removed.length) return '';
  if (added.length === 1 && !removed.length) return `Device connected: ${deviceName(added[0].path, next)}.`;
  if (removed.length === 1 && !added.length) return `Device disconnected: ${deviceName(removed[0].path, previous)}.`;
  return `Device list updated: ${added.length} added, ${removed.length} removed.`;
}

export function PortDiscoveryDashboard({ nativeEnabled, onScan, onConnect, onRequestConnection }: PortDiscoveryDashboardProps) {
  const [ports, setPorts] = useState<NativeSerialPort[]>([]);
  const [isLoading, setLoading] = useState(nativeEnabled);
  const [isRefreshing, setRefreshing] = useState(false);
  const [autoScan, setAutoScan] = useState(true);
  const [error, setError] = useState('');
  const [liveStatus, setLiveStatus] = useState('');
  const mountedRef = useRef(false);
  const nativeEnabledRef = useRef(nativeEnabled);
  const onScanRef = useRef(onScan);
  const portsRef = useRef<NativeSerialPort[]>([]);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const requestIdRef = useRef(0);
  const hasSuccessfulScanRef = useRef(false);

  useEffect(() => {
    nativeEnabledRef.current = nativeEnabled;
    onScanRef.current = onScan;
  }, [nativeEnabled, onScan]);

  const scan = useCallback(async (source: 'auto' | 'manual' | 'initial' = 'manual') => {
    if (!mountedRef.current || !nativeEnabledRef.current) return;
    if (inFlightRef.current) {
      if (source === 'manual') setLiveStatus('A port scan is already in progress.');
      return inFlightRef.current;
    }

    const requestId = ++requestIdRef.current;
    if (source === 'manual') setRefreshing(true);
    if (source !== 'initial') setLiveStatus(source === 'auto' ? 'Checking connected serial devices…' : 'Scanning connected serial devices…');

    const request = (async () => {
      try {
        const found = await onScanRef.current();
        if (!mountedRef.current || !nativeEnabledRef.current || requestId !== requestIdRef.current) return;

        const announcement = hasSuccessfulScanRef.current ? changeAnnouncement(portsRef.current, found) : '';
        portsRef.current = found;
        hasSuccessfulScanRef.current = true;
        setPorts(found);
        setError('');
        if (announcement) setLiveStatus(announcement);
        else if (source === 'manual') setLiveStatus(`${found.length} serial port${found.length === 1 ? '' : 's'} detected.`);
      } catch (reason) {
        if (!mountedRef.current || !nativeEnabledRef.current || requestId !== requestIdRef.current) return;
        const message = reason instanceof Error ? reason.message : 'Could not scan serial ports.';
        setError(message);
        setLiveStatus('Port scan failed. The last successful device list is still shown.');
      } finally {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setLoading(false);
          if (source === 'manual') setRefreshing(false);
        }
      }
    })();

    inFlightRef.current = request;
    try {
      await request;
    } finally {
      if (inFlightRef.current === request) inFlightRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!nativeEnabled) {
      setLoading(false);
      return () => {
        mountedRef.current = false;
        requestIdRef.current += 1;
      };
    }

    const scanNow = () => void scan('initial');
    scanNow();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      inFlightRef.current = null;
    };
  }, [nativeEnabled, scan]);

  useEffect(() => {
    if (!nativeEnabled || !autoScan) return undefined;

    const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const handleVisibilityChange = () => {
      if (isVisible()) void scan('auto');
    };
    if (isVisible()) void scan('auto');
    const timer = window.setInterval(() => {
      if (isVisible()) void scan('auto');
    }, AUTO_SCAN_INTERVAL_MS);

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [autoScan, nativeEnabled, scan]);

  if (!nativeEnabled) {
    return <section className="sd-empty-workspace"><div className="sd-empty-workspace-icon"><Radio size={28} /></div><p>MONITOR READY</p><h1>Open BaudTide desktop to detect devices.</h1><span>Serial-port discovery is available in the desktop app, where BaudTide can inspect local hardware.</span></section>;
  }

  return <section className="sd-port-dashboard" aria-label="Detected serial ports">
    <header className="sd-port-dashboard-header"><div><p>DEVICE DISCOVERY</p><h1>Connect a device</h1><span>Detected local serial ports are ready to configure in a live terminal.</span></div><div><button className="sd-secondary-button" type="button" onClick={() => void scan('manual')} aria-busy={isRefreshing}><RefreshCw className={isRefreshing ? 'sd-spin' : ''} size={16} /> {isRefreshing ? 'Scanning…' : 'Scan again'}</button><button className="sd-primary-button" type="button" onClick={onRequestConnection}><Radio size={16} /> Manual connection</button></div></header>
    <div className="sd-auto-scan-control"><label><input type="checkbox" checked={autoScan} onChange={(event) => setAutoScan(event.target.checked)} /> <span>Auto scan</span></label><span>Checks every 15 seconds while this tab is visible.</span></div>
    <p className="sd-port-dashboard-live-status" role="status" aria-live="polite" aria-atomic="true">{liveStatus}</p>
    {error && <div className="sd-port-dashboard-alert" role="alert"><AlertCircle size={16} /> <span><strong>Scan issue.</strong> {error} {hasSuccessfulScanRef.current ? 'Showing the last successful device list.' : ''}</span></div>}
    <section className="sd-port-dashboard-summary"><span><Radio size={17} /></span><div><strong>{isLoading ? 'Scanning local serial ports…' : `${ports.length} serial port${ports.length === 1 ? '' : 's'} detected`}</strong><p>Connect opens the terminal setup with that port already selected.</p></div></section>
    {isLoading ? <div className="sd-port-dashboard-loading"><LoaderCircle className="sd-spin" size={22} /> Looking for serial devices…</div>
      : ports.length ? <div className="sd-port-list" role="list">{ports.map((port) => <article className="sd-port-row" role="listitem" key={port.path}><div className={`sd-port-icon ${port.transport}`}><PortIcon transport={port.transport} /></div><div className="sd-port-primary"><strong>{port.label || 'Serial device'}</strong><code>{port.path}</code></div><div className="sd-port-details"><span>{displayDetails(port)}</span>{port.serialNumber && <small>Serial {port.serialNumber}</small>}</div><span className="sd-port-transport">{port.transport}</span><button className="sd-secondary-button" type="button" onClick={() => onConnect(port)}>Connect <ChevronRight size={15} /></button></article>)}</div>
        : <section className="sd-port-dashboard-empty"><div><Usb size={25} /></div><h2>No serial ports are detected.</h2><p>Connect a device, then scan again. You can still enter a port path manually if needed.</p><button className="sd-secondary-button" type="button" onClick={onRequestConnection}>Enter a port manually</button></section>}
  </section>;
}
