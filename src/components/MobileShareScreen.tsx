import { Check, ChevronRight, ShieldCheck, Smartphone, TerminalSquare } from 'lucide-react';
import { MobileSharePanel, WorkspaceMobileSharePanel } from './MobileSharePanel';
import type { MonitorConnectionState } from './LiveMonitor';
import './mobile-share-screen.css';

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

  return (
    <section className="sd-mobile-share-screen" aria-label="Mobile share workspace">
      <header className="sd-mobile-share-screen-header">
        <div className="sd-mobile-share-screen-heading">
          <div className="sd-mobile-share-screen-icon"><Smartphone size={22} aria-hidden="true" /></div>
          <div>
            <p>MOBILE COMPANION</p>
            <h1>Mobile share</h1>
            <span>Give a phone a focused view of your serial data without crowding the live terminal workspace.</span>
          </div>
        </div>
        <div className="sd-mobile-share-screen-status">
          <span><i className={activeSessionCount ? 'is-active' : ''} /> {activeSessionCount} active</span>
          <small>Local network only</small>
        </div>
      </header>

      <div className="sd-mobile-share-screen-note">
        <ShieldCheck size={17} aria-hidden="true" />
        <div><strong>Read-only by default</strong><span>Links work on the same local network. Remote control stays off until you explicitly enable it for a live terminal.</span></div>
      </div>

      <section className="sd-mobile-share-session-picker" aria-labelledby="mobile-share-session-heading">
        <div className="sd-mobile-share-section-heading">
          <div><p>TERMINAL LINKS</p><h2 id="mobile-share-session-heading">Choose a terminal to share</h2></div>
          <span>{sessions.length} {sessions.length === 1 ? 'terminal' : 'terminals'} open</span>
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
          <span><strong>No terminals are open</strong><small>Open a live terminal to create a link for one device, or share the whole workspace.</small></span>
        </div>}
      </section>

      <div className="sd-mobile-share-screen-grid">
        <WorkspaceMobileSharePanel nativeEnabled={nativeEnabled} activeSessionCount={activeSessionCount} />

        <section className="sd-mobile-share-terminal-card" aria-labelledby="mobile-share-terminal-heading">
          <div className="sd-mobile-share-terminal-heading">
            <div className="sd-mobile-share-selected-session">
              <div className="sd-mobile-share-terminal-icon"><TerminalSquare size={18} aria-hidden="true" /></div>
              <div>
                <p>SELECTED TERMINAL</p>
                <h2 id="mobile-share-terminal-heading">{selectedSession?.sessionName ?? 'Choose a terminal'}</h2>
                <span>{selectedSession ? `${selectedSession.port} · ${connectionLabel(selectedSession.connectionState)}` : 'Select a terminal above to manage its mobile link.'}</span>
              </div>
            </div>
            {selectedSession && <span className={`sd-mobile-share-terminal-status ${selectedSession.connectionState}`}><i />{connectionLabel(selectedSession.connectionState)}</span>}
          </div>

          {selectedSession ? <MobileSharePanel
            sessionId={selectedSession.id}
            nativeSession={selectedSession.native}
            sessionConnected={selectedSession.connectionState === 'connected'}
          /> : <div className="sd-mobile-share-terminal-empty">
            <Smartphone size={19} aria-hidden="true" />
            <strong>Select a terminal above</strong>
            <span>Its read-only pairing link and remote-control settings will appear here.</span>
          </div>}
        </section>
      </div>
    </section>
  );
}
