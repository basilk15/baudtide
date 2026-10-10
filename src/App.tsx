import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppStartupScreen } from './components/AppStartupScreen';
import { CommandPalette, type CommandPaletteAction } from './components/CommandPalette';
import { ConnectionDialog, type ConnectionDialogDefaults, type ConnectionRequest } from './components/ConnectionDialog';
import { HelpFeedbackPanel } from './components/HelpFeedbackPanel';
import { LiveMonitor, type LiveMonitorHandle, type MonitorConnectionState } from './components/LiveMonitor';
import { MobileShareScreen, type MobileShareSession } from './components/MobileShareScreen';
import { NotificationsPanel } from './components/NotificationsPanel';
import { useNotifications } from './components/notifications';
import { PreferencesScreen } from './components/PreferencesScreen';
import { SavedLogsScreen } from './components/SavedLogsScreen';
import { BenchRestoreDialog, type BenchRestoreChoice } from './components/BenchRestoreDialog';
import { liveTelemetryStore } from './lib/telemetry';
import { planBenchRestore, type BenchConnectionPreset } from './lib/benchSetup';
import { CaptureStorageBanner } from './components/CaptureStorageBanner';
import { saveCommandPresets } from './lib/serialCommands';
import { SessionWorkspaceManager } from './components/SessionWorkspaceManager';
import { PortDiscoveryDashboard } from './components/PortDiscoveryDashboard';
import { SidebarNavigation } from './components/SidebarNavigation';
import { WelcomeScreen } from './components/WelcomeScreen';
import { WorkspaceProfileMenu } from './components/WorkspaceProfileMenu';
import { VisualizeScreen, type VisualizeSession } from './components/VisualizeScreen';
import type { SignalDeckPage } from './components/phase3Types';
import { defaultPreferences, loadPreferences, savePreferences, type AppTheme, type BaudTidePreferences, type DisplayEncoding, type LineEnding } from './lib/preferences';
import { loadAnalysisWorkspaces } from './lib/analysisWorkspaces';
import { stableTerminalSessionIdentity, type SavedSessionWorkspace, type TerminalLayout } from './lib/sessionWorkspaces';
import { isDesktopRuntime } from './lib/desktop';
import { Leaf, Moon, Radio, Sun, TerminalSquare, X } from 'lucide-react';
import baudTideMark from './assets/signaldeck-mark.png';
import './light-theme.css';
import './components/theme-toggle.css';
import {
  defaultSerialConnectionSettings,
  disconnectNativeSerialSession,
  chooseNativeLogDirectory,
  listActiveNativeSerialSessions,
  listNativeSerialPorts,
  sendNativeSerialBytes,
  sendNativeSerialText,
  startNativeSerialSession,
  type NativeSerialPort,
  type SerialDeviceIdentity,
} from './lib/serial';

const pageNames: Record<SignalDeckPage, string> = {
  dashboard: 'Overview', sessions: 'Live terminal', visualize: 'Visualize', logs: 'Saved logs', mobile: 'Mobile share', preferences: 'Preferences', help: 'Help & feedback',
};

type LiveSession = ConnectionRequest & {
  /** The serial-session ID returned by the desktop backend, or a preview-only ID. */
  id: string;
  /** Stays stable across a native reconnect, so the terminal display is preserved. */
  uiKey: string;
  /** Preserve saved-layout membership if this device returns at a new path. */
  workspaceIdentity: string;
  legacyWorkspaceIdentity: string;
  native: boolean;
  /** Whether this tab currently owns a native backend session handle. */
  nativeSessionOpen: boolean;
  logPath?: string;
  deviceIdentity?: SerialDeviceIdentity | null;
  lineEnding: LineEnding;
  displayEncoding: DisplayEncoding;
  showTimestamps: boolean;
  reconnectWhenDeviceReturns: boolean;
  /** Per-terminal retry details shown while a device is unavailable. */
  autoReconnectStatus?: AutoReconnectStatus;
  /** Storage limits and ambiguous device identities need user action. */
  autoReconnectBlockedReason?: 'storage-limit' | 'device-identity';
  autoReconnectBlockedDetail?: string;
  connectionState: MonitorConnectionState;
};

type LiveSessions = Record<string, LiveSession>;
type AutoReconnectStatus = { attempt: number; nextRetryAt: number };
type AutoReconnectTimer = { timer: number; attempts: number; nextRetryAt: number };
const AUTO_RECONNECT_INITIAL_DELAY_MS = 2_000;
const AUTO_RECONNECT_MAX_DELAY_MS = 60_000;
const KEYBOARD_ZOOM_FACTOR = 1.04;
const KEYBOARD_ZOOM_TRANSITION_MS = 140;

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

/** The telemetry canvas owns Ctrl/⌘+wheel for its horizontal dataZoom. */
function isTelemetryChartTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('.bt-telemetry-echarts'));
}

const nativeRuntime = isDesktopRuntime();

