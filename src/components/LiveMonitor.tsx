import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, Check, ChevronDown, CirclePause, CirclePlay, Copy, Eraser, LoaderCircle, PlugZap, RotateCw, Send, TerminalSquare, WifiOff, X } from 'lucide-react';
import './live-monitor.css';

export type MonitorConnectionState = 'connected' | 'reconnecting' | 'disconnected' | 'error';

export type MonitorLine = {
  id: string;
  timestamp: string;
  text: string;
  kind?: 'data' | 'system' | 'error';
};

export type LiveMonitorProps = {
  sessionName: string;
  port: string;
  baudRate: number;
  initialLines?: MonitorLine[];
  initialConnectionState?: MonitorConnectionState;
  onSend?: (text: string) => void | Promise<void>;
  onReconnect?: () => void | Promise<void>;
  onDisconnect?: () => void | Promise<void>;
  onClear?: () => void;
  onClose?: () => void;
};

const seedLines: MonitorLine[] = [
  { id: 'boot', timestamp: '14:32:01.008', text: 'ESP-ROM:esp32c3-api1-20210207', kind: 'system' },
  { id: 'init', timestamp: '14:32:01.081', text: 'SignalDeck demo device booted · firmware v0.4.2', kind: 'system' },
  { id: 'sensor-1', timestamp: '14:32:02.010', text: 'sensor.temp=24.61°C sensor.humidity=43.2%', kind: 'data' },
  { id: 'sensor-2', timestamp: '14:32:03.010', text: 'sensor.temp=24.60°C sensor.humidity=43.1%', kind: 'data' },
  { id: 'ready', timestamp: '14:32:03.117', text: 'ready; listening for commands', kind: 'system' },
];

