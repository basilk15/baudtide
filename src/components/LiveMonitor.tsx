import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, Check, ChevronsDown, CirclePause, CirclePlay, Eraser, LoaderCircle, PlugZap, RotateCw, Send, TerminalSquare, WifiOff, X } from 'lucide-react';
import { listenForSerialData, listenForSerialStatus, type SerialDataEvent } from '../lib/serial';
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
  sessionId?: string;
  nativeSession?: boolean;
};

function currentTimestamp() {
  const now = new Date();
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function timestampForEvent(event: SerialDataEvent) {
  const date = new Date(event.timestamp);
  return Number.isNaN(date.getTime()) ? currentTimestamp() : `${date.toTimeString().slice(0, 8)}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function LiveMonitor({
  sessionName,
  port,
  baudRate,
  initialLines,
  initialConnectionState = 'connected',
  onSend,
  onReconnect,
  onDisconnect,
  onClear,
  onClose,
  sessionId,
  nativeSession = false,
}: LiveMonitorProps) {
  const [connectionState, setConnectionState] = useState<MonitorConnectionState>(nativeSession ? initialConnectionState : 'disconnected');
  const [lines, setLines] = useState<MonitorLine[]>(initialLines ?? []);
  const [isPaused, setPaused] = useState(false);
  const [pausedLines, setPausedLines] = useState<MonitorLine[]>([]);
  const [waitingLines, setWaitingLines] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [outgoing, setOutgoing] = useState('');
  const [isSending, setSending] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [isReconnecting, setReconnecting] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const pendingTextRef = useRef('');
  const lineIdRef = useRef(0);
  const pausedRef = useRef(false);
  const queuedLinesRef = useRef<MonitorLine[]>([]);
  const renderFrameRef = useRef<number | null>(null);

  const visibleLines = useMemo(() => isPaused ? pausedLines : lines, [isPaused, lines, pausedLines]);

  const queueLinesForDisplay = (nextLines: MonitorLine[]) => {
    if (!nextLines.length) return;
    queuedLinesRef.current.push(...nextLines);
    if (renderFrameRef.current !== null) return;
    renderFrameRef.current = window.requestAnimationFrame(() => {
      const batch = queuedLinesRef.current.splice(0);
      renderFrameRef.current = null;
      if (!batch.length) return;
      if (pausedRef.current) setWaitingLines((count) => count + batch.length);
      setLines((current) => [...current, ...batch].slice(-500));
    });
  };

  useEffect(() => {
    if (nativeSession && sessionId) {
      let unlistenData: (() => void) | undefined;
      let unlistenStatus: (() => void) | undefined;
      let disposed = false;
      pendingTextRef.current = '';
      void Promise.all([
        listenForSerialData(sessionId, (event: SerialDataEvent) => {
          // Serial reads arrive in arbitrary byte chunks, not necessarily complete lines.
          // Retain the unfinished tail so the display matches Arduino-style line output.
          const combined = `${pendingTextRef.current}${event.text}`;
          const hasTrailingCarriageReturn = combined.endsWith('\r');
          const completeCandidate = hasTrailingCarriageReturn ? combined.slice(0, -1) : combined;
          const parts = completeCandidate.replace(/\r\n|\r/g, '\n').split('\n');
          const unfinishedTail = `${parts.pop() ?? ''}${hasTrailingCarriageReturn ? '\r' : ''}`;
          pendingTextRef.current = unfinishedTail.slice(-64 * 1024);
          const timestamp = timestampForEvent(event);
          queueLinesForDisplay(parts.map((text) => ({
            id: `${event.sessionId}-${++lineIdRef.current}`,
            timestamp,
            text,
            kind: 'data',
          })));
        }),
        listenForSerialStatus(sessionId, (event) => {
          if (event.status === 'error') setConnectionState('error');
          if (event.status === 'disconnected') setConnectionState('disconnected');
          if (event.status === 'connected') setConnectionState('connected');
        }),
      ]).then(([data, status]) => {
        if (disposed) {
          data();
          status();
          return;
        }
        unlistenData = data;
        unlistenStatus = status;
      }).catch(() => {
        if (!disposed) setConnectionState('error');
      });
      return () => {
        disposed = true;
        unlistenData?.();
        unlistenStatus?.();
      };
    }
    return undefined;
  }, [nativeSession, sessionId]);

  useEffect(() => () => {
    if (renderFrameRef.current !== null) window.cancelAnimationFrame(renderFrameRef.current);
  }, []);

  useEffect(() => {
    if (nativeSession && sessionId) setConnectionState('connected');
  }, [nativeSession, sessionId]);

  useEffect(() => {
    if (!isPaused && autoScroll && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [visibleLines, isPaused, autoScroll]);

  const toggleDisplayPause = () => {
    if (isPaused) {
      pausedRef.current = false;
      setPaused(false);
      setPausedLines([]);
      setWaitingLines(0);
      return;
    }
    pausedRef.current = true;
    setPausedLines(lines);
    setWaitingLines(0);
    setPaused(true);
  };

  const goToEnd = () => {
    pausedRef.current = false;
    setPaused(false);
    setPausedLines([]);
    setWaitingLines(0);
    setAutoScroll(true);
    window.requestAnimationFrame(() => {
      if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
    });
  };

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
    pendingTextRef.current = '';
    queuedLinesRef.current = [];
    setLines([]);
    if (isPaused) setPausedLines([]);
    setWaitingLines(0);
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
          <div><p className="sd-monitor-breadcrumb">Live terminal / Monitor</p><h1>{sessionName}</h1></div>
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
          <div className="sd-terminal-title"><span className="sd-terminal-led" /> Incoming data <em>{lines.length} lines in display</em></div>
          <div className="sd-terminal-controls">
            <label className="sd-autoscroll-toggle"><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} /> Auto-scroll</label>
            {(!autoScroll || isPaused) && <button className="sd-monitor-secondary sd-go-to-end" type="button" onClick={goToEnd} title="Resume the display and jump to the newest data"><ChevronsDown size={15} /> Go to end</button>}
            <button className={`sd-monitor-secondary ${isPaused ? 'active' : ''}`} type="button" onClick={toggleDisplayPause}>{isPaused ? <CirclePlay size={15} /> : <CirclePause size={15} />}{isPaused ? 'Resume display' : 'Pause display'}</button>
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
          {isPaused && <div className="sd-paused-note"><CirclePause size={15} /> Display paused. {waitingLines} {waitingLines === 1 ? 'new line is' : 'new lines are'} waiting.</div>}
        </div>
        <form className="sd-send-form" onSubmit={send}>
          <label htmlFor="sd-send-text">Send text</label>
          <div><input id="sd-send-text" value={outgoing} onChange={(event) => setOutgoing(event.target.value)} placeholder={connectionState === 'connected' ? 'Type a command…' : 'Reconnect to send a command'} disabled={connectionState !== 'connected'} /><button className="sd-primary-button" type="submit" disabled={!outgoing.trim() || isSending || connectionState !== 'connected'}>{isSending ? <LoaderCircle className="sd-spin" size={16} /> : <Send size={16} />} Send</button></div>
          <span>{nativeSession ? 'Enter sends · raw capture stays active while display is paused' : 'Enter sends · Browser preview only'}</span>
        </form>
      </article>

      {showClearConfirm && <div className="sd-inline-confirm" role="alertdialog" aria-label="Confirm clear display"><div><AlertTriangle size={18} /><p><strong>Clear this display?</strong><span>This only clears the visible panel. The session log is unaffected.</span></p></div><div><button className="sd-monitor-secondary" type="button" onClick={() => setShowClearConfirm(false)}>Cancel</button><button className="sd-monitor-danger-button" type="button" onClick={clear}>Clear</button></div></div>}
      {showDisconnectConfirm && <div className="sd-inline-confirm" role="alertdialog" aria-label="Confirm disconnect"><div><PlugZap size={18} /><p><strong>Disconnect {sessionName}?</strong><span>The local log will be retained, but incoming data will stop.</span></p></div><div><button className="sd-monitor-secondary" type="button" onClick={() => setShowDisconnectConfirm(false)}>Cancel</button><button className="sd-monitor-danger-button" type="button" onClick={disconnect}>Disconnect</button></div></div>}
    </section>
  );
}