function previewSessionId() {
  return `preview-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function App() {
  const [page, setPage] = useState<SignalDeckPage>('dashboard');
  const [isStartupVisible, setStartupVisible] = useState(true);
  const [isWelcomeVisible, setWelcomeVisible] = useState(true);
  const [isConnectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionDefaults, setConnectionDefaults] = useState<ConnectionDialogDefaults | null>(null);
  const [liveSessions, setLiveSessions] = useState<LiveSessions>({});
  const [terminalLayout, setTerminalLayout] = useState<TerminalLayout>('tabs');
  const [restoreWorkspace, setRestoreWorkspace] = useState<SavedSessionWorkspace | null>(null);
  const [requestedAnalysis, setRequestedAnalysis] = useState<{ id: string; revision: number } | null>(null);
  const benchRestoreBusy = useRef(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [visualizeCapturePath, setVisualizeCapturePath] = useState<string | null>(null);
  const [visualizeVisited, setVisualizeVisited] = useState(() => Boolean(loadAnalysisWorkspaces().activeId));
  const [theme, setTheme] = useState<AppTheme>('dark');
  const [preferences, setPreferences] = useState<BaudTidePreferences>(defaultPreferences);
  // Native discovery temporarily switches surviving sessions into bounded
  // replay mode. Do not let a new connection race that transition.
  const [nativeRecoveryPending, setNativeRecoveryPending] = useState(nativeRuntime);
  // Apply continuous zoom directly to the shell so it never waits for React's
  // render scheduler before a wheel gesture becomes visible.
  const zoomRef = useRef(1);
  const shellRef = useRef<HTMLDivElement>(null);
  const mainScrollRef = useRef<HTMLElement>(null);
  const monitorRefs = useRef<Record<string, LiveMonitorHandle | null>>({});
  const autoReconnectTimers = useRef<Record<string, AutoReconnectTimer>>({});
  const autoReconnectAttempts = useRef<Record<string, number>>({});
  const liveSessionsRef = useRef<LiveSessions>({});
  const reconnectGenerations = useRef<Record<string, number>>({});
  const reconnectInFlight = useRef<Record<string, Promise<void>>>({});
  const reconnectReleasedHandles = useRef<Record<string, boolean>>({});
  const mountedRef = useRef(true);
  const { notifications, publish: publishNotification, markRead, markAllRead } = useNotifications();
  const sessions = useMemo(() => Object.values(liveSessions), [liveSessions]);
  const visualizeSessions = useMemo(() => sessions.map<VisualizeSession>((session) => ({ id: session.id, uiKey: session.uiKey, sessionName: session.sessionName, port: session.port, connectionState: session.connectionState, capturePath: session.logPath, identity: session.workspaceIdentity, legacyIdentity: session.legacyWorkspaceIdentity, deviceIdentity: session.deviceIdentity, baudRate: session.baudRate, settings: session.settings })), [sessions]);
  const selectedSession = selectedSessionId ? liveSessions[selectedSessionId] : undefined;
  liveSessionsRef.current = liveSessions;

  const findSessionEntryByUiKey = (sessionMap: LiveSessions, uiKey: string) => {
    return Object.entries(sessionMap).find(([, session]) => session.uiKey === uiKey);
  };
  const getReconnectKey = (sessionId: string, session?: LiveSession) => session?.uiKey ?? liveSessionsRef.current[sessionId]?.uiKey ?? sessionId;
  const getReconnectGeneration = (reconnectKey: string) => reconnectGenerations.current[reconnectKey] ?? 0;
  const invalidateReconnectGeneration = (reconnectKey: string) => {
    reconnectGenerations.current[reconnectKey] = getReconnectGeneration(reconnectKey) + 1;
  };
  const canApplyReconnectResult = (reconnectKey: string, generation: number) => mountedRef.current && getReconnectGeneration(reconnectKey) === generation;
  const setAutoReconnectStatusForKey = (reconnectKey: string, status?: AutoReconnectStatus) => {
    setLiveSessions((current) => {
      const entry = findSessionEntryByUiKey(current, reconnectKey);
      if (!entry) return current;
      const [currentSessionId, currentSession] = entry;
      if (status === undefined && !currentSession.autoReconnectStatus) return current;
      return {
        ...current,
        [currentSessionId]: { ...currentSession, autoReconnectStatus: status },
      };
    });
  };

  const openConnectionDialog = (port?: NativeSerialPort) => {
    if (nativeRuntime && nativeRecoveryPending) {
      publishNotification({
        kind: 'connection',
        title: 'Restoring active terminals',
        detail: 'BaudTide is finishing terminal recovery. Try connecting again in a moment.',
      });
      return;
    }
    setConnectionDefaults(port ? {
      port: port.path,
      baudRate: preferences.serial.baudRate,
      sessionName: port.label,
      settings: defaultSerialConnectionSettings,
    } : null);
    setConnectionDialogOpen(true);
  };
  const openReconnectSetup = (defaults: ConnectionDialogDefaults) => {
    if (nativeRuntime && nativeRecoveryPending) {
      publishNotification({
        kind: 'connection',
        title: 'Restoring active terminals',
        detail: 'BaudTide is finishing terminal recovery. Try reconnecting again in a moment.',
      });
      return;
    }
    setConnectionDefaults(defaults);
    setConnectionDialogOpen(true);
  };
  const navigate = (nextPage: SignalDeckPage) => {
    if (nextPage === 'visualize') setVisualizeVisited(true);
    if (nextPage !== page) {
      // Every workspace starts at its own stable origin. Previously the
      // document scroll offset leaked from the dashboard into the terminal,
      // then snapped when the pages had different heights.
      mainScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      setPage(nextPage);
    }
    if (nextPage !== 'dashboard') setWelcomeVisible(false);
  };
  const showHome = () => {
    mainScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    setWelcomeVisible(true);
    setPage('dashboard');
  };
  const selectedMonitor = () => selectedSessionId ? monitorRefs.current[selectedSessionId] : null;
  const commandActions = useMemo<CommandPaletteAction[]>(() => [
    { id: 'new-connection', label: 'New terminal', description: 'Choose a serial port and start monitoring', shortcut: 'N', icon: 'new', disabled: nativeRecoveryPending },
    { id: 'pause-display', label: 'Pause or resume display', description: selectedSession ? `Toggle the display for ${selectedSession.sessionName}` : 'Select a live terminal first', shortcut: 'Space', icon: 'session', disabled: !selectedSession },
    { id: 'clear-display', label: 'Clear display', description: selectedSession ? `Clear ${selectedSession.sessionName} after confirmation` : 'Select a live terminal first', shortcut: '⌘/Ctrl ⌫', icon: 'session', disabled: !selectedSession },
    { id: 'find-output', label: 'Find in output', description: selectedSession ? `Filter visible output in ${selectedSession.sessionName}` : 'Select a live terminal first', shortcut: '⌘/Ctrl F', icon: 'log', disabled: !selectedSession },
    { id: 'sessions', label: 'Open live terminal', description: 'View active serial terminals', icon: 'session' },
    { id: 'visualize', label: 'Open Visualize', description: 'Explore detected telemetry from live serial terminals', icon: 'session' },
    { id: 'logs', label: 'Open saved logs', description: 'Browse captured serial logs', icon: 'log' },
    { id: 'mobile', label: 'Open mobile share', description: 'Create local links for phones and tablets', icon: 'mobile' },
    { id: 'preferences', label: 'Open preferences', description: 'Configure application defaults', icon: 'preferences' },
  ], [nativeRecoveryPending, selectedSession]);
  const runCommand = (action: CommandPaletteAction) => {
    if (action.id === 'new-connection') openConnectionDialog();
    if (action.id === 'pause-display') { navigate('sessions'); selectedMonitor()?.toggleDisplayPause(); }
    if (action.id === 'clear-display') { navigate('sessions'); selectedMonitor()?.requestClear(); }
    if (action.id === 'find-output') { navigate('sessions'); selectedMonitor()?.focusFind(); }
    if (action.id === 'sessions') navigate('sessions');
    if (action.id === 'visualize') navigate('visualize');
    if (action.id === 'logs') navigate('logs');
    if (action.id === 'mobile') navigate('mobile');
    if (action.id === 'preferences') navigate('preferences');
  };

  const portIsInUse = (port: string, exceptSessionId?: string) => Object.values(liveSessionsRef.current).some((session) => (
    session.id !== exceptSessionId
    && session.port === port
    && (session.native ? session.nativeSessionOpen : true)
  ));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
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
                workspaceIdentity: stableTerminalSessionIdentity(session),
                legacyWorkspaceIdentity: stableTerminalSessionIdentity({ ...session, deviceIdentity: null }),
                port: session.port,
                baudRate: session.baudRate,
                sessionName: session.sessionName,
                manualPort: false,
                settings: session.settings,
                native: true,
                nativeSessionOpen: true,
                logPath: session.logPath,
                deviceIdentity: session.deviceIdentity,
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
      } catch (error) {
        if (!cancelled) {
          publishNotification({
            kind: 'error',
            title: 'BaudTide startup failed',
            detail: error instanceof Error ? error.message : 'Preferences and active terminals could not be restored.',
          });
        }
      } finally {
        if (!cancelled) setNativeRecoveryPending(false);
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
    if (nativeRuntime && nativeRecoveryPending) {
      throw new Error('BaudTide is still restoring active terminals. Try again in a moment.');
    }
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
      : { id: uiKey, logPath: undefined, deviceIdentity: undefined };
    const next: LiveSession = {
      ...request,
      ...appliedSettings,
      id: session.id,
      uiKey,
      workspaceIdentity: stableTerminalSessionIdentity({ ...request, deviceIdentity: session.deviceIdentity }),
      legacyWorkspaceIdentity: stableTerminalSessionIdentity(request),
      native: nativeRuntime,
      nativeSessionOpen: nativeRuntime,
      logPath: session.logPath,
      deviceIdentity: session.deviceIdentity,
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

  const clearAutoReconnect = (sessionId: string, clearAttempts = true, session?: LiveSession) => {
    const reconnectKey = getReconnectKey(sessionId, session);
    const pending = autoReconnectTimers.current[reconnectKey];
    if (pending) {
      window.clearTimeout(pending.timer);
      delete autoReconnectTimers.current[reconnectKey];
    }
    if (clearAttempts) delete autoReconnectAttempts.current[reconnectKey];
    setAutoReconnectStatusForKey(reconnectKey, undefined);
  };

  const invalidateSessionReconnectWork = (sessionId: string, clearAttempts = true, session?: LiveSession) => {
    const reconnectKey = getReconnectKey(sessionId, session);
    clearAutoReconnect(sessionId, clearAttempts, session);
    invalidateReconnectGeneration(reconnectKey);
    return reconnectKey;
  };

  const waitForReconnectToSettle = async (reconnectKey: string) => {
    const pending = reconnectInFlight.current[reconnectKey];
    if (pending) await pending.catch(() => undefined);
  };

  const setSessionLineEnding = (sessionId: string, lineEnding: LineEnding) => {
    setLiveSessions((current) => current[sessionId] && current[sessionId].lineEnding !== lineEnding
      ? { ...current, [sessionId]: { ...current[sessionId], lineEnding } }
      : current);
  };

  const setSessionAutoReconnect = (sessionId: string, enabled: boolean) => {
    const session = liveSessionsRef.current[sessionId];
    // Storage exhaustion and an ambiguous device cannot be repaired by retrying.
    if (!session || (enabled && session.autoReconnectBlockedReason)) return;
    if (!enabled) clearAutoReconnect(sessionId);
    setLiveSessions((current) => current[sessionId]
      ? {
          ...current,
          [sessionId]: {
            ...current[sessionId],
            reconnectWhenDeviceReturns: enabled,
            autoReconnectStatus: enabled ? undefined : current[sessionId].autoReconnectStatus,
          },
        }
      : current);
  };

  // A native `error` status is terminal: the backend has already released this
  // session's port and log capture, so the tab must not keep reserving the port.
  const markNativeSessionEnded = (sessionId: string) => {
    const session = liveSessionsRef.current[sessionId];
    setLiveSessions((current) => current[sessionId]
      ? { ...current, [sessionId]: { ...current[sessionId], nativeSessionOpen: false } }
      : current);
    if (session) publishNotification({ kind: 'error', title: 'Reader or logging stopped', detail: session.reconnectWhenDeviceReturns ? `${session.sessionName} will retry ${session.port} when it returns.` : `${session.sessionName} on ${session.port} needs attention.` });
  };

  const markNativeStorageLimit = (sessionId: string) => {
    const session = liveSessionsRef.current[sessionId];
    clearAutoReconnect(sessionId);
    setLiveSessions((current) => current[sessionId]
      ? {
          ...current,
          [sessionId]: {
            ...current[sessionId],
            nativeSessionOpen: false,
            connectionState: 'error',
            // A full capture library cannot be repaired by a device returning;
            // avoid futile background retries while preserving manual retry
            // after the user frees space or raises the storage limit.
            reconnectWhenDeviceReturns: false,
            autoReconnectStatus: undefined,
            autoReconnectBlockedReason: 'storage-limit',
          },
        }
      : current);
    if (session) publishNotification({ kind: 'error', title: 'Storage limit reached', detail: `${session.sessionName} stopped logging before the capture library exceeded its limit.` });
  };

  // Listener setup runs after the native session starts. Unlike a backend
  // terminal error, that failure leaves the port open until we release it.
  const releaseNativeSessionAfterStartupFailure = async (sessionId: string) => {
    const session = liveSessionsRef.current[sessionId];
    if (!session?.native || !session.nativeSessionOpen) return;
    invalidateReconnectGeneration(session.uiKey);
    try {
      await disconnectNativeSerialSession(session.id);
      setLiveSessions((current) => current[sessionId]
        ? { ...current, [sessionId]: { ...current[sessionId], nativeSessionOpen: false, connectionState: 'error' } }
        : current);
      if (mountedRef.current) publishNotification({ kind: 'error', title: 'Terminal display setup failed', detail: `${session.sessionName} was safely disconnected and can retry ${session.port}.` });
    } catch {
      // Keep the reservation when native cleanup is uncertain so another tab
      // cannot claim a port still owned by the backend.
      updateSessionState(sessionId, 'error');
      if (mountedRef.current) publishNotification({ kind: 'error', title: 'Terminal cleanup failed', detail: `${session.sessionName} may still hold ${session.port}. Retry or close the tab to try again.` });
    }
  };

  const disconnectSession = async (sessionId: string) => {
    const session = liveSessionsRef.current[sessionId];
    if (!session) return;
    // Disconnect is intentional, so cancel a pending automatic retry before
    // releasing the backend handle. The session remains manually reconnectable.
    const reconnectKey = invalidateSessionReconnectWork(sessionId, true, session);
    await waitForReconnectToSettle(reconnectKey);
    const currentEntry = findSessionEntryByUiKey(liveSessionsRef.current, reconnectKey);
    const currentSession = currentEntry?.[1];
    const currentSessionId = currentEntry?.[0] ?? sessionId;
    const nativeHandleAlreadyReleased = reconnectReleasedHandles.current[reconnectKey] === true;
    if (currentSession?.native && currentSession.nativeSessionOpen && !nativeHandleAlreadyReleased) {
      try {
        await disconnectNativeSerialSession(currentSession.id);
      } catch (error) {
        updateSessionState(currentSessionId, 'error');
        throw error;
      }
    }
    setLiveSessions((current) => {
      const entry = findSessionEntryByUiKey(current, reconnectKey);
      if (!entry) return current;
      const [id, value] = entry;
      return { ...current, [id]: { ...value, connectionState: 'disconnected', nativeSessionOpen: false } };
    });
    delete reconnectReleasedHandles.current[reconnectKey];
    if (mountedRef.current) publishNotification({ kind: 'connection', title: 'Terminal disconnected', detail: `${session.sessionName} stopped monitoring ${session.port}.` });
  };

  const closeSession = async (sessionId: string) => {
    const session = liveSessionsRef.current[sessionId];
    if (!session) return;
    const reconnectKey = invalidateSessionReconnectWork(sessionId, true, session);
    await waitForReconnectToSettle(reconnectKey);
    const currentEntry = findSessionEntryByUiKey(liveSessionsRef.current, reconnectKey);
    const currentSession = currentEntry?.[1];
    const currentSessionId = currentEntry?.[0] ?? sessionId;
    const nativeHandleAlreadyReleased = reconnectReleasedHandles.current[reconnectKey] === true;
    if (currentSession?.native && currentSession.nativeSessionOpen && !nativeHandleAlreadyReleased) {
      try {
        await disconnectNativeSerialSession(currentSession.id);
      } catch {
        // Keep the tab available when the native session could not be closed; it is still recoverable.
        updateSessionState(currentSessionId, 'error');
        return;
      }
    }
    const remainingSessions = Object.values(liveSessionsRef.current).filter((candidate) => candidate.id !== currentSessionId);
    const nextSelected = selectedSessionId === currentSessionId
      ? remainingSessions[0]?.id ?? null
      : selectedSessionId;
    setLiveSessions((current) => {
      const entry = findSessionEntryByUiKey(current, reconnectKey);
      if (!entry) return current;
      const [id, _value] = entry;
      const { [id]: _closed, ...remaining } = current;
      return remaining;
    });
    delete reconnectReleasedHandles.current[reconnectKey];
    setSelectedSessionId(nextSelected);
  };

  const reconnectSession = async (sessionId: string, automatic = false) => {
    const session = liveSessionsRef.current[sessionId];
    if (!session || !session.native) return;
    const reconnectKey = session.uiKey;
    const existing = reconnectInFlight.current[reconnectKey];
    if (existing) return existing;

    const reconnectPromise = (async () => {
      // A manual retry replaces a scheduled one and begins a fresh backoff if it
      // fails. The timer callback has already removed its own entry.
      if (!automatic) clearAutoReconnect(sessionId, true, session);
      if (portIsInUse(session.port, sessionId)) throw new Error(`${session.port} is already open in another BaudTide terminal.`);
      const generation = getReconnectGeneration(reconnectKey);
      updateSessionState(sessionId, 'reconnecting');
      let releasedNativeHandle = false;
      let restartedSessionId: string | null = null;
      delete reconnectReleasedHandles.current[reconnectKey];
      const markReleasedNativeHandle = () => {
        if (!releasedNativeHandle) return;
        reconnectReleasedHandles.current[reconnectKey] = true;
        if (!mountedRef.current) return;
        setLiveSessions((current) => {
          const entry = findSessionEntryByUiKey(current, reconnectKey);
          if (!entry) return current;
          const [currentSessionId, currentSession] = entry;
          return currentSession.nativeSessionOpen
            ? { ...current, [currentSessionId]: { ...currentSession, nativeSessionOpen: false } }
            : current;
        });
      };
      try {
        if (session.nativeSessionOpen) {
          await disconnectNativeSerialSession(session.id);
          releasedNativeHandle = true;
          reconnectReleasedHandles.current[reconnectKey] = true;
        }
        if (!canApplyReconnectResult(reconnectKey, generation)) {
          markReleasedNativeHandle();
          return;
        }
        // A reconnect starts a new physical capture. Do not carry the previous
        // raw-log path forward: each backend session owns one log and sidecar.
        const restarted = await startNativeSerialSession({
          port: session.port,
          baudRate: session.baudRate,
          sessionName: session.sessionName,
          settings: session.settings,
          deviceIdentity: session.deviceIdentity,
          automaticReconnect: automatic,
        });
        restartedSessionId = restarted.id;
        if (!canApplyReconnectResult(reconnectKey, generation)) {
          await disconnectNativeSerialSession(restarted.id).catch(() => undefined);
          markReleasedNativeHandle();
          return;
        }
        setLiveSessions((current) => {
          const entry = findSessionEntryByUiKey(current, reconnectKey);
          if (!entry) return current;
          const [currentSessionId, currentSession] = entry;
          const next: LiveSession = {
            ...currentSession,
            id: restarted.id,
            port: restarted.port,
            deviceIdentity: restarted.deviceIdentity,
            logPath: restarted.logPath,
            nativeSessionOpen: true,
            connectionState: 'connected',
            // A successful manual restart proves the storage condition was dealt
            // with (or a larger limit was selected), so restore the per-session
            // control without silently re-enabling retries.
            autoReconnectStatus: undefined,
            autoReconnectBlockedReason: undefined,
            autoReconnectBlockedDetail: undefined,
          };
          const { [currentSessionId]: _previous, ...remaining } = current;
          return { ...remaining, [next.id]: next };
        });
        delete reconnectReleasedHandles.current[reconnectKey];
        setSelectedSessionId((current) => current === sessionId ? restarted.id : current);
        if (monitorRefs.current[sessionId]) {
          monitorRefs.current[restarted.id] = monitorRefs.current[sessionId];
        }
        delete monitorRefs.current[sessionId];
        delete autoReconnectAttempts.current[reconnectKey];
        if (mountedRef.current) publishNotification({ kind: 'connection', title: 'Terminal reconnected', detail: `${session.sessionName} is monitoring ${restarted.port} again.` });
      } catch (error) {
        if (restartedSessionId && !canApplyReconnectResult(reconnectKey, generation)) {
          await disconnectNativeSerialSession(restartedSessionId).catch(() => undefined);
          markReleasedNativeHandle();
          return;
        }
        if (releasedNativeHandle) {
          markReleasedNativeHandle();
        }
        const currentSessionId = findSessionEntryByUiKey(liveSessionsRef.current, reconnectKey)?.[0];
        if (currentSessionId) updateSessionState(currentSessionId, 'error');
        const message = error instanceof Error ? error.message : String(error);
        if (currentSessionId && message.includes('Device identity needs review:')) {
          clearAutoReconnect(currentSessionId);
          setLiveSessions((current) => current[currentSessionId] ? {
            ...current,
            [currentSessionId]: { ...current[currentSessionId], reconnectWhenDeviceReturns: false, autoReconnectBlockedReason: 'device-identity', autoReconnectBlockedDetail: message.slice(message.indexOf('Device identity needs review:') + 'Device identity needs review:'.length).trim() },
          } : current);
          if (mountedRef.current) publishNotification({ kind: 'error', title: 'Reconnect needs a device check', detail: message });
        }
        // A disconnected device can take minutes to return. The first reader
        // failure already notified the user; automatic retries stay quiet so the
        // notification history is not flooded while exponential backoff runs.
        if (!automatic && !message.includes('Device identity needs review:') && mountedRef.current) publishNotification({ kind: 'error', title: 'Reconnect failed', detail: message });
        throw error;
      }
    })();

    reconnectInFlight.current[reconnectKey] = reconnectPromise;
    try {
      await reconnectPromise;
    } finally {
      if (reconnectInFlight.current[reconnectKey] === reconnectPromise) delete reconnectInFlight.current[reconnectKey];
    }
  };

  useEffect(() => {
    const retryableSessionKeys = new Set(sessions
      .filter((session) => session.native && !session.nativeSessionOpen && session.connectionState === 'error' && session.reconnectWhenDeviceReturns)
      .map((session) => session.uiKey));
    for (const [reconnectKey, timer] of Object.entries(autoReconnectTimers.current)) {
      if (!retryableSessionKeys.has(reconnectKey)) {
        window.clearTimeout(timer.timer);
        delete autoReconnectTimers.current[reconnectKey];
        delete autoReconnectAttempts.current[reconnectKey];
      }
    }
    for (const reconnectKey of retryableSessionKeys) {
      if (autoReconnectTimers.current[reconnectKey] !== undefined || reconnectInFlight.current[reconnectKey] !== undefined) continue;
      const currentSessionId = findSessionEntryByUiKey(liveSessionsRef.current, reconnectKey)?.[0];
      if (!currentSessionId) continue;
      const attempts = autoReconnectAttempts.current[reconnectKey] ?? 0;
      const delay = Math.min(AUTO_RECONNECT_INITIAL_DELAY_MS * (2 ** attempts), AUTO_RECONNECT_MAX_DELAY_MS);
      const nextRetryAt = Date.now() + delay;
      const generation = getReconnectGeneration(reconnectKey);
      setAutoReconnectStatusForKey(reconnectKey, { attempt: attempts + 1, nextRetryAt });
      const timer = window.setTimeout(() => {
        delete autoReconnectTimers.current[reconnectKey];
        if (!canApplyReconnectResult(reconnectKey, generation)) return;
        autoReconnectAttempts.current[reconnectKey] = attempts + 1;
        setAutoReconnectStatusForKey(reconnectKey, undefined);
        const latestSessionId = findSessionEntryByUiKey(liveSessionsRef.current, reconnectKey)?.[0];
        if (!latestSessionId) return;
        void reconnectSession(latestSessionId, true).catch(() => undefined);
      }, delay);
      autoReconnectTimers.current[reconnectKey] = { timer, attempts, nextRetryAt };
    }
  }, [liveSessions]);

  useEffect(() => {
    // StrictMode mounts effects, runs their cleanup, then mounts them again in
    // development. Mark the component live on every setup so the probe cleanup
    // cannot permanently disable reconnect results for the real mount.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const { timer } of Object.values(autoReconnectTimers.current)) window.clearTimeout(timer);
      autoReconnectTimers.current = {};
      autoReconnectAttempts.current = {};
      reconnectReleasedHandles.current = {};
      for (const session of Object.values(liveSessionsRef.current)) invalidateReconnectGeneration(session.uiKey);
    };
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
    let zoomTransitionTimer: number | undefined;
    const applyZoom = (next: number, animate = false) => {
      const clamped = Math.min(1.6, Math.max(0.8, Number(next.toFixed(3))));
      zoomRef.current = clamped;
      // Changing this one DOM style is synchronous. React can continue to
      // render serial output independently without delaying the visual zoom.
      const shell = shellRef.current;
      if (animate && shell) {
        window.clearTimeout(zoomTransitionTimer);
        shell.classList.add('is-zoom-animating');
        zoomTransitionTimer = window.setTimeout(() => shell.classList.remove('is-zoom-animating'), KEYBOARD_ZOOM_TRANSITION_MS);
      }
      shell?.style.setProperty('zoom', String(clamped));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreGlobalShortcut(event)) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      const increase = event.key === '+' || event.key === '=' || event.code === 'NumpadAdd';
      const decrease = event.key === '-' || event.code === 'NumpadSubtract';
      if (increase) {
        event.preventDefault();
        applyZoom(zoomRef.current * KEYBOARD_ZOOM_FACTOR, true);
      } else if (decrease) {
        event.preventDefault();
        applyZoom(zoomRef.current / KEYBOARD_ZOOM_FACTOR, true);
      } else if (event.key === '0' || event.code === 'Numpad0') {
        event.preventDefault();
        applyZoom(1, true);
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (isTelemetryChartTarget(event.target)) return;
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
      window.clearTimeout(zoomTransitionTimer);
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
    document.body.classList.toggle('theme-light', theme !== 'dark');
    document.body.classList.toggle('theme-sage', theme === 'sage');
    return () => {
      document.body.classList.remove('theme-light');
      document.body.classList.remove('theme-sage');
      delete document.documentElement.dataset.theme;
    };
  }, [theme]);

  const benchSessions = () => Object.values(liveSessionsRef.current).map((session) => ({
    id: session.id, identity: session.workspaceIdentity, legacyIdentity: session.legacyWorkspaceIdentity,
    port: session.port, connected: session.native ? session.nativeSessionOpen : true,
  }));
  const restoreBench = async (choices: BenchRestoreChoice[]) => {
    if (!restoreWorkspace || benchRestoreBusy.current) throw new Error('Wait for the current restore to finish.');
    if (nativeRuntime && nativeRecoveryPending) throw new Error('Wait for active terminal recovery to finish.');
    benchRestoreBusy.current = true;
    const restored = new Map<string, string>();
    const failures: string[] = [];
    try {
      for (const choice of choices) {
        const preset = choice.preset;
        try {
          // Cancel retries for a dormant matching tab before rechecking the plan.
          const previous = Object.values(liveSessionsRef.current).find((session) => session.workspaceIdentity === preset.identity || session.legacyWorkspaceIdentity === preset.identity);
          if (previous && !previous.nativeSessionOpen) {
            const key = invalidateSessionReconnectWork(previous.id, true, previous);
            await waitForReconnectToSettle(key);
          }
          const available = nativeRuntime ? await listNativeSerialPorts() : [];
          const row = planBenchRestore([preset], available, benchSessions())[0];
          if (row.status === 'open' && row.existingId) { restored.set(preset.identity, row.existingId); continue; }
          if (row.status === 'conflict' || row.status === 'missing') throw new Error(row.detail);
          if (!choice.port || (row.status === 'review' && !choice.reviewed)) throw new Error('Review the current port before restoring.');
          if (row.candidates.length && !row.candidates.some((port) => port.path === choice.port)) throw new Error('The selected device changed. Rescan and review it again.');
          if (portIsInUse(choice.port)) throw new Error('This port is already open.');
          const current = row.existingId ? liveSessionsRef.current[row.existingId] : undefined;
          const uiKey = current?.uiKey ?? previewSessionId();
          const identified = available.find((port) => port.path === choice.port)?.deviceIdentity;
          const opened = nativeRuntime ? await startNativeSerialSession({ port: choice.port, baudRate: preset.baudRate,
            sessionName: preset.sessionName, settings: preset.settings,
            deviceIdentity: preset.deviceIdentity ?? identified, reviewedPort: choice.reviewed,
            automaticReconnect: !choice.reviewed && Boolean(preset.deviceIdentity) })
            : { id: uiKey, port: choice.port, logPath: undefined, deviceIdentity: preset.deviceIdentity };
          const next: LiveSession = { ...preset, id: opened.id, uiKey, port: opened.port,
            deviceIdentity: opened.deviceIdentity, workspaceIdentity: stableTerminalSessionIdentity({ ...preset, port: opened.port, deviceIdentity: opened.deviceIdentity }),
            legacyWorkspaceIdentity: stableTerminalSessionIdentity({ ...preset, port: opened.port, deviceIdentity: null }),
            native: nativeRuntime, nativeSessionOpen: nativeRuntime, manualPort: !identified, logPath: opened.logPath,
            connectionState: nativeRuntime ? 'connected' : 'disconnected' };
          const merge = (all: LiveSessions) => {
            const updated = { ...all }; if (current) delete updated[current.id]; updated[next.id] = next; return updated;
          };
          liveSessionsRef.current = merge(liveSessionsRef.current); setLiveSessions(merge);
          // Decoder changes remain isolated from terminal output and raw captures.
          liveTelemetryStore.setDecoderProfile(uiKey, preset.decoder);
          if (current && monitorRefs.current[current.id]) { monitorRefs.current[next.id] = monitorRefs.current[current.id]; delete monitorRefs.current[current.id]; }
          if (preset.commands !== undefined) {
            try { saveCommandPresets(next.workspaceIdentity, preset.commands); }
            catch { publishNotification({ kind: 'error', title: 'Command presets were not restored', detail: `${preset.sessionName} connected, but command storage is unavailable.` }); }
          }
          restored.set(preset.identity, next.id);
        } catch (error) { failures.push(`${preset.sessionName}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      setTerminalLayout(restoreWorkspace.layout);
      const selected = restoreWorkspace.selectedSessionIdentity ? restored.get(restoreWorkspace.selectedSessionIdentity) : undefined;
      if (selected || restored.size) setSelectedSessionId(selected ?? [...restored.values()][0]);
      if (restoreWorkspace.analysisWorkspaceId) {
        setVisualizeVisited(true);
        setRequestedAnalysis({ id: restoreWorkspace.analysisWorkspaceId, revision: Date.now() });
      }
      setWelcomeVisible(false); setPage('sessions');
      const message = `${restored.size} terminal${restored.size === 1 ? '' : 's'} restored or already open. ${failures.length ? failures.join(' ') : 'Unselected devices remain disconnected.'}`;
      publishNotification({ kind: failures.length ? 'error' : 'connection', title: 'Bench setup restored', detail: message });
      return message;
    } finally { benchRestoreBusy.current = false; }
  };

  const activeLogPath = sessions.find((session) => session.native && session.connectionState === 'connected')?.logPath;
  const closeStartup = useCallback(() => setStartupVisible(false), []);
  if (isStartupVisible) return <AppStartupScreen onComplete={closeStartup} />;
  return <div ref={shellRef} className={`signaldeck-shell theme-${theme} zoom-${Math.round(zoomRef.current * 100)}`} style={{ zoom: zoomRef.current }}>
    <SidebarNavigation activePage={page} onNavigate={navigate} onHome={showHome} onPreferences={() => navigate('preferences')} onHelp={() => navigate('help')} />
    <section ref={mainScrollRef} className="signaldeck-main">
      <header className="signaldeck-topbar">
        <div className="sd-mobile-brand" aria-label="BaudTide">
          <img src={baudTideMark} alt="" />
          <span>baud<span>tide</span></span>
        </div>
        <div className="signaldeck-breadcrumb"><span>BaudTide</span><b>/</b><strong>{page === 'sessions' && selectedSession ? selectedSession.sessionName : pageNames[page]}</strong></div>
        <div className={`signaldeck-preview-label ${nativeRuntime ? 'native' : ''}`}>{nativeRuntime ? 'Desktop mode · serial backend ready' : 'Browser preview · no serial backend'}</div>
        <div className="signaldeck-topbar-actions"><CommandPalette actions={commandActions} onAction={runCommand} /><TopThemeToggle theme={theme} onThemeChange={(nextTheme) => { setTheme(nextTheme); void saveAppPreferences({ ...preferences, appearance: { theme: nextTheme } }); }} /><NotificationsPanel notifications={notifications} onMarkRead={markRead} onMarkAllRead={markAllRead} /><WorkspaceProfileMenu onPreferences={() => navigate('preferences')} /></div>
      </header>
      <div className="signaldeck-content">
        <div hidden={page !== 'sessions'}><SessionsWorkspace layout={terminalLayout} onLayoutChange={setTerminalLayout} onRestoreWorkspace={setRestoreWorkspace} restoreBusy={Boolean(restoreWorkspace)} workspaceVisible={page === 'sessions'} storageLimit={preferences.storage.storageLimitBytes} logDirectory={preferences.storage.logDirectory} onStorageWarning={(title, detail) => publishNotification({ kind: 'error', title, detail })} onStorageSettings={() => navigate('preferences')} onSavedLogs={() => navigate('logs')} sessions={sessions} selectedSessionId={selectedSessionId} onSelect={setSelectedSessionId} onRequestConnection={openConnectionDialog} onDisconnect={disconnectSession} onReconnect={reconnectSession} onReconnectSetup={(sessionId) => { const session = liveSessionsRef.current[sessionId]; if (session) openReconnectSetup({ port: session.port, baudRate: session.baudRate, sessionName: session.sessionName, settings: session.settings, setupNotice: 'Check the intended device and select its current port before connecting.' }); }} onAutoReconnectChange={setSessionAutoReconnect} onLineEndingChange={setSessionLineEnding} onClose={closeSession} onConnectionStateChange={updateSessionState} onNativeSessionEnded={markNativeSessionEnded} onNativeStorageLimit={markNativeStorageLimit} onNativeSessionStartupFailure={releaseNativeSessionAfterStartupFailure} onMonitorRef={(sessionId, monitor) => { monitorRefs.current[sessionId] = monitor; }} /></div>
        {visualizeVisited && <div hidden={page !== 'visualize'}><VisualizeScreen workspaceVisible={page === 'visualize'} nativeEnabled={nativeRuntime} sessions={visualizeSessions} selectedSessionId={selectedSessionId} onSelectSession={setSelectedSessionId} onRequestConnection={openConnectionDialog} onTelemetryAlert={(alert) => publishNotification({ kind: 'alert', ...alert })} requestedAnalysis={requestedAnalysis} onRequestedAnalysisRestored={() => setRequestedAnalysis(null)} requestedCapturePath={visualizeCapturePath} onRequestedCaptureOpened={() => setVisualizeCapturePath(null)} /></div>}
        {page !== 'sessions' && (page === 'preferences' ? <PreferencesScreen preferences={preferences} nativeEnabled={nativeRuntime} onSave={saveAppPreferences} onThemePreview={setTheme} onChooseLogDirectory={chooseLogDirectory} />
          : page === 'help' ? <HelpFeedbackPanel nativeEnabled={nativeRuntime} openSessionCount={sessions.length} activeSessionCount={sessions.filter((session) => session.native && session.connectionState === 'connected').length} />
            : page === 'logs' ? <SavedLogsScreen nativeEnabled={nativeRuntime} activeLogPath={activeLogPath} onRequestConnection={openConnectionDialog} onReconnectWithSettings={openReconnectSetup} onOpenInVisualize={(log) => { setVisualizeCapturePath(log.path); navigate('visualize'); }} />
              : page === 'mobile' ? <MobileShareScreen nativeEnabled={nativeRuntime} sessions={sessions.map<MobileShareSession>((session) => ({ id: session.id, sessionName: session.sessionName, port: session.port, native: session.native, connectionState: session.connectionState }))} selectedSessionId={selectedSessionId} onSelectSession={setSelectedSessionId} />
              : page === 'visualize' ? null
              : isWelcomeVisible ? <WelcomeScreen nativeEnabled={nativeRuntime} onConnect={openConnectionDialog} onExplore={() => setWelcomeVisible(false)} />
                : <PortDiscoveryDashboard nativeEnabled={nativeRuntime} onScan={listNativeSerialPorts} onConnect={openConnectionDialog} onRequestConnection={openConnectionDialog} />)}
      </div>
    </section>
    {restoreWorkspace && <BenchRestoreDialog workspace={restoreWorkspace} sessions={benchSessions()} scan={nativeRuntime ? listNativeSerialPorts : async () => []} onRestore={restoreBench} onClose={() => { if (!benchRestoreBusy.current) setRestoreWorkspace(null); }} />}
    <ConnectionDialog isOpen={isConnectionDialogOpen} onClose={() => { setConnectionDialogOpen(false); setConnectionDefaults(null); }} onStartMonitoring={startMonitoring} onScan={nativeRuntime ? listNativeSerialPorts : undefined} initialPort={connectionDefaults?.port} initialBaudRate={connectionDefaults?.baudRate ?? preferences.serial.baudRate} initialSessionName={connectionDefaults?.sessionName} initialSettings={connectionDefaults?.settings} initialSetupNotice={connectionDefaults?.setupNotice} nativeEnabled={nativeRuntime} activePorts={sessions.filter((session) => session.native ? session.nativeSessionOpen : true).map((session) => session.port)} />
  </div>;
}

