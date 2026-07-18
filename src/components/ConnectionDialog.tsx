import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AlertCircle, CheckCircle2, LoaderCircle, Radio, RefreshCw, ShieldAlert, Usb, X } from 'lucide-react';
import { ThemedSelect } from './ThemedSelect';
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
};

const baudRates = [300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 31250, 38400, 57600, 74880, 115200, 230400, 250000, 460800, 500000, 921600, 1_000_000, 2_000_000];
const emptyPorts: SerialPortOption[] = [];

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
  const [sessionName, setSessionName] = useState(initialSessionName || nameForPort(initialPort ?? initialPorts[0]?.path ?? '', initialPorts));
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
    setSessionName(initialSessionName || nameForPort(initialPort ?? initialPorts[0]?.path ?? '', initialPorts));
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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    const nextErrors: typeof errors = {};
    if (!port.trim()) nextErrors.port = 'Enter a serial-port path.';
    const numericBaud = Number(baudRate);
    if (!Number.isInteger(numericBaud) || numericBaud < 300 || numericBaud > 4000000) nextErrors.baudRate = 'Use a baud rate between 300 and 4,000,000.';
    if (!sessionName.trim()) nextErrors.sessionName = 'Give this session a name.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    setSubmitting(true);
    setSubmitError('');
    try {
      await onStartMonitoring({ port: port.trim(), baudRate: numericBaud, sessionName: sessionName.trim(), manualPort });
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
        <p id={descriptionId} className="sd-dialog-subtitle">{nativeEnabled ? 'Choose a port and name the session. SignalDeck will open it and start a raw local log immediately.' : 'Choose a port, name the session, and start monitoring. This browser preview does not open devices.'}</p>

        <form onSubmit={submit} noValidate>
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
