import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AlertCircle, CheckCircle2, LoaderCircle, Radio, RefreshCw, ShieldAlert, Usb, X } from 'lucide-react';
import { ThemedSelect } from './ThemedSelect';
import { defaultSerialConnectionSettings, type SerialConnectionSettings } from '../lib/serial';
import { loadRecentConnections, saveRecentConnection, type RecentConnection } from '../lib/recentConnections';
import './connection-dialog.css';

export type SerialPortOption = {
  path: string;
  label?: string;
  manufacturer?: string;
};

export type PortScanState = 'idle' | 'loading' | 'ready' | 'empty' | 'permission-denied' | 'error';

export type ConnectionRequest = {
  port: string;
  baudRate: number;
  sessionName: string;
  manualPort: boolean;
  settings: SerialConnectionSettings;
};

export type ConnectionDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onStartMonitoring: (request: ConnectionRequest) => void | Promise<void>;
  /** Replace this callback with native port discovery when the backend arrives. */
  onScan?: () => Promise<SerialPortOption[]>;
  initialPorts?: SerialPortOption[];
  initialPort?: string;
  initialBaudRate?: number;
  initialSessionName?: string;
  /** Makes every UI scan state easy to exercise without a backend. */
  initialScanState?: PortScanState;
  nativeEnabled?: boolean;
  /** Ports with an open terminal; duplicate connections would otherwise orphan a tab. */
  activePorts?: string[];
};

const baudRates = [300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 31250, 38400, 57600, 74880, 115200, 230400, 250000, 460800, 500000, 921600, 1_000_000, 2_000_000];
const emptyPorts: SerialPortOption[] = [];
const noActivePorts: string[] = [];

function nameForPort(port: string, ports: SerialPortOption[]) {
  return ports.find((item) => item.path === port)?.label ?? '';
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return 'Unknown error.'; }
}