type SessionsWorkspaceProps = {
  layout: TerminalLayout;
  storageLimit: number;
  logDirectory: string;
  onStorageWarning: (title: string, detail: string) => void;
  onStorageSettings: () => void;
  onSavedLogs: () => void;
  onLayoutChange: (layout: TerminalLayout) => void;
  onRestoreWorkspace: (workspace: SavedSessionWorkspace) => void;
  restoreBusy: boolean;
  workspaceVisible: boolean;
  sessions: LiveSession[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onRequestConnection: () => void;
  onDisconnect: (sessionId: string) => Promise<void>;
  onReconnect: (sessionId: string) => Promise<void>;
  onReconnectSetup: (sessionId: string) => void;
  onAutoReconnectChange: (sessionId: string, enabled: boolean) => void;
  onLineEndingChange: (sessionId: string, lineEnding: LineEnding) => void;
  onClose: (sessionId: string) => Promise<void>;
  onConnectionStateChange: (sessionId: string, state: MonitorConnectionState) => void;
  onNativeSessionEnded: (sessionId: string) => void;
  onNativeStorageLimit: (sessionId: string) => void;
  onNativeSessionStartupFailure: (sessionId: string) => Promise<void>;
  onMonitorRef: (sessionId: string, monitor: LiveMonitorHandle | null) => void;
};

type SessionsView = TerminalLayout;

function SessionsWorkspace({ onStorageWarning, storageLimit, logDirectory, onStorageSettings, onSavedLogs, layout: view, onLayoutChange: setView, onRestoreWorkspace, restoreBusy, workspaceVisible, sessions, selectedSessionId, onSelect, onRequestConnection, onDisconnect, onReconnect, onReconnectSetup, onAutoReconnectChange, onLineEndingChange, onClose, onConnectionStateChange, onNativeSessionEnded, onNativeStorageLimit, onNativeSessionStartupFailure, onMonitorRef }: SessionsWorkspaceProps) {
  const activeCount = sessions.filter((session) => session.native && session.connectionState === 'connected').length;
  const [enteringSessionId, setEnteringSessionId] = useState<string | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const newTerminalButtonRef = useRef<HTMLButtonElement>(null);
  const tabTransitionTimerRef = useRef<number | null>(null);
  // Tiled mode keeps every monitor mounted; its desktop grid scrolls once the workspace is full.
  const showViewControl = sessions.length > 1;
  const activeView: SessionsView = showViewControl ? view : 'tabs';
  const monitorDisplayActive = (sessionId: string) => workspaceVisible && (activeView === 'tiled' || sessionId === selectedSessionId);
  const selectSession = (nextSessionId: string) => {
    if (activeView === 'tabs' && nextSessionId !== selectedSessionId) {
      setEnteringSessionId(nextSessionId);
      if (tabTransitionTimerRef.current !== null) window.clearTimeout(tabTransitionTimerRef.current);
      tabTransitionTimerRef.current = window.setTimeout(() => {
        tabTransitionTimerRef.current = null;
        setEnteringSessionId((current) => current === nextSessionId ? null : current);
      }, 32);
    }
    onSelect(nextSessionId);
  };
  const applySavedWorkspace = (workspace: SavedSessionWorkspace, matchingSessionIds: string[]) => {
    // This is deliberately presentation-only. A saved workspace never opens,
    // reconnects, disconnects, or otherwise changes a native serial reader.
    setView(workspace.layout);
    const selectedId = workspace.selectedSessionIdentity
      ? sessions.find((session) => (session.workspaceIdentity === workspace.selectedSessionIdentity || session.legacyWorkspaceIdentity === workspace.selectedSessionIdentity))?.id
      : undefined;
    const nextSelectedId = selectedId ?? matchingSessionIds[0] ?? selectedSessionId ?? sessions[0]?.id;
    if (nextSelectedId) selectSession(nextSelectedId);
  };
  const closeFromTab = async (sessionId: string) => {
    await onClose(sessionId);
    window.requestAnimationFrame(() => {
      const selectedTab = workspaceRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"], .sd-session-tab > button[aria-pressed="true"]');
      (selectedTab ?? newTerminalButtonRef.current)?.focus();
    });
  };

  return <section ref={workspaceRef} className="sd-sessions-workspace" aria-label="Live terminal workspace">
    <header className="sd-sessions-workspace-header"><div><h1>Live terminal</h1><span>{activeView === 'tiled' ? 'Compare active serial monitors side by side.' : 'Run independent serial monitors in separate terminal tabs.'}</span></div><div className="sd-sessions-workspace-actions">{showViewControl && <div className="sd-session-view-switch" role="group" aria-label="Terminal layout"><button type="button" className={view === 'tabs' ? 'is-selected' : ''} aria-pressed={view === 'tabs'} onClick={() => setView('tabs')}>Tabs</button><button type="button" className={view === 'tiled' ? 'is-selected' : ''} aria-pressed={view === 'tiled'} onClick={() => setView('tiled')}>Tiled</button></div>}<SessionWorkspaceManager layout={view} sessions={sessions.map((session) => ({ id: session.id, identity: session.workspaceIdentity, legacyIdentity: session.legacyWorkspaceIdentity, preset: {
        identity: session.workspaceIdentity, port: session.port, baudRate: session.baudRate, sessionName: session.sessionName, settings: session.settings,
        deviceIdentity: session.deviceIdentity, lineEnding: session.lineEnding, displayEncoding: session.displayEncoding, showTimestamps: session.showTimestamps,
        reconnectWhenDeviceReturns: session.reconnectWhenDeviceReturns, decoder: liveTelemetryStore.getSnapshot(session.uiKey).decoderProfile,
      } satisfies BenchConnectionPreset }))} selectedSessionId={selectedSessionId} onApply={applySavedWorkspace} onRestore={onRestoreWorkspace} restoreBusy={restoreBusy} /><span className="sd-session-count"><i className={activeCount ? 'is-active' : ''} /> {activeCount} active</span><button ref={newTerminalButtonRef} className="sd-primary-button" type="button" onClick={onRequestConnection}><Radio size={16} /> New terminal</button></div></header>
    <CaptureStorageBanner onWarning={onStorageWarning} nativeEnabled={nativeRuntime} limit={storageLimit} directory={logDirectory} stoppedCount={sessions.filter((session) => session.autoReconnectBlockedReason === 'storage-limit').length} onSettings={onStorageSettings} onLogs={onSavedLogs} onRetry={async () => { const failures: string[] = []; for (const session of sessions.filter((s) => s.autoReconnectBlockedReason === 'storage-limit')) { try { await onReconnect(session.id); } catch (error) { failures.push(`${session.sessionName}: ${error instanceof Error ? error.message : String(error)}`); } } if (failures.length) throw new Error(failures.join(' · ')); }} />
    {!sessions.length && <article className="sd-sessions-empty-panel"><div className="sd-sessions-empty-icon"><TerminalSquare size={21} /></div><div><h2>No terminal tabs are open.</h2><p>Use <strong>New terminal</strong> to add a live serial monitor to this workspace.</p></div></article>}
    {sessions.length > 0 && <>
      <div className="sd-session-tabs" role={activeView === 'tabs' ? 'tablist' : 'list'} aria-label={activeView === 'tabs' ? 'Open serial terminals' : 'Open serial terminals; select one for terminal actions'}>
        {sessions.map((session, index) => <div className={`sd-session-tab ${session.id === selectedSessionId ? 'is-selected' : ''}`} role={activeView === 'tiled' ? 'listitem' : undefined} key={session.id}>
          <button role={activeView === 'tabs' ? 'tab' : undefined} type="button" tabIndex={activeView === 'tabs' ? (session.id === selectedSessionId ? 0 : -1) : undefined} aria-selected={activeView === 'tabs' ? session.id === selectedSessionId : undefined} aria-pressed={activeView === 'tiled' ? session.id === selectedSessionId : undefined} aria-controls={activeView === 'tabs' ? `monitor-${session.uiKey}` : undefined} id={activeView === 'tabs' ? `tab-${session.uiKey}` : undefined} onClick={() => selectSession(session.id)} onKeyDown={(event) => { if (activeView !== 'tabs' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? sessions.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + sessions.length) % sessions.length; const next = sessions[nextIndex]; selectSession(next.id); requestAnimationFrame(() => document.getElementById(`tab-${next.uiKey}`)?.focus()); }}><i className={session.connectionState} /><span><strong>{session.sessionName}</strong><small>{session.port} · {session.connectionState}</small></span></button>
          <button className="sd-session-tab-close" type="button" onClick={() => void closeFromTab(session.id)} aria-label={`Close ${session.sessionName}`} title="Close terminal"><X size={14} /></button>
        </div>)}
      </div>
      <div className={`sd-session-monitors ${activeView === 'tiled' ? 'is-tiled' : ''}`} aria-label={activeView === 'tiled' ? 'Tiled serial terminals' : undefined}>
        {sessions.map((session) => <div className={`sd-session-panel ${session.id === enteringSessionId ? 'is-entering' : ''}`} id={`monitor-${session.uiKey}`} role={activeView === 'tabs' ? 'tabpanel' : 'region'} aria-labelledby={activeView === 'tabs' ? `tab-${session.uiKey}` : undefined} aria-label={activeView === 'tiled' ? `${session.sessionName} on ${session.port} terminal` : undefined} hidden={activeView === 'tabs' && session.id !== selectedSessionId} key={session.uiKey}>
          <LiveMonitor commandIdentity={session.workspaceIdentity} ref={(monitor) => onMonitorRef(session.id, monitor)} sessionName={session.sessionName} port={session.port} baudRate={session.baudRate} lineEnding={session.lineEnding} onLineEndingChange={(ending) => onLineEndingChange(session.id, ending)} displayEncoding={session.displayEncoding} showTimestamps={session.showTimestamps} sessionId={session.id} telemetrySessionKey={session.uiKey} nativeSession={session.native} displayActive={monitorDisplayActive(session.id)} capturePath={session.logPath} initialConnectionState={session.connectionState} autoReconnectEnabled={session.reconnectWhenDeviceReturns} autoReconnectStatus={session.autoReconnectStatus} autoReconnectBlockedReason={session.autoReconnectBlockedReason} autoReconnectBlockedDetail={session.autoReconnectBlockedDetail} onReconnectSetup={() => onReconnectSetup(session.id)} onAutoReconnectChange={session.native ? (enabled) => onAutoReconnectChange(session.id, enabled) : undefined} onConnectionStateChange={(state) => onConnectionStateChange(session.id, state)} onNativeSessionEnded={session.native ? (eventSessionId) => onNativeSessionEnded(eventSessionId) : undefined} onNativeStorageLimit={session.native ? (eventSessionId) => onNativeStorageLimit(eventSessionId) : undefined} onNativeSessionStartupFailure={session.native ? async () => { await onNativeSessionStartupFailure(session.id); } : undefined} onSend={session.native ? async (text) => { await sendNativeSerialText(session.id, text); } : undefined} onSendBytes={session.native ? async (bytes) => { await sendNativeSerialBytes(session.id, bytes); } : undefined} onDisconnect={session.native ? async () => { await onDisconnect(session.id); } : undefined} onReconnect={session.native ? async () => { await onReconnect(session.id); } : undefined} onClose={async () => { await onClose(session.id); }} />
        </div>)}
      </div>
    </>}
  </section>;
}

function TopThemeToggle({ theme, onThemeChange }: { theme: AppTheme; onThemeChange: (theme: AppTheme) => void }) {
  const options = [{ value: 'light', label: 'Light', Icon: Sun }, { value: 'dark', label: 'Dark', Icon: Moon }, { value: 'sage', label: 'Sage', Icon: Leaf }] as const;
  return <div className="sd-header-theme-toggle" role="group" aria-label="Application theme">{options.map(({ value, label, Icon }) => <button key={value} type="button" aria-label={`${label} theme`} title={`${label} theme`} aria-pressed={theme === value} onClick={() => onThemeChange(value)}><Icon size={16} /></button>)}</div>;
}

export default App;
