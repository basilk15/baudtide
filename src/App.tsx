import { useEffect, useMemo, useState } from 'react';
import { CommandPalette, type CommandPaletteAction } from './components/CommandPalette';
import { ConnectionDialog, type ConnectionRequest } from './components/ConnectionDialog';
import { HelpFeedbackPanel } from './components/HelpFeedbackPanel';
import { LiveMonitor } from './components/LiveMonitor';
import { NotificationsPanel } from './components/NotificationsPanel';
import { PreferencesScreen } from './components/PreferencesScreen';
import { SavedLogsScreen } from './components/SavedLogsScreen';
import { PortDiscoveryDashboard } from './components/PortDiscoveryDashboard';
import { SidebarNavigation } from './components/SidebarNavigation';
import { WorkspaceProfileMenu } from './components/WorkspaceProfileMenu';
import type { SignalDeckPage } from './components/phase3Types';
import { Moon, Radio, Sun, TerminalSquare } from 'lucide-react';
import './light-theme.css';
import './components/theme-toggle.css';
import {
  disconnectNativeSerialSession,
  isTauriRuntime,
  listNativeSerialPorts,
  sendNativeSerialText,
  startNativeSerialSession,
  type NativeSerialPort,
} from './lib/serial';

const pageNames: Record<SignalDeckPage, string> = {
  dashboard: 'Overview', sessions: 'Live terminal', logs: 'Saved logs', preferences: 'Preferences', help: 'Help & feedback',
};

type LiveSession = ConnectionRequest & {
  id?: string;
  native: boolean;
  logPath?: string;
};

type AppTheme = 'dark' | 'light';

const nativeRuntime = isTauriRuntime();