function currentTimestamp() {
  const now = new Date();
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function mockDataLine(index: number): MonitorLine {
  const temperature = (24.4 + Math.sin(index / 4) * 0.35).toFixed(2);
  const humidity = (43 + Math.cos(index / 5) * 0.7).toFixed(1);
  return { id: `mock-${Date.now()}-${index}`, timestamp: currentTimestamp(), text: `sensor.temp=${temperature}°C sensor.humidity=${humidity}% packet=${String(index).padStart(4, '0')}`, kind: 'data' };
}

export function LiveMonitor({
  sessionName,
  port,
  baudRate,
  initialLines = seedLines,
  initialConnectionState = 'connected',
  onSend,
  onReconnect,
  onDisconnect,
  onClear,
  onClose,
}: LiveMonitorProps) {
  const [connectionState, setConnectionState] = useState<MonitorConnectionState>(initialConnectionState);
  const [lines, setLines] = useState(initialLines);
  const [isPaused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [outgoing, setOutgoing] = useState('');
  const [isSending, setSending] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [isReconnecting, setReconnecting] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const lineCounter = useRef(0);

  const visibleLines = useMemo(() => isPaused ? lines.slice(0, Math.max(0, lines.length - 1)) : lines, [isPaused, lines]);

  // Intentional UI-only stream: logging state keeps receiving lines even while display is paused.
  useEffect(() => {
    if (connectionState !== 'connected') return;
    const stream = window.setInterval(() => {
      lineCounter.current += 1;
      setLines((current) => [...current.slice(-499), mockDataLine(lineCounter.current)]);
    }, 1550);
    return () => window.clearInterval(stream);
  }, [connectionState]);

  useEffect(() => {
    if (!isPaused && autoScroll) outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'smooth' });
  }, [visibleLines, isPaused, autoScroll]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = outgoing.trim();
    if (!text || isSending || connectionState !== 'connected') return;
    setSending(true);
    try {
      await onSend?.(text);
      setLines((current) => [...current, { id: `sent-${Date.now()}`, timestamp: currentTimestamp(), text: `> ${text}`, kind: 'system' }]);
      setOutgoing('');
    } finally {
      setSending(false);
    }
  };

  const reconnect = async () => {
    setReconnecting(true);
    setConnectionState('reconnecting');
    try {
      await onReconnect?.();
      if (!onReconnect) await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
      setConnectionState('connected');
      setLines((current) => [...current, { id: `reconnected-${Date.now()}`, timestamp: currentTimestamp(), text: 'Connection restored. Logging resumed.', kind: 'system' }]);
    } catch {
      setConnectionState('error');
    } finally {
      setReconnecting(false);
    }
  };

  const disconnect = async () => {
    await onDisconnect?.();
    setConnectionState('disconnected');
    setShowDisconnectConfirm(false);
    setLines((current) => [...current, { id: `disconnect-${Date.now()}`, timestamp: currentTimestamp(), text: 'Disconnected by user. Local log remains available.', kind: 'system' }]);
  };

  const clear = () => {
    setLines([]);
    setShowClearConfirm(false);
    onClear?.();
  };

  const connectionCopy = {
    connected: { label: 'Connected', Icon: Check, detail: 'Port open · logging active' },
    reconnecting: { label: 'Reconnecting', Icon: LoaderCircle, detail: 'Trying to restore the port…' },
    disconnected: { label: 'Disconnected', Icon: WifiOff, detail: 'Logging is stopped' },
    error: { label: 'Connection error', Icon: AlertTriangle, detail: 'The serial port could not be opened' },
  }[connectionState];
  const StatusIcon = connectionCopy.Icon;

  return (
    <section className="sd-monitor" aria-label={`${sessionName} live serial monitor`}>
      <header className="sd-monitor-header">
        <div className="sd-monitor-heading">
          <div className="sd-monitor-mark"><TerminalSquare size={19} /></div>
          <div><p className="sd-monitor-breadcrumb">Sessions / Live monitor</p><h1>{sessionName}</h1></div>
        </div>
        <div className="sd-monitor-header-actions">
          <button type="button" className="sd-monitor-secondary" onClick={reconnect} disabled={connectionState === 'connected' || isReconnecting}><RotateCw className={isReconnecting ? 'sd-spin' : ''} size={15} /> Reconnect</button>
          <button type="button" className="sd-monitor-danger-button" onClick={() => setShowDisconnectConfirm(true)} disabled={connectionState !== 'connected'}><PlugZap size={15} /> Disconnect</button>
          {onClose && <button className="sd-monitor-icon-button" type="button" onClick={onClose} aria-label="Close session"><X size={18} /></button>}
        </div>
      </header>

      <div className="sd-monitor-meta-row">
        <div className={`sd-monitor-status ${connectionState}`}><StatusIcon className={connectionState === 'reconnecting' ? 'sd-spin' : ''} size={14} /><strong>{connectionCopy.label}</strong><span>{connectionCopy.detail}</span></div>
        <div className="sd-monitor-chip"><span>{port}</span><i /> {baudRate.toLocaleString()} baud</div>
      </div>

      <article className="sd-terminal-card">
        <div className="sd-terminal-toolbar">
          <div className="sd-terminal-title"><span className="sd-terminal-led" /> Incoming data <em>{lines.length} lines logged</em></div>
          <div className="sd-terminal-controls">
            <label className="sd-autoscroll-toggle"><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} /> Auto-scroll</label>
            <button className={`sd-monitor-secondary ${isPaused ? 'active' : ''}`} type="button" onClick={() => setPaused((value) => !value)}>{isPaused ? <CirclePlay size={15} /> : <CirclePause size={15} />}{isPaused ? 'Resume display' : 'Pause display'}</button>
            <button className="sd-monitor-icon-button" type="button" onClick={() => setShowClearConfirm(true)} aria-label="Clear monitor display" title="Clear display"><Eraser size={16} /></button>
          </div>
        </div>
        <div className="sd-terminal-logging"><Check size={13} /> Logging continues independently of this display{isPaused ? <strong> · display paused</strong> : ''}</div>
        <div className="sd-terminal-output" ref={outputRef} onScroll={(event) => {
          const target = event.currentTarget;
          setAutoScroll(target.scrollHeight - target.scrollTop - target.clientHeight < 32);
        }} aria-live={isPaused ? 'off' : 'polite'} aria-label="Timestamped serial output">
          {!visibleLines.length && <div className="sd-terminal-empty"><TerminalSquare size={23} /><strong>Display cleared</strong><span>New incoming bytes will appear here. The active log is still recording.</span></div>}
          {visibleLines.map((line) => <div className={`sd-terminal-line ${line.kind ?? 'data'}`} key={line.id}><time>{line.timestamp}</time><code>{line.text}</code></div>)}
          {isPaused && <div className="sd-paused-note"><CirclePause size={15} /> Display paused. {Math.max(0, lines.length - visibleLines.length)} new line waiting.</div>}
        </div>
        <form className="sd-send-form" onSubmit={send}>
          <label htmlFor="sd-send-text">Send text</label>
          <div><input id="sd-send-text" value={outgoing} onChange={(event) => setOutgoing(event.target.value)} placeholder={connectionState === 'connected' ? 'Type a command…' : 'Reconnect to send a command'} disabled={connectionState !== 'connected'} /><button className="sd-primary-button" type="submit" disabled={!outgoing.trim() || isSending || connectionState !== 'connected'}>{isSending ? <LoaderCircle className="sd-spin" size={16} /> : <Send size={16} />} Send</button></div>
          <span>Enter sends · Mock UI only</span>
        </form>
      </article>

      {showClearConfirm && <div className="sd-inline-confirm" role="alertdialog" aria-label="Confirm clear display"><div><AlertTriangle size={18} /><p><strong>Clear this display?</strong><span>This only clears the visible panel. The session log is unaffected.</span></p></div><div><button className="sd-monitor-secondary" type="button" onClick={() => setShowClearConfirm(false)}>Cancel</button><button className="sd-monitor-danger-button" type="button" onClick={clear}>Clear display</button></div></div>}
      {showDisconnectConfirm && <div className="sd-inline-confirm" role="alertdialog" aria-label="Confirm disconnect"><div><PlugZap size={18} /><p><strong>Disconnect {sessionName}?</strong><span>The local log will be retained, but incoming data will stop.</span></p></div><div><button className="sd-monitor-secondary" type="button" onClick={() => setShowDisconnectConfirm(false)}>Cancel</button><button className="sd-monitor-danger-button" type="button" onClick={disconnect}>Disconnect</button></div></div>}
    </section>
  );
}