export function ConnectionDialog({
  isOpen,
  onClose,
  onStartMonitoring,
  onScan,
  initialPorts = emptyPorts,
  initialPort,
  initialBaudRate = 115200,
  initialSessionName = '',
  initialScanState = 'ready',
  nativeEnabled = false,
  activePorts = noActivePorts,
}: ConnectionDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const sessionNameRef = useRef<HTMLInputElement>(null);
  const [ports, setPorts] = useState(initialPorts);
  const [scanState, setScanState] = useState<PortScanState>(initialScanState);
  const [port, setPort] = useState(initialPort ?? initialPorts[0]?.path ?? '');
  const [manualPort, setManualPort] = useState(false);
  const [baudRate, setBaudRate] = useState(String(initialBaudRate));
  const [customBaud, setCustomBaud] = useState(!baudRates.includes(initialBaudRate));
  const [settings, setSettings] = useState<SerialConnectionSettings>(defaultSerialConnectionSettings);
  const [sessionName, setSessionName] = useState(initialSessionName || nameForPort(initialPort ?? initialPorts[0]?.path ?? '', initialPorts));
  const [recentConnections, setRecentConnections] = useState<RecentConnection[]>([]);
  const [errors, setErrors] = useState<{ port?: string; baudRate?: string; sessionName?: string }>({});
  const [isSubmitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setPorts(initialPorts);
    setScanState(initialScanState);
    setPort(initialPort ?? initialPorts[0]?.path ?? '');
    setManualPort(false);
    setBaudRate(String(initialBaudRate));
    setCustomBaud(!baudRates.includes(initialBaudRate));
    setSettings(defaultSerialConnectionSettings);
    setSessionName(initialSessionName || nameForPort(initialPort ?? initialPorts[0]?.path ?? '', initialPorts));
    setRecentConnections(loadRecentConnections());
    setErrors({});
    setSubmitError('');
    setSubmitting(false);
    window.setTimeout(() => sessionNameRef.current?.focus(), 0);
  }, [isOpen, initialPorts, initialPort, initialBaudRate, initialSessionName, initialScanState]);

  useEffect(() => {
    if (isOpen && onScan) void scanPorts();
  }, [isOpen, onScan]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const trapFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  async function scanPorts() {
    if (scanState === 'loading') return;
    setScanState('loading');
    setSubmitError('');
    try {
      const found = onScan ? await onScan() : [];
      setPorts(found);
      setScanState(found.length ? 'ready' : 'empty');
      if (found.length && !found.some((item) => item.path === port)) {
        setPort(found[0].path);
        if (!sessionName) setSessionName(nameForPort(found[0].path, found));
      }
    } catch (error) {
      const message = errorMessage(error);
      setScanState(/permission|access|denied/i.test(message) ? 'permission-denied' : 'error');
      setSubmitError(`Could not scan serial ports: ${message}`);
    }
  }

  const selectPort = (nextPort: string) => {
    setPort(nextPort);
    setManualPort(false);
    setErrors((current) => ({ ...current, port: undefined }));
    if (!sessionName.trim()) setSessionName(nameForPort(nextPort, ports));
  };

  const applyRecentConnection = (recent: RecentConnection) => {
    setPort(recent.port);
    setManualPort(!ports.some((item) => item.path === recent.port));
    setBaudRate(String(recent.baudRate));
    setCustomBaud(!baudRates.includes(recent.baudRate));
    setSettings(recent.settings);
    setSessionName(recent.sessionName);
    setErrors({});
    setSubmitError('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    const nextErrors: typeof errors = {};
    if (!port.trim()) nextErrors.port = 'Enter a serial-port path.';
    else if (activePorts.includes(port.trim())) nextErrors.port = `${port.trim()} is already open in a BaudTide terminal.`;
    const numericBaud = Number(baudRate);
    if (!Number.isInteger(numericBaud) || numericBaud < 300 || numericBaud > 4000000) nextErrors.baudRate = 'Use a baud rate between 300 and 4,000,000.';
    if (!sessionName.trim()) nextErrors.sessionName = 'Give this session a name.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    setSubmitting(true);
    setSubmitError('');
    try {
      const request = { port: port.trim(), baudRate: numericBaud, sessionName: sessionName.trim(), manualPort, settings };
      await onStartMonitoring(request);
      saveRecentConnection(request);
      setRecentConnections(loadRecentConnections());
    } catch (error) {
      setSubmitError(errorMessage(error));
      setSubmitting(false);
    }
  };

  const scanNotice = {
    idle: null,
    loading: <div className="sd-scan-notice loading"><LoaderCircle className="sd-spin" size={16} /> Looking for connected serial ports…</div>,
    ready: ports.length ? <div className="sd-scan-notice success"><CheckCircle2 size={16} /> {ports.length} port{ports.length === 1 ? '' : 's'} found. Select one or enter a path manually.</div> : null,
    empty: <div className="sd-scan-notice warning"><Usb size={16} /> No serial ports found. Connect a device, or enter its path manually.</div>,
    'permission-denied': <div className="sd-scan-notice danger"><ShieldAlert size={16} /> Permission to inspect serial ports was denied. Check your Linux device permissions.</div>,
    error: <div className="sd-scan-notice danger"><AlertCircle size={16} /> Port discovery failed. You can retry or enter a path manually.</div>,
  }[scanState];

  return (
    <div className="sd-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="sd-connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={trapFocus}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="sd-dialog-close" type="button" onClick={onClose} aria-label="Close connection dialog"><X size={18} /></button>
        <div className="sd-dialog-icon"><Radio size={21} /></div>
        <p className="sd-dialog-eyebrow">NEW LIVE TERMINAL</p>
        <h2 id={titleId}>Connect a device</h2>
        <p id={descriptionId} className="sd-dialog-subtitle">{nativeEnabled ? 'Choose a port and name the session. BaudTide will open it and start a raw local log immediately.' : 'Choose a port, name the session, and start monitoring. This browser preview does not open devices.'}</p>

        <form onSubmit={submit} noValidate>
          {recentConnections.length > 0 && <section className="sd-recent-connections" aria-label="Recent connection settings">
            <div><strong>Recent settings</strong><span>Reuse a successful device setup.</span></div>
            <div className="sd-recent-connection-list">
              {recentConnections.map((recent) => <button key={`${recent.sessionName}-${recent.port}-${recent.baudRate}-${recent.settings.dataBits}-${recent.settings.parity}-${recent.settings.stopBits}-${recent.settings.flowControl}`} type="button" onClick={() => applyRecentConnection(recent)} title={`Use ${recent.sessionName} settings`}>
                <strong>{recent.sessionName}</strong><span>{recent.port} · {recent.baudRate.toLocaleString()} baud · {recent.settings.dataBits}{recent.settings.parity === 'none' ? 'N' : recent.settings.parity === 'odd' ? 'O' : 'E'}{recent.settings.stopBits === 'one' ? '1' : '2'}</span>
              </button>)}
            </div>
          </section>}
          <div className="sd-dialog-scan-row">
            <span>Available ports</span>
            <button className="sd-link-button" type="button" onClick={scanPorts} disabled={scanState === 'loading'}>
              {scanState === 'loading' ? <LoaderCircle className="sd-spin" size={14} /> : <RefreshCw size={14} />} Scan again
            </button>
          </div>
          {scanNotice}

          <div className="sd-form-grid">
            <label className="sd-form-field sd-full-width">Port
              <ThemedSelect label="Serial port" value={manualPort ? '__manual__' : port} placeholder="Enter a port path manually…" invalid={Boolean(errors.port)} onChange={(value) => value === '__manual__' ? setManualPort(true) : selectPort(value)} options={[...ports.map((item) => ({ value: item.path, label: `${item.path}${item.label ? ` · ${item.label}` : ''}` })), { value: '__manual__', label: 'Enter a port path manually…' }]} />
              {errors.port && <small className="sd-field-error">{errors.port}</small>}
            </label>
            {manualPort && <label className="sd-form-field sd-full-width">Manual port path
              <input autoComplete="off" value={port} onChange={(event) => { setPort(event.target.value); setErrors((current) => ({ ...current, port: undefined })); }} placeholder="e.g. /dev/ttyUSB0" aria-invalid={Boolean(errors.port)} />
            </label>}
            <label className="sd-form-field">Baud rate
              <ThemedSelect label="Baud rate" value={customBaud ? '__custom__' : baudRate} placeholder="Select a baud rate" invalid={Boolean(errors.baudRate)} onChange={(value) => {
                if (value === '__custom__') { setCustomBaud(true); setBaudRate(''); } else { setCustomBaud(false); setBaudRate(value); }
                setErrors((current) => ({ ...current, baudRate: undefined }));
              }} options={[...baudRates.map((rate) => ({ value: String(rate), label: `${rate.toLocaleString()} baud` })), { value: '__custom__', label: 'Custom baud rate…' }]} />
              {customBaud && <input inputMode="numeric" value={baudRate} onChange={(event) => { setBaudRate(event.target.value); setErrors((current) => ({ ...current, baudRate: undefined })); }} placeholder="Enter a baud rate" aria-invalid={Boolean(errors.baudRate)} />}
              {errors.baudRate && <small className="sd-field-error">{errors.baudRate}</small>}
            </label>
            <label className="sd-form-field">Session name
              <input ref={sessionNameRef} autoComplete="off" value={sessionName} onChange={(event) => { setSessionName(event.target.value); setErrors((current) => ({ ...current, sessionName: undefined })); }} placeholder="e.g. Main controller" aria-invalid={Boolean(errors.sessionName)} />
              {errors.sessionName && <small className="sd-field-error">{errors.sessionName}</small>}
            </label>
            <fieldset className="sd-serial-settings sd-full-width">
              <legend>Serial framing</legend>
              <p>Use your device's documented framing and flow-control settings. Defaults are 8N1 with no flow control.</p>
              <div className="sd-serial-settings-grid">
                <label>Data bits
                  <ThemedSelect label="Data bits" value={String(settings.dataBits)} placeholder="Select data bits" onChange={(value) => setSettings((current) => ({ ...current, dataBits: Number(value) as SerialConnectionSettings['dataBits'] }))} options={[5, 6, 7, 8].map((value) => ({ value: String(value), label: String(value) }))} />
                </label>
                <label>Parity
                  <ThemedSelect label="Parity" value={settings.parity} placeholder="Select parity" onChange={(value) => setSettings((current) => ({ ...current, parity: value as SerialConnectionSettings['parity'] }))} options={[{ value: 'none', label: 'None' }, { value: 'odd', label: 'Odd' }, { value: 'even', label: 'Even' }]} />
                </label>
                <label>Stop bits
                  <ThemedSelect label="Stop bits" value={settings.stopBits} placeholder="Select stop bits" onChange={(value) => setSettings((current) => ({ ...current, stopBits: value as SerialConnectionSettings['stopBits'] }))} options={[{ value: 'one', label: '1' }, { value: 'two', label: '2' }]} />
                </label>
                <label>Flow control
                  <ThemedSelect label="Flow control" value={settings.flowControl} placeholder="Select flow control" onChange={(value) => setSettings((current) => ({ ...current, flowControl: value as SerialConnectionSettings['flowControl'] }))} options={[{ value: 'none', label: 'None' }, { value: 'software', label: 'Software (XON/XOFF)' }, { value: 'hardware', label: 'Hardware (RTS/CTS)' }]} />
                </label>
              </div>
            </fieldset>
          </div>
          {submitError && <div className="sd-submit-error" role="alert"><AlertCircle size={15} />{submitError}</div>}
          <div className="sd-dialog-actions">
            <button className="sd-secondary-button" type="button" onClick={onClose}>Cancel</button>
            <button className="sd-primary-button" type="submit" disabled={isSubmitting || scanState === 'loading'}>
              {isSubmitting ? <LoaderCircle className="sd-spin" size={16} /> : <Radio size={16} />} {isSubmitting ? 'Starting…' : 'Start monitoring'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