function App() {
  const [page, setPage] = useState<SignalDeckPage>('dashboard');
  const [isConnectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionDefaults, setConnectionDefaults] = useState<Pick<ConnectionRequest, 'port' | 'sessionName'> | null>(null);
  const [liveSession, setLiveSession] = useState<LiveSession | null>(null);
  const [theme, setTheme] = useState<AppTheme>('dark');
  const [zoom, setZoom] = useState(1);
  const openConnectionDialog = (port?: NativeSerialPort) => {
    setConnectionDefaults(port ? { port: port.path, sessionName: port.label } : null);
    setConnectionDialogOpen(true);
  };
  const navigate = (nextPage: SignalDeckPage) => setPage(nextPage);
  const commandActions = useMemo<CommandPaletteAction[]>(() => [
    { id: 'new-connection', label: 'New connection', description: 'Choose a serial port and start monitoring', shortcut: 'N', icon: 'new' },
    { id: 'sessions', label: 'Open live terminal', description: 'View active serial terminals', icon: 'session' },
    { id: 'logs', label: 'Open saved logs', description: 'Browse captured serial logs', icon: 'log' },
    { id: 'preferences', label: 'Open preferences', description: 'Configure application defaults', icon: 'preferences' },
  ], []);
  const runCommand = (action: CommandPaletteAction) => {
    if (action.id === 'new-connection') openConnectionDialog();
    if (action.id === 'sessions') navigate('sessions');
    if (action.id === 'logs') navigate('logs');
    if (action.id === 'preferences') navigate('preferences');
  };
  const startMonitoring = async (request: ConnectionRequest) => {
    if (nativeRuntime) {
      const session = await startNativeSerialSession(request);
      setLiveSession({ ...request, id: session.id, native: true, logPath: session.logPath });
    } else {
      setLiveSession({ ...request, native: false });
    }
    setConnectionDialogOpen(false);
    setPage('sessions');
  };
  const disconnectLiveSession = async () => {
    if (liveSession?.native && liveSession.id) await disconnectNativeSerialSession(liveSession.id);
  };
  const closeLiveSession = async () => {
    try { await disconnectLiveSession(); } finally { setLiveSession(null); }
  };
  const reconnectLiveSession = async () => {
    if (!liveSession?.native) return;
    const session = await startNativeSerialSession(liveSession);
    setLiveSession((current) => current ? { ...current, id: session.id, logPath: session.logPath } : current);
  };

  useEffect(() => {
    let wheelDelta = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const increase = event.key === '+' || event.key === '=' || event.code === 'NumpadAdd';
      const decrease = event.key === '-' || event.code === 'NumpadSubtract';
      if (increase) {
        event.preventDefault();
        setZoom((current) => Math.min(1.6, Number((current + 0.1).toFixed(2))));
      } else if (decrease) {
        event.preventDefault();
        setZoom((current) => Math.max(0.8, Number((current - 0.1).toFixed(2))));
      } else if (event.key === '0' || event.code === 'Numpad0') {
        event.preventDefault();
        setZoom(1);
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.deltaY === 0) return;
      event.preventDefault();
      wheelDelta += event.deltaY;
      if (Math.abs(wheelDelta) < 50) return;
      const direction = wheelDelta > 0 ? -0.1 : 0.1;
      wheelDelta = 0;
      setZoom((current) => Math.min(1.6, Math.max(0.8, Number((current + direction).toFixed(2)))));
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('wheel', onWheel);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.body.classList.toggle('theme-light', theme === 'light');
    return () => {
      document.body.classList.remove('theme-light');
      delete document.documentElement.dataset.theme;
    };
  }, [theme]);

  return <div className={`signaldeck-shell theme-${theme}`} style={{ zoom }}>
    <SidebarNavigation activePage={page} onNavigate={navigate} onPreferences={() => navigate('preferences')} onHelp={() => navigate('help')} />
    <section className="signaldeck-main">
      <header className="signaldeck-topbar">
        <div className="signaldeck-breadcrumb"><span>Workspace</span><b>/</b><strong>{page === 'sessions' && liveSession ? liveSession.sessionName : pageNames[page]}</strong></div>
        <div className={`signaldeck-preview-label ${nativeRuntime ? 'native' : ''}`}>{nativeRuntime ? 'Desktop mode · serial backend ready' : 'Browser preview · no serial backend'}</div>
        <div className="signaldeck-topbar-actions"><CommandPalette actions={commandActions} onAction={runCommand} /><TopThemeToggle theme={theme} onThemeChange={setTheme} /><NotificationsPanel /><WorkspaceProfileMenu onPreferences={() => navigate('preferences')} /></div>
      </header>
      <div className="signaldeck-content">
        {liveSession && <div hidden={page !== 'sessions'}><LiveMonitor sessionName={liveSession.sessionName} port={liveSession.port} baudRate={liveSession.baudRate} sessionId={liveSession.id} nativeSession={liveSession.native} onSend={async (text) => { if (liveSession.native && liveSession.id) await sendNativeSerialText(liveSession.id, text); }} onDisconnect={disconnectLiveSession} onReconnect={reconnectLiveSession} onClose={closeLiveSession} /></div>}
        {(!liveSession || page !== 'sessions') && (page === 'preferences' ? <PreferencesScreen theme={theme} onThemeChange={setTheme} />
          : page === 'help' ? <HelpFeedbackPanel />
            : page === 'logs' ? <SavedLogsScreen nativeEnabled={nativeRuntime} activeLogPath={liveSession?.logPath} onRequestConnection={openConnectionDialog} />
              : page === 'sessions' ? <SessionsWorkspace onRequestConnection={openConnectionDialog} />
                : <PortDiscoveryDashboard nativeEnabled={nativeRuntime} onScan={listNativeSerialPorts} onConnect={openConnectionDialog} onRequestConnection={openConnectionDialog} />)}
      </div>
    </section>
    <ConnectionDialog isOpen={isConnectionDialogOpen} onClose={() => { setConnectionDialogOpen(false); setConnectionDefaults(null); }} onStartMonitoring={startMonitoring} onScan={nativeRuntime ? listNativeSerialPorts : undefined} initialPort={connectionDefaults?.port} initialSessionName={connectionDefaults?.sessionName} nativeEnabled={nativeRuntime} />
  </div>;
}

function SessionsWorkspace({ onRequestConnection }: { onRequestConnection: () => void }) {
  return <section className="sd-sessions-workspace" aria-label="Live terminal workspace">
    <header className="sd-sessions-workspace-header"><div><p>LIVE TERMINAL WORKSPACE</p><h1>Live terminal</h1><span>Run independent serial monitors side by side.</span></div><div className="sd-sessions-workspace-actions"><span className="sd-session-count"><i /> 0 active</span><button className="sd-primary-button" type="button" onClick={onRequestConnection}><Radio size={16} /> New terminal</button></div></header>
    <article className="sd-sessions-empty-panel"><div className="sd-sessions-empty-icon"><TerminalSquare size={21} /></div><div><h2>No terminal tabs are open.</h2><p>Use <strong>New terminal</strong> to add a live serial monitor to this workspace.</p></div></article>
  </section>;
}

function TopThemeToggle({ theme, onThemeChange }: { theme: AppTheme; onThemeChange: (theme: AppTheme) => void }) {
  const isLight = theme === 'light';
  return <button className={`sd-top-theme-toggle ${isLight ? 'is-light' : ''}`} type="button" aria-label={`Switch to ${isLight ? 'dark' : 'light'} theme`} aria-pressed={isLight} title={`Switch to ${isLight ? 'dark' : 'light'} theme`} onClick={() => onThemeChange(isLight ? 'dark' : 'light')}><Sun className="sd-theme-sun" size={14} /><Moon className="sd-theme-moon" size={13} /><span><i>{isLight ? <Sun size={12} /> : <Moon size={11} />}</i></span></button>;
}

export default App;
