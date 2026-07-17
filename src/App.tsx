import { useMemo, useState } from 'react';
import { CommandPalette, type CommandPaletteAction } from './components/CommandPalette';
import { ConnectionDialog, type ConnectionRequest } from './components/ConnectionDialog';
import { HelpFeedbackPanel } from './components/HelpFeedbackPanel';
import { LiveMonitor } from './components/LiveMonitor';
import { NotificationsPanel } from './components/NotificationsPanel';
import { PreferencesScreen } from './components/PreferencesScreen';
import { SidebarNavigation } from './components/SidebarNavigation';
import { SignalDeckPhaseTwo } from './components/SignalDeckPhaseTwo';
import { WorkspaceProfileMenu } from './components/WorkspaceProfileMenu';
import type { SignalDeckPage } from './components/phase3Types';

const pageNames: Record<SignalDeckPage, string> = {
  dashboard: 'Overview', sessions: 'Sessions', logs: 'Saved logs', preferences: 'Preferences', help: 'Help & feedback',
};

function App() {
  const [page, setPage] = useState<SignalDeckPage>('dashboard');
  const [isConnectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [liveSession, setLiveSession] = useState<ConnectionRequest | null>(null);
  const openConnectionDialog = () => setConnectionDialogOpen(true);
  const navigate = (nextPage: SignalDeckPage) => { setLiveSession(null); setPage(nextPage); };
  const commandActions = useMemo<CommandPaletteAction[]>(() => [
    { id: 'new-connection', label: 'New connection', description: 'Open the local connection setup preview', shortcut: 'N', icon: 'new' },
    { id: 'sessions', label: 'Open sessions', description: 'View sample multi-session panels', icon: 'session' },
    { id: 'logs', label: 'Search saved logs', description: 'Search the local-looking mock log list', icon: 'log' },
    { id: 'preferences', label: 'Open preferences', description: 'Configure local preview defaults', icon: 'preferences' },
  ], []);
  const runCommand = (action: CommandPaletteAction) => {
    if (action.id === 'new-connection') openConnectionDialog();
    if (action.id === 'sessions') navigate('sessions');
    if (action.id === 'logs') navigate('logs');
    if (action.id === 'preferences') navigate('preferences');
  };
  const startMockMonitoring = (request: ConnectionRequest) => { setConnectionDialogOpen(false); setLiveSession(request); setPage('sessions'); };

  return <div className="signaldeck-shell">
    <SidebarNavigation activePage={page} onNavigate={navigate} onPreferences={() => navigate('preferences')} onHelp={() => navigate('help')} />
    <section className="signaldeck-main">
      <header className="signaldeck-topbar">
        <div className="signaldeck-breadcrumb"><span>Workspace</span><b>/</b><strong>{liveSession ? liveSession.sessionName : pageNames[page]}</strong></div>
        <div className="signaldeck-preview-label">UI preview · no serial backend</div>
        <div className="signaldeck-topbar-actions"><CommandPalette actions={commandActions} onAction={runCommand} /><NotificationsPanel /><WorkspaceProfileMenu onPreferences={() => navigate('preferences')} /></div>
      </header>
      <div className="signaldeck-content">
        {liveSession ? <LiveMonitor sessionName={liveSession.sessionName} port={liveSession.port} baudRate={liveSession.baudRate} onClose={() => setLiveSession(null)} />
          : page === 'preferences' ? <PreferencesScreen />
            : page === 'help' ? <HelpFeedbackPanel />
              : <SignalDeckPhaseTwo page={page} onPageChange={(nextPage) => navigate(nextPage)} onRequestConnection={openConnectionDialog} />}
      </div>
    </section>
    <ConnectionDialog isOpen={isConnectionDialogOpen} onClose={() => setConnectionDialogOpen(false)} onStartMonitoring={startMockMonitoring} />
  </div>;
}

export default App;
