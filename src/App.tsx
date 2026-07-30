import { useEffect, useMemo, useRef, useState } from 'react';
import { CommandPalette, type CommandPaletteAction } from './components/CommandPalette';
import { ConnectionDialog, type ConnectionRequest } from './components/ConnectionDialog';
import { HelpFeedbackPanel } from './components/HelpFeedbackPanel';
import { LiveMonitor, type LiveMonitorHandle, type MonitorConnectionState } from './components/LiveMonitor';
import { NotificationsPanel } from './components/NotificationsPanel';
import { useNotifications } from './components/notifications';
import { PreferencesScreen } from './components/PreferencesScreen';
import { SavedLogsScreen } from './components/SavedLogsScreen';
import { PortDiscoveryDashboard } from './components/PortDiscoveryDashboard';
import { SidebarNavigation } from './components/SidebarNavigation';
import { WelcomeScreen } from './components/WelcomeScreen';
import { WorkspaceProfileMenu } from './components/WorkspaceProfileMenu';
import type { SignalDeckPage } from './components/phase3Types';
import { defaultPreferences, loadPreferences, savePreferences, type BaudTidePreferences, type DisplayEncoding, type LineEnding } from './lib/preferences';
import { Moon, Radio, Sun, TerminalSquare, X } from 'lucide-react';
import './light-theme.css';
import './components/theme-toggle.css';
import {
  disconnectNativeSerialSession,
  chooseNativeLogDirectory,
  isTauriRuntime,
  listActiveNativeSerialSessions,
  listNativeSerialPorts,
  sendNativeSerialBytes,
  sendNativeSerialText,
  startNativeSerialSession,
  type NativeSerialPort,
} from './lib/serial';

const pageNames: Record<SignalDeckPage, string> = {
  dashboard: 'Overview', sessions: 'Live terminal', logs: 'Saved logs', preferences: 'Preferences', help: 'Help & feedback',
};

type LiveSession = ConnectionRequest & {
  /** The serial-session ID returned by the desktop backend, or a preview-only ID. */
  id: string;
  /** Stays stable across a native reconnect, so the terminal display is preserved. */
  uiKey: string;
  native: boolean;
  /** Whether this tab currently owns a native backend session handle. */
  nativeSessionOpen: boolean;
  logPath?: string;
  lineEnding: LineEnding;
  displayEncoding: DisplayEncoding;
  showTimestamps: boolean;
  reconnectWhenDeviceReturns: boolean;
  connectionState: MonitorConnectionState;
};

type LiveSessions = Record<string, LiveSession>;
type AppTheme = 'dark' | 'light';
type AutoReconnectTimer = { timer: number; attempts: number };
const AUTO_RECONNECT_INITIAL_DELAY_MS = 2_000;
const AUTO_RECONNECT_MAX_DELAY_MS = 60_000;

const interactiveShortcutSelector = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="listbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Keep application shortcuts from overriding controls' native keyboard behavior. */
export function isInteractiveShortcutTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(interactiveShortcutSelector));
}

export function shouldIgnoreGlobalShortcut(event: KeyboardEvent) {
  return isInteractiveShortcutTarget(event.target) || isInteractiveShortcutTarget(document.activeElement);
}

const nativeRuntime = isTauriRuntime();

