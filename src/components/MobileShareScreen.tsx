import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, ShieldCheck, Smartphone, TerminalSquare } from 'lucide-react';
import { MobileCompanionPreview } from './MobileCompanionPreview';
import { MobileSharePanel, type MobileSharePanelState, WorkspaceMobileSharePanel } from './MobileSharePanel';
import type { MonitorConnectionState } from './LiveMonitor';
import './mobile-share-screen.css';
import './mobile-share-rails.css';

export type MobileShareSession = {
  id: string;
  sessionName: string;
  port: string;
  native: boolean;
  connectionState: MonitorConnectionState;
};

type MobileShareScreenProps = {
  nativeEnabled: boolean;
  sessions: MobileShareSession[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
};

function connectionLabel(state: MonitorConnectionState) {
  if (state === 'connected') return 'Connected';
  if (state === 'reconnecting') return 'Reconnecting';
  if (state === 'error') return 'Needs attention';
  return 'Disconnected';
}

export function MobileShareScreen({ nativeEnabled, sessions, selectedSessionId, onSelectSession }: MobileShareScreenProps) {
  const selectedSession = sessions.find((session) => session.id === selectedSessionId);
  const activeSessionCount = sessions.filter((session) => session.native && session.connectionState === 'connected').length;
  const [terminalShareState, setTerminalShareState] = useState<MobileSharePanelState | null>(null);
  const [workspaceShareState, setWorkspaceShareState] = useState<MobileSharePanelState | null>(null);
  const onTerminalShareStateChange = useCallback((state: MobileSharePanelState) => setTerminalShareState(state), []);
  const onWorkspaceShareStateChange = useCallback((state: MobileSharePanelState) => setWorkspaceShareState(state), []);

  useEffect(() => {
    setTerminalShareState(null);
  }, [selectedSessionId]);

  const previewStatus = !nativeEnabled
    ? 'Browser preview'
    : terminalShareState?.active || workspaceShareState?.active
      ? 'Link ready to scan'
      : selectedSession
        ? `${selectedSession.sessionName} selected`
        : 'Choose a connected terminal';

  return (
    <section className="sd-mobile-share-screen" aria-label="Mobile share workspace">
      <header className="sd-mobile-share-screen-header">
        <div className="sd-mobile-share-screen-heading">
          <div className="sd-mobile-share-screen-icon"><Smartphone size={22} aria-hidden="true" /></div>
          <div>
            <h1>Mobile share</h1>
            <span>Pair a phone with a live serial feed.</span>
          </div>
        </div>
        <div className="sd-mobile-share-screen-status">
          <span><i className={activeSessionCount ? 'is-active' : ''} /> {activeSessionCount} active</span>
          <small>Same network</small>
        </div>
      </header>

      <div className="sd-mobile-share-screen-note">
        <ShieldCheck size={17} aria-hidden="true" />
        <div><strong>Read-only by default</strong><span>Same-network links · control stays off until enabled.</span></div>
      </div>

      <section className="sd-mobile-share-session-picker" aria-labelledby="mobile-share-session-heading">
        <div className="sd-mobile-share-section-heading">
          <div><h2 id="mobile-share-session-heading">Choose a terminal</h2><span>Source for the phone view.</span></div>
          <span>{sessions.length} open</span>
        </div>
        {sessions.length ? <div className="sd-mobile-share-session-list">
          {sessions.map((session) => {
            const isSelected = session.id === selectedSessionId;
            return <button
              className={`sd-mobile-share-session ${isSelected ? 'is-selected' : ''}`}
              type="button"
              key={session.id}
              aria-pressed={isSelected}
              onClick={() => onSelectSession(session.id)}
            >
              <i className={`sd-mobile-share-session-dot ${session.connectionState}`} />
              <span><strong>{session.sessionName}</strong><small>{session.port} · {connectionLabel(session.connectionState)}</small></span>
              {isSelected ? <Check size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            </button>;
          })}
        </div> : <div className="sd-mobile-share-session-empty">
          <TerminalSquare size={17} aria-hidden="true" />
          <span><strong>No terminals open</strong><small>Open a live terminal to share one feed.</small></span>
        </div>}
      </section>

      <div className="sd-mobile-share-screen-grid">
        <WorkspaceMobileSharePanel nativeEnabled={nativeEnabled} activeSessionCount={activeSessionCount} onStateChange={onWorkspaceShareStateChange} />

        <section className="sd-mobile-share-terminal-card" aria-labelledby="mobile-share-terminal-heading">
          <div className="sd-mobile-share-terminal-heading">
            <div className="sd-mobile-share-selected-session">
              <div className="sd-mobile-share-terminal-icon"><TerminalSquare size={18} aria-hidden="true" /></div>
              <div>
                <h2 id="mobile-share-terminal-heading">{selectedSession?.sessionName ?? 'Terminal link'}</h2>
                <span>{selectedSession ? `${selectedSession.port} · ${connectionLabel(selectedSession.connectionState)}` : 'Select a terminal above.'}</span>
              </div>
            </div>
            {selectedSession && <span className={`sd-mobile-share-terminal-status ${selectedSession.connectionState}`}><i />{connectionLabel(selectedSession.connectionState)}</span>}
          </div>

          {selectedSession ? <MobileSharePanel
            sessionId={selectedSession.id}
            nativeSession={selectedSession.native}
            sessionConnected={selectedSession.connectionState === 'connected'}
            onStateChange={onTerminalShareStateChange}
          /> : <div className="sd-mobile-share-terminal-empty">
            <Smartphone size={19} aria-hidden="true" />
            <strong>No terminal selected</strong>
            <span>Select one above to manage its pairing link.</span>
          </div>}
        </section>
      </div>

      <details className="sd-mobile-share-preview-disclosure">
        <summary>
          <span className="sd-mobile-share-preview-disclosure-icon"><Smartphone size={16} aria-hidden="true" /></span>
          <span className="sd-mobile-share-preview-disclosure-copy"><strong>Phone preview</strong><small>{previewStatus}</small></span>
          <ChevronDown className="sd-mobile-share-preview-disclosure-chevron" size={17} aria-hidden="true" />
        </summary>
        <div className="sd-mobile-share-preview-body">
          <MobileCompanionPreview
            nativeEnabled={nativeEnabled}
            selectedSession={selectedSession}
            terminalShare={terminalShareState}
            workspaceShare={workspaceShareState}
          />
        </div>
      </details>
    </section>
  );
}
