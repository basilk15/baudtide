import { useEffect, useState } from 'react';
import { AlertCircle, Bluetooth, ChevronRight, Cpu, LoaderCircle, Radio, RefreshCw, Usb } from 'lucide-react';
import type { NativeSerialPort } from '../lib/serial';
import './port-discovery-dashboard.css';

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

export function PortDiscoveryDashboard({ nativeEnabled, onScan, onConnect, onRequestConnection }: PortDiscoveryDashboardProps) {
  const [ports, setPorts] = useState<NativeSerialPort[]>([]);
  const [isLoading, setLoading] = useState(nativeEnabled);
  const [isRefreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const scan = async (withSpinner = true) => {
    if (!nativeEnabled) return;
    if (withSpinner) setRefreshing(true);
    try {
      const found = await onScan();
      setPorts(found);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not scan serial ports.');
    } finally {
      setLoading(false);
      if (withSpinner) setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!nativeEnabled) {
      setLoading(false);
      return undefined;
    }
    void scan(false);
    return undefined;
    // Scan once whenever Dashboard is entered; refresh remains available for hot-plugged devices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeEnabled]);

  if (!nativeEnabled) {
    return <section className="sd-empty-workspace"><div className="sd-empty-workspace-icon"><Radio size={28} /></div><p>MONITOR READY</p><h1>Open BaudTide desktop to detect devices.</h1><span>Serial-port discovery is available in the desktop app, where BaudTide can inspect local hardware.</span></section>;
  }

  return <section className="sd-port-dashboard" aria-label="Detected serial ports">
    <header className="sd-port-dashboard-header"><div><p>DEVICE DISCOVERY</p><h1>Connect a device</h1><span>Detected local serial ports are ready to configure in a live terminal.</span></div><div><button className="sd-secondary-button" type="button" onClick={() => void scan()} disabled={isRefreshing}><RefreshCw className={isRefreshing ? 'sd-spin' : ''} size={16} /> Scan again</button><button className="sd-primary-button" type="button" onClick={onRequestConnection}><Radio size={16} /> Manual connection</button></div></header>
    {error && <div className="sd-port-dashboard-alert" role="alert"><AlertCircle size={16} /> {error}</div>}
    <section className="sd-port-dashboard-summary"><span><Radio size={17} /></span><div><strong>{isLoading ? 'Scanning local serial ports…' : `${ports.length} serial port${ports.length === 1 ? '' : 's'} detected`}</strong><p>Connect opens the terminal setup with that port already selected.</p></div></section>
    {isLoading ? <div className="sd-port-dashboard-loading"><LoaderCircle className="sd-spin" size={22} /> Looking for serial devices…</div>
      : ports.length ? <div className="sd-port-list" role="list">{ports.map((port) => <article className="sd-port-row" role="listitem" key={port.path}><div className={`sd-port-icon ${port.transport}`}><PortIcon transport={port.transport} /></div><div className="sd-port-primary"><strong>{port.label || 'Serial device'}</strong><code>{port.path}</code></div><div className="sd-port-details"><span>{displayDetails(port)}</span>{port.serialNumber && <small>Serial {port.serialNumber}</small>}</div><span className="sd-port-transport">{port.transport}</span><button className="sd-secondary-button" type="button" onClick={() => onConnect(port)}>Connect <ChevronRight size={15} /></button></article>)}</div>
        : <section className="sd-port-dashboard-empty"><div><Usb size={25} /></div><h2>No serial ports are detected.</h2><p>Connect a device, then scan again. You can still enter a port path manually if needed.</p><button className="sd-secondary-button" type="button" onClick={onRequestConnection}>Enter a port manually</button></section>}
  </section>;
}