function previewSessionId() {
  return `preview-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function App() {
  const [page, setPage] = useState<SignalDeckPage>('dashboard');
  const [isWelcomeVisible, setWelcomeVisible] = useState(true);
  const [isConnectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionDefaults, setConnectionDefaults] = useState<Pick<ConnectionRequest, 'port' | 'sessionName'> | null>(null);
  const [liveSessions, setLiveSessions] = useState<LiveSessions>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [theme, setTheme] = useState<AppTheme>('dark');
  const [preferences, setPreferences] = useState<BaudTidePreferences>(defaultPreferences);
  // Apply continuous zoom directly to the shell so it never waits for React's
  // render scheduler before a wheel gesture becomes visible.
  const zoomRef = useRef(1);
  const shellRef = useRef<HTMLDivElement>(null);
  const monitorRefs = useRef<Record<string, LiveMonitorHandle | null>>({});
  const autoReconnectTimers = useRef<Record<string, AutoReconnectTimer>>({});
  const autoReconnectAttempts = useRef<Record<string, number>>({});
  const { notifications, publish: publishNotification, markRead, markAllRead } = useNotifications();
  const sessions = Object.values(liveSessions);
  const selectedSession = selectedSessionId ? liveSessions[selectedSessionId] : undefined;

  const openConnectionDialog = (port?: NativeSerialPort) => {
    setConnectionDefaults(port ? { port: port.path, sessionName: port.label } : null);
    setConnectionDialogOpen(true);
  };
  const navigate = (nextPage: SignalDeckPage) => {
    setPage(nextPage);
    if (nextPage !== 'dashboard') setWelcomeVisible(false);
  };
  const selectedMonitor = () => selectedSessionId ? monitorRefs.current[selectedSessionId] : null;
  const commandActions = useMemo<CommandPaletteAction[]>(() => [
    { id: 'new-connection', label: 'New terminal', description: 'Choose a serial port and start monitoring', shortcut: 'N', icon: 'new' },
    { id: 'pause-display', label: 'Pause or resume display', description: selectedSession ? `Toggle the display for ${selectedSession.sessionName}` : 'Select a live terminal first', shortcut: 'Space', icon: 'session', disabled: !selectedSession },
    { id: 'clear-display', label: 'Clear display', description: selectedSession ? `Clear ${selectedSession.sessionName} after confirmation` : 'Select a live terminal first', shortcut: '⌘/Ctrl ⌫', icon: 'session', disabled: !selectedSession },
    { id: 'find-output', label: 'Find in output', description: selectedSession ? `Filter visible output in ${selectedSession.sessionName}` : 'Select a live terminal first', shortcut: '⌘/Ctrl F', icon: 'log', disabled: !selectedSession },
    { id: 'sessions', label: 'Open live terminal', description: 'View active serial terminals', icon: 'session' },
    { id: 'logs', label: 'Open saved logs', description: 'Browse captured serial logs', icon: 'log' },
    { id: 'preferences', label: 'Open preferences', description: 'Configure application defaults', icon: 'preferences' },
  ], [selectedSession]);
  const runCommand = (action: CommandPaletteAction) => {
    if (action.id === 'new-connection') openConnectionDialog();
    if (action.id === 'pause-display') { navigate('sessions'); selectedMonitor()?.toggleDisplayPause(); }
    if (action.id === 'clear-display') { navigate('sessions'); selectedMonitor()?.requestClear(); }
    if (action.id === 'find-output') { navigate('sessions'); selectedMonitor()?.focusFind(); }
    if (action.id === 'sessions') navigate('sessions');
    if (action.id === 'logs') navigate('logs');
    if (action.id === 'preferences') navigate('preferences');
  };

  const portIsInUse = (port: string, exceptSessionId?: string) => sessions.some((session) => (
    session.id !== exceptSessionId
    && session.port === port
    && (session.native ? session.nativeSessionOpen : true)
  ));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Start native discovery immediately so surviving readers return to
      // bounded replay mode while preferences load in parallel.
      const recovery = nativeRuntime
        ? listActiveNativeSerialSessions()
            .then((sessions) => ({ sessions }))
            .catch(() => ({ sessions: null }))
        : Promise.resolve({ sessions: [] });
      const saved = await loadPreferences();
      if (cancelled) return;
      setPreferences(saved);
      setTheme(saved.appearance.theme);
      if (!nativeRuntime) return;

      const { sessions: activeSessions } = await recovery;
      if (cancelled) return;
      if (!activeSessions) {
        publishNotification({
          kind: 'error',
          title: 'Terminal recovery failed',
          detail: 'Active desktop sessions could not be restored. Existing raw captures remain available.',
        });
        return;
      }
      if (activeSessions.length) {
        setLiveSessions((current) => {
          const next = { ...current };
          for (const session of activeSessions) {
            // Hydration and a user-created connection can finish in either
            // order. Never duplicate the same native handle or port.
            const alreadyRepresented = next[session.id]
              || Object.values(next).some((candidate) => (
                candidate.native && candidate.nativeSessionOpen && candidate.port === session.port
              ));
            if (alreadyRepresented) continue;
            next[session.id] = {
              id: session.id,
              uiKey: `recovered-${session.id}`,
              port: session.port,
              baudRate: session.baudRate,
              sessionName: session.sessionName,
              manualPort: false,
              settings: session.settings,
              native: true,
              nativeSessionOpen: true,
              logPath: session.logPath,
              lineEnding: saved.serial.lineEnding,
              displayEncoding: saved.serial.displayEncoding,
              showTimestamps: saved.serial.showTimestamps,
              reconnectWhenDeviceReturns: saved.serial.reconnectWhenDeviceReturns,
              connectionState: 'connected',
            };
          }
          return next;
        });
        setSelectedSessionId((current) => current ?? activeSessions[0].id);
        setWelcomeVisible(false);
        setPage('sessions');
        publishNotification({
          kind: 'connection',
          title: activeSessions.length === 1 ? 'Active terminal restored' : 'Active terminals restored',
          detail: `${activeSessions.length} terminal${activeSessions.length === 1 ? '' : 's'} reattached. The raw capture contains any output missed during reload.`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publishNotification]);

  const saveAppPreferences = async (next: BaudTidePreferences) => {
    const saved = await savePreferences(next);
    setPreferences(saved);
    setTheme(saved.appearance.theme);
  };

  const chooseLogDirectory = async () => {
    return chooseNativeLogDirectory();
  };

  const startMonitoring = async (request: ConnectionRequest) => {
    if (portIsInUse(request.port)) throw new Error(`${request.port} is already open in a BaudTide terminal.`);
    const uiKey = previewSessionId();
    const appliedSettings = {
      lineEnding: preferences.serial.lineEnding,
      displayEncoding: preferences.serial.displayEncoding,
      showTimestamps: preferences.serial.showTimestamps,
      reconnectWhenDeviceReturns: preferences.serial.reconnectWhenDeviceReturns,
    };
    const session = nativeRuntime
      // `manualPort` is dialog-only state that controls which input is shown;
      // the native command deliberately rejects unknown request fields.
      ? await startNativeSerialSession({
          port: request.port,
          baudRate: request.baudRate,
          sessionName: request.sessionName,
          settings: request.settings,
        })
      : { id: uiKey, logPath: undefined };
    const next: LiveSession = {
      ...request,
      ...appliedSettings,
      id: session.id,
      uiKey,
      native: nativeRuntime,
      nativeSessionOpen: nativeRuntime,
      logPath: session.logPath,
      connectionState: nativeRuntime ? 'connected' : 'disconnected',
    };
    setLiveSessions((current) => ({ ...current, [next.id]: next }));
    setSelectedSessionId(next.id);
    setConnectionDialogOpen(false);
    setPage('sessions');
    publishNotification(nativeRuntime
      ? { kind: 'connection', title: 'Terminal connected', detail: `${next.sessionName} is monitoring ${next.port}.` }
      : {
          kind: 'error',
          title: 'Preview terminal created — device not connected',
          detail: `${next.sessionName} is a browser-only preview. No device was opened and no serial data is being monitored.`,
        });
  };

  const updateSessionState = (sessionId: string, connectionState: MonitorConnectionState) => {
    setLiveSessions((current) => current[sessionId]
      ? { ...current, [sessionId]: { ...current[sessionId], connectionState } }
      : current);
  };

  // A native `error` status is terminal: the backend has already released this
  // session's port and log capture, so the tab must not keep reserving the port.
  const markNativeSessionEnded = (sessionId: string) => {
    const session = liveSessions[sessionId];
    setLiveSessions((current) => current[sessionId]
      ? { ...current, [sessionId]: { ...current[sessionId], nativeSessionOpen: false } }
      : current);
    if (session) publishNotification({ kind: 'error', title: 'Reader or logging stopped', detail: session.reconnectWhenDeviceReturns ? `${session.sessionName} will retry ${session.port} when it returns.` : `${session.sessionName} on ${session.port} needs attention.` });
  };

  const markNativeStorageLimit = (sessionId: string) => {
    const session = liveSessions[sessionId];
    setLiveSessions((current) => current[sessionId]
      ? { ...current, [sessionId]: { ...current[sessionId], nativeSessionOpen: false, connectionState: 'disconnected' } }
      : current);
    if (session) publishNotification({ kind: 'error', title: 'Storage limit reached', detail: `${session.sessionName} stopped logging before the capture library exceeded its limit.` });
  };

  // Listener setup runs after the native session starts. Unlike a backend
  // terminal error, that failure leaves the port open until we release it.
  const releaseNativeSessionAfterStartupFailure = async (sessionId: string) => {
    const session = liveSessions[sessionId];
    if (!session?.native || !session.nativeSessionOpen) return;
    try {
      await disconnectNativeSerialSession(session.id);
      setLiveSessions((current) => current[sessionId]
        ? { ...current, [sessionId]: { ...current[sessionId], nativeSessionOpen: false, connectionState: 'error' } }
        : current);
      publishNotification({ kind: 'error', title: 'Terminal display setup failed', detail: `${session.sessionName} was safely disconnected and can retry ${session.port}.` });
    } catch {
      // Keep the reservation when native cleanup is uncertain so another tab
      // cannot claim a port still owned by the backend.
      updateSessionState(sessionId, 'error');
      publishNotification({ kind: 'error', title: 'Terminal cleanup failed', detail: `${session.sessionName} may still hold ${session.port}. Retry or close the tab to try again.` });
    }
  };

  const disconnectSession = async (sessionId: string) => {
    const session = liveSessions[sessionId];
    if (!session) return;
    if (session.native && session.nativeSessionOpen) {
      try {
        await disconnectNativeSerialSession(session.id);
      } catch (error) {
        updateSessionState(sessionId, 'error');
        throw error;
      }
    }
    setLiveSessions((current) => current[sessionId]
      ? { ...current, [sessionId]: { ...current[sessionId], connectionState: 'disconnected', nativeSessionOpen: false } }
      : current);
    publishNotification({ kind: 'connection', title: 'Terminal disconnected', detail: `${session.sessionName} stopped monitoring ${session.port}.` });
  };

  const closeSession = async (sessionId: string) => {
    const session = liveSessions[sessionId];
    if (!session) return;
    if (session.native && session.nativeSessionOpen) {
      try {
        await disconnectNativeSerialSession(session.id);
      } catch {
        // Keep the tab available when the native session could not be closed; it is still recoverable.
        updateSessionState(sessionId, 'error');
        return;
      }
    }
    const nextSelected = selectedSessionId === sessionId
      ? sessions.find((candidate) => candidate.id !== sessionId)?.id ?? null
      : selectedSessionId;
    setLiveSessions((current) => {
      const { [sessionId]: _closed, ...remaining } = current;
      return remaining;
    });
    setSelectedSessionId(nextSelected);
  };

  const reconnectSession = async (sessionId: string, automatic = false) => {
    const session = liveSessions[sessionId];
    if (!session || !session.native) return;
    if (portIsInUse(session.port, sessionId)) throw new Error(`${session.port} is already open in another BaudTide terminal.`);
    updateSessionState(sessionId, 'reconnecting');
    let releasedNativeHandle = false;
    try {
      if (session.nativeSessionOpen) {
        await disconnectNativeSerialSession(session.id);
        releasedNativeHandle = true;
      }
      // A reconnect starts a new physical capture. Do not carry the previous
      // raw-log path forward: each backend session owns one log and sidecar.
      const restarted = await startNativeSerialSession({
        port: session.port,
        baudRate: session.baudRate,
        sessionName: session.sessionName,
        settings: session.settings,
      });
      const next: LiveSession = { ...session, id: restarted.id, logPath: restarted.logPath, nativeSessionOpen: true, connectionState: 'connected' };
      setLiveSessions((current) => {
        if (!current[sessionId]) return current;
        const { [sessionId]: _previous, ...remaining } = current;
        return { ...remaining, [next.id]: next };
      });
      setSelectedSessionId((current) => current === sessionId ? next.id : current);
      delete autoReconnectAttempts.current[sessionId];
      publishNotification({ kind: 'connection', title: 'Terminal reconnected', detail: `${next.sessionName} is monitoring ${next.port} again.` });
    } catch (error) {
      if (releasedNativeHandle) {
        setLiveSessions((current) => current[sessionId]
          ? { ...current, [sessionId]: { ...current[sessionId], nativeSessionOpen: false } }
          : current);
      }
      updateSessionState(sessionId, 'error');
      // A disconnected device can take minutes to return. The first reader
      // failure already notified the user; automatic retries stay quiet so the
      // notification history is not flooded while exponential backoff runs.
      if (!automatic) publishNotification({ kind: 'error', title: 'Reconnect failed', detail: `${session.sessionName} could not reopen ${session.port}.` });
      throw error;
    }
  };

  useEffect(() => {
    const retryableSessionIds = new Set(sessions
      .filter((session) => session.native && !session.nativeSessionOpen && session.connectionState === 'error' && session.reconnectWhenDeviceReturns)
      .map((session) => session.id));
    for (const [sessionId, timer] of Object.entries(autoReconnectTimers.current)) {
      if (!retryableSessionIds.has(sessionId)) {
        window.clearTimeout(timer.timer);
        delete autoReconnectTimers.current[sessionId];
        delete autoReconnectAttempts.current[sessionId];
      }
    }
    for (const sessionId of retryableSessionIds) {
      if (autoReconnectTimers.current[sessionId]) continue;
      const attempts = autoReconnectAttempts.current[sessionId] ?? 0;
      const delay = Math.min(AUTO_RECONNECT_INITIAL_DELAY_MS * (2 ** attempts), AUTO_RECONNECT_MAX_DELAY_MS);
      const timer = window.setTimeout(() => {
        delete autoReconnectTimers.current[sessionId];
        autoReconnectAttempts.current[sessionId] = attempts + 1;
        void reconnectSession(sessionId, true).catch(() => undefined);
      }, delay);
      autoReconnectTimers.current[sessionId] = { timer, attempts };
    }
  }, [liveSessions]);

  useEffect(() => () => {
    for (const { timer } of Object.values(autoReconnectTimers.current)) window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onLogExported = (event: Event) => {
      const detail = (event as CustomEvent<{ savedPath?: string }>).detail;
      const fileName = detail?.savedPath?.split(/[\\/]/).pop() ?? 'local log copy';
      publishNotification({ kind: 'export', title: 'Log export complete', detail: `${fileName} was saved locally.` });
    };
    window.addEventListener('baudtide:log-exported', onLogExported);
    return () => window.removeEventListener('baudtide:log-exported', onLogExported);
  }, [publishNotification]);

  useEffect(() => {
    const applyZoom = (next: number) => {
      const clamped = Math.min(1.6, Math.max(0.8, Number(next.toFixed(3))));
      zoomRef.current = clamped;
      // Changing this one DOM style is synchronous. React can continue to
      // render serial output independently without delaying the visual zoom.
      shellRef.current?.style.setProperty('zoom', String(clamped));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreGlobalShortcut(event)) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const increase = event.key === '+' || event.key === '=' || event.code === 'NumpadAdd';
      const decrease = event.key === '-' || event.code === 'NumpadSubtract';
      if (increase) {
        event.preventDefault();
        applyZoom(zoomRef.current + 0.1);
      } else if (decrease) {
        event.preventDefault();
        applyZoom(zoomRef.current - 0.1);
      } else if (event.key === '0' || event.code === 'Numpad0') {
        event.preventDefault();
        applyZoom(1);
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.deltaY === 0) return;
      event.preventDefault();
      // Mouse wheels typically report line-height jumps while touchpads report
      // many small pixel deltas. Normalize them and update immediately.
      const normalizedDelta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * window.innerHeight
          : event.deltaY;
      applyZoom(zoomRef.current * Math.exp(-normalizedDelta * 0.001));
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('wheel', onWheel);
    };
  }, []);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || shouldIgnoreGlobalShortcut(event)) return;
      const key = event.key.toLowerCase();
      if (nativeRuntime && (event.metaKey || event.ctrlKey) && key === 'f' && selectedSessionId) {
        event.preventDefault();
        navigate('sessions');
        selectedMonitor()?.focusFind();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Backspace' && selectedSessionId) {
        event.preventDefault();
        navigate('sessions');
        selectedMonitor()?.requestClear();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      if (key === 'n') {
        event.preventDefault();
        openConnectionDialog();
      } else if (event.code === 'Space' && selectedSessionId) {
        event.preventDefault();
        navigate('sessions');
        selectedMonitor()?.toggleDisplayPause();
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [selectedSessionId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.body.classList.toggle('theme-light', theme === 'light');
    return () => {
      document.body.classList.remove('theme-light');
      delete document.documentElement.dataset.theme;
    };
  }, [theme]);

  const activeLogPath = sessions.find((session) => session.native && session.connectionState === 'connected')?.logPath;
  return <div ref={shellRef} className={`signaldeck-shell theme-${theme} zoom-${Math.round(zoomRef.current * 100)}`} style={{ zoom: zoomRef.current }}>
    <SidebarNavigation activePage={page} onNavigate={navigate} onPreferences={() => navigate('preferences')} onHelp={() => navigate('help')} />
    <section className="signaldeck-main">
      <header className="signaldeck-topbar">
        <div className="signaldeck-breadcrumb"><span>BaudTide</span><b>/</b><strong>{page === 'sessions' && selectedSession ? selectedSession.sessionName : pageNames[page]}</strong></div>
        <div className={`signaldeck-preview-label ${nativeRuntime ? 'native' : ''}`}>{nativeRuntime ? 'Desktop mode · serial backend ready' : 'Browser preview · no serial backend'}</div>
        <div className="signaldeck-topbar-actions"><CommandPalette actions={commandActions} onAction={runCommand} /><TopThemeToggle theme={theme} onThemeChange={(nextTheme) => { setTheme(nextTheme); void saveAppPreferences({ ...preferences, appearance: { theme: nextTheme } }); }} /><NotificationsPanel notifications={notifications} onMarkRead={markRead} onMarkAllRead={markAllRead} /><WorkspaceProfileMenu onPreferences={() => navigate('preferences')} /></div>
      </header>
      <div className="signaldeck-content">
        <div hidden={page !== 'sessions'}><SessionsWorkspace sessions={sessions} selectedSessionId={selectedSessionId} onSelect={setSelectedSessionId} onRequestConnection={openConnectionDialog} onDisconnect={disconnectSession} onReconnect={reconnectSession} onClose={closeSession} onConnectionStateChange={updateSessionState} onNativeSessionEnded={markNativeSessionEnded} onNativeStorageLimit={markNativeStorageLimit} onNativeSessionStartupFailure={releaseNativeSessionAfterStartupFailure} onMonitorRef={(sessionId, monitor) => { monitorRefs.current[sessionId] = monitor; }} /></div>
        {page !== 'sessions' && (page === 'preferences' ? <PreferencesScreen preferences={preferences} nativeEnabled={nativeRuntime} onSave={saveAppPreferences} onThemePreview={setTheme} onChooseLogDirectory={chooseLogDirectory} />
          : page === 'help' ? <HelpFeedbackPanel nativeEnabled={nativeRuntime} openSessionCount={sessions.length} activeSessionCount={sessions.filter((session) => session.native && session.connectionState === 'connected').length} />
            : page === 'logs' ? <SavedLogsScreen nativeEnabled={nativeRuntime} activeLogPath={activeLogPath} onRequestConnection={openConnectionDialog} />
              : isWelcomeVisible ? <WelcomeScreen nativeEnabled={nativeRuntime} onConnect={openConnectionDialog} onExplore={() => setWelcomeVisible(false)} />
                : <PortDiscoveryDashboard nativeEnabled={nativeRuntime} onScan={listNativeSerialPorts} onConnect={openConnectionDialog} onRequestConnection={openConnectionDialog} />)}
      </div>
    </section>
    <ConnectionDialog isOpen={isConnectionDialogOpen} onClose={() => { setConnectionDialogOpen(false); setConnectionDefaults(null); }} onStartMonitoring={startMonitoring} onScan={nativeRuntime ? listNativeSerialPorts : undefined} initialPort={connectionDefaults?.port} initialBaudRate={preferences.serial.baudRate} initialSessionName={connectionDefaults?.sessionName} nativeEnabled={nativeRuntime} activePorts={sessions.filter((session) => session.native ? session.nativeSessionOpen : true).map((session) => session.port)} />
  </div>;
}

type SessionsWorkspaceProps = {
  sessions: LiveSession[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onRequestConnection: () => void;
  onDisconnect: (sessionId: string) => Promise<void>;
  onReconnect: (sessionId: string) => Promise<void>;
  onClose: (sessionId: string) => Promise<void>;
  onConnectionStateChange: (sessionId: string, state: MonitorConnectionState) => void;
  onNativeSessionEnded: (sessionId: string) => void;
  onNativeStorageLimit: (sessionId: string) => void;
  onNativeSessionStartupFailure: (sessionId: string) => Promise<void>;
  onMonitorRef: (sessionId: string, monitor: LiveMonitorHandle | null) => void;
};

type SessionsView = 'tabs' | 'tiled';

function SessionsWorkspace({ sessions, selectedSessionId, onSelect, onRequestConnection, onDisconnect, onReconnect, onClose, onConnectionStateChange, onNativeSessionEnded, onNativeStorageLimit, onNativeSessionStartupFailure, onMonitorRef }: SessionsWorkspaceProps) {
  const activeCount = sessions.filter((session) => session.native && session.connectionState === 'connected').length;
  const [view, setView] = useState<SessionsView>('tabs');
  const workspaceRef = useRef<HTMLElement>(null);
  const newTerminalButtonRef = useRef<HTMLButtonElement>(null);
  // Tiled mode keeps every monitor mounted; its desktop grid scrolls once the workspace is full.
  const showViewControl = sessions.length > 1;
  const activeView: SessionsView = showViewControl ? view : 'tabs';
  const closeFromTab = async (sessionId: string) => {
    await onClose(sessionId);
    window.requestAnimationFrame(() => {
      const selectedTab = workspaceRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"], .sd-session-tab > button[aria-pressed="true"]');
      (selectedTab ?? newTerminalButtonRef.current)?.focus();
    });
  };
  return <section ref={workspaceRef} className="sd-sessions-workspace" aria-label="Live terminal workspace">
    <header className="sd-sessions-workspace-header"><div><p>LIVE TERMINAL WORKSPACE</p><h1>Live terminal</h1><span>{activeView === 'tiled' ? 'Compare active serial monitors side by side.' : 'Run independent serial monitors in separate terminal tabs.'}</span></div><div className="sd-sessions-workspace-actions">{showViewControl && <div className="sd-session-view-switch" role="group" aria-label="Terminal layout"><button type="button" className={view === 'tabs' ? 'is-selected' : ''} aria-pressed={view === 'tabs'} onClick={() => setView('tabs')}>Tabs</button><button type="button" className={view === 'tiled' ? 'is-selected' : ''} aria-pressed={view === 'tiled'} onClick={() => setView('tiled')}>Tiled</button></div>}<span className="sd-session-count"><i className={activeCount ? 'is-active' : ''} /> {activeCount} active</span><button ref={newTerminalButtonRef} className="sd-primary-button" type="button" onClick={onRequestConnection}><Radio size={16} /> New terminal</button></div></header>
    {!sessions.length && <article className="sd-sessions-empty-panel"><div className="sd-sessions-empty-icon"><TerminalSquare size={21} /></div><div><h2>No terminal tabs are open.</h2><p>Use <strong>New terminal</strong> to add a live serial monitor to this workspace.</p></div></article>}
    {sessions.length > 0 && <>
      <div className="sd-session-tabs" role={activeView === 'tabs' ? 'tablist' : 'list'} aria-label={activeView === 'tabs' ? 'Open serial terminals' : 'Open serial terminals; select one for terminal actions'}>
        {sessions.map((session, index) => <div className={`sd-session-tab ${session.id === selectedSessionId ? 'is-selected' : ''}`} role={activeView === 'tiled' ? 'listitem' : undefined} key={session.id}>
          <button role={activeView === 'tabs' ? 'tab' : undefined} type="button" tabIndex={activeView === 'tabs' ? (session.id === selectedSessionId ? 0 : -1) : undefined} aria-selected={activeView === 'tabs' ? session.id === selectedSessionId : undefined} aria-pressed={activeView === 'tiled' ? session.id === selectedSessionId : undefined} aria-controls={activeView === 'tabs' ? `monitor-${session.uiKey}` : undefined} id={activeView === 'tabs' ? `tab-${session.uiKey}` : undefined} onClick={() => onSelect(session.id)} onKeyDown={(event) => { if (activeView !== 'tabs' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? sessions.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + sessions.length) % sessions.length; const next = sessions[nextIndex]; onSelect(next.id); requestAnimationFrame(() => document.getElementById(`tab-${next.uiKey}`)?.focus()); }}><i className={session.connectionState} /><span><strong>{session.sessionName}</strong><small>{session.port} · {session.connectionState}</small></span></button>
          <button className="sd-session-tab-close" type="button" onClick={() => void closeFromTab(session.id)} aria-label={`Close ${session.sessionName}`} title="Close terminal"><X size={14} /></button>
        </div>)}
      </div>
      <div className={`sd-session-monitors ${activeView === 'tiled' ? 'is-tiled' : ''}`} aria-label={activeView === 'tiled' ? 'Tiled serial terminals' : undefined}>
        {sessions.map((session) => <div className="sd-session-panel" id={`monitor-${session.uiKey}`} role={activeView === 'tabs' ? 'tabpanel' : 'region'} aria-labelledby={activeView === 'tabs' ? `tab-${session.uiKey}` : undefined} aria-label={activeView === 'tiled' ? `${session.sessionName} on ${session.port} terminal` : undefined} hidden={activeView === 'tabs' && session.id !== selectedSessionId} key={session.uiKey}>
          <LiveMonitor ref={(monitor) => onMonitorRef(session.id, monitor)} sessionName={session.sessionName} port={session.port} baudRate={session.baudRate} lineEnding={session.lineEnding} displayEncoding={session.displayEncoding} showTimestamps={session.showTimestamps} sessionId={session.id} nativeSession={session.native} initialConnectionState={session.connectionState} onConnectionStateChange={(state) => onConnectionStateChange(session.id, state)} onNativeSessionEnded={session.native ? () => onNativeSessionEnded(session.id) : undefined} onNativeStorageLimit={session.native ? () => onNativeStorageLimit(session.id) : undefined} onNativeSessionStartupFailure={session.native ? async () => { await onNativeSessionStartupFailure(session.id); } : undefined} onSend={session.native ? async (text) => { await sendNativeSerialText(session.id, text); } : undefined} onSendBytes={session.native ? async (bytes) => { await sendNativeSerialBytes(session.id, bytes); } : undefined} onDisconnect={session.native ? async () => { await onDisconnect(session.id); } : undefined} onReconnect={session.native ? async () => { await onReconnect(session.id); } : undefined} onClose={async () => { await onClose(session.id); }} />
        </div>)}
      </div>
    </>}
  </section>;
}

function TopThemeToggle({ theme, onThemeChange }: { theme: AppTheme; onThemeChange: (theme: AppTheme) => void }) {
  const isLight = theme === 'light';
  return <button className={`sd-top-theme-toggle ${isLight ? 'is-light' : ''}`} type="button" aria-label={`Switch to ${isLight ? 'dark' : 'light'} theme`} aria-pressed={isLight} title={`Switch to ${isLight ? 'dark' : 'light'} theme`} onClick={() => onThemeChange(isLight ? 'dark' : 'light')}><Sun className="sd-theme-sun" size={14} /><Moon className="sd-theme-moon" size={13} /><span><i>{isLight ? <Sun size={12} /> : <Moon size={11} />}</i></span></button>;
}

export default App;
