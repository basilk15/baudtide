import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, LoaderCircle, LockKeyhole, QrCode, Radio, ScanLine, ShieldCheck, Signal, Smartphone, TerminalSquare, Users, Wifi, WifiOff } from 'lucide-react';
import { listenForSerialData, type SerialDataEvent } from '../lib/serial';
import type { MonitorConnectionState } from './LiveMonitor';
import type { MobileSharePanelState } from './MobileSharePanel';
import './mobile-companion-preview.css';

export type MobilePreviewSession = {
  id: string;
  sessionName: string;
  port: string;
  native: boolean;
  connectionState: MonitorConnectionState;
};

type PhoneState = 'preview' | 'blocked' | 'idle' | 'creating' | 'ready' | 'connected' | 'control' | 'error';

type MobileCompanionPreviewProps = {
  nativeEnabled: boolean;
  selectedSession?: MobilePreviewSession;
  terminalShare: MobileSharePanelState | null;
  workspaceShare: MobileSharePanelState | null;
};

type PhoneFeedLine = {
  id: string;
  text: string;
  bytes: number;
  time: string;
};

function formatEventTime(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function feedLinesForEvent(event: SerialDataEvent): PhoneFeedLine[] {
  const textLines = event.text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3);
  const lines = textLines.length ? textLines : [event.bytes.length ? `Received ${event.bytes.length} bytes` : 'Received an empty packet'];
  return lines.map((line, index) => ({
    id: `${event.sessionId}-${event.sequence}-${index}`,
    text: line.slice(0, 42),
    bytes: event.bytes.length,
    time: formatEventTime(event.timestamp),
  }));
}

function stateLabel(state: PhoneState) {
  if (state === 'preview') return 'Preview shell';
  if (state === 'blocked') return 'Needs a terminal';
  if (state === 'idle') return 'Ready to share';
  if (state === 'creating') return 'Creating link';
  if (state === 'ready') return 'Waiting for phone';
  if (state === 'connected') return 'Phone connected';
  if (state === 'control') return 'Control enabled';
  return 'Needs attention';
}

function stateDescription(state: PhoneState, phoneCount: number) {
  if (state === 'preview') return 'The phone stage is available in browser preview; native sharing activates in the desktop app.';
  if (state === 'blocked') return 'Connect a native terminal to create a local pairing link.';
  if (state === 'idle') return 'Create a link below and this phone will switch into pairing mode.';
  if (state === 'creating') return 'Preparing a short-lived, read-only link for this terminal.';
  if (state === 'ready') return 'The link is live. Scan the QR code or open the link on the same Wi-Fi.';
  if (state === 'connected') return `${phoneCount} ${phoneCount === 1 ? 'phone is' : 'phones are'} receiving the live feed.`;
  if (state === 'control') return 'The connected phone can send serial writes because remote control is enabled.';
  return 'The link needs attention. The existing terminal data remains local.';
}

function PhoneWaveform({ active }: { active: boolean }) {
  return <div className={`sd-phone-waveform ${active ? 'is-active' : ''}`} aria-hidden="true">
    <span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span />
  </div>;
}

function PhonePairingView({ state }: { state: Extract<PhoneState, 'idle' | 'creating' | 'ready' | 'error'> }) {
  const isIdle = state === 'idle';
  const isCreating = state === 'creating';
  const isError = state === 'error';
  const Icon = isError ? AlertTriangle : isCreating ? LoaderCircle : isIdle ? Radio : QrCode;
  const eyebrow = isError ? 'LINK NEEDS ATTENTION' : isCreating ? 'PREPARING SHARE' : isIdle ? 'READY TO SHARE' : 'PAIRING READY';
  const status = isError ? 'Check the desktop link' : isCreating ? 'Creating a secure link' : isIdle ? 'Waiting for desktop link' : 'Waiting for a scan';
  return <div className={`sd-phone-pairing-view state-${state}`}>
    <div className={`sd-phone-pairing-icon state-${state}`}><Icon className={isCreating ? 'sd-spin' : ''} size={29} strokeWidth={1.7} aria-hidden="true" /><span /></div>
    <span className="sd-phone-eyebrow">{eyebrow}</span>
    <h3>{isError ? <>The link needs<br />a second look.</> : isCreating ? <>Setting up your<br />phone view.</> : isIdle ? <>Put the feed<br />in your pocket.</> : <>Bring the feed<br />to your phone.</>}</h3>
    <p>{isError ? 'The desktop could not keep the mobile share active. Create a fresh link to try again.' : isCreating ? 'The desktop is preparing a short-lived pairing link for this terminal.' : isIdle ? 'Create a local link below and the phone will switch into pairing mode.' : 'Scan the desktop QR code to join this local terminal stream.'}</p>
    <div className="sd-phone-scan-status"><ScanLine size={14} aria-hidden="true" /><span>{status}</span><i /></div>
  </div>;
}

function PhoneBlockedView({ state }: { state: PhoneState }) {
  const isPreview = state === 'preview';
  return <div className="sd-phone-blocked-view">
    <div className="sd-phone-blocked-icon">{isPreview ? <Smartphone size={27} strokeWidth={1.7} aria-hidden="true" /> : <WifiOff size={27} strokeWidth={1.7} aria-hidden="true" />}</div>
    <span className="sd-phone-eyebrow">{isPreview ? 'DESKTOP PREVIEW' : 'NO LIVE TERMINAL'}</span>
    <h3>{isPreview ? <>A pocket view<br />for your feed.</> : <>Connect a terminal<br />to begin.</>}</h3>
    <p>{isPreview ? 'This device stage mirrors the native share experience without opening a serial port.' : 'The phone waits here until a native serial session is connected.'}</p>
    <div className="sd-phone-scan-status"><LockKeyhole size={14} aria-hidden="true" /><span>{isPreview ? 'Read-only preview' : 'Pairing unavailable'}</span></div>
  </div>;
}

function PhoneStreamView({
  selectedSession,
  phoneCount,
  controlEnabled,
  isWorking,
  feed,
  pulse,
}: {
  selectedSession?: MobilePreviewSession;
  phoneCount: number;
  controlEnabled: boolean;
  isWorking: boolean;
  feed: PhoneFeedLine[];
  pulse: number;
}) {
  const isLive = phoneCount > 0;
  return <div className="sd-phone-stream-view">
    <div className="sd-phone-stream-heading">
      <div><span className={`sd-phone-live-dot ${isLive ? 'is-live' : ''}`} /><span>{isWorking ? 'SYNCING LINK' : isLive ? 'LIVE FEED' : 'LINK READY'}</span></div>
      <span>{phoneCount ? `${phoneCount} ${phoneCount === 1 ? 'device' : 'devices'}` : 'No device yet'}</span>
    </div>
    <div className="sd-phone-stream-title">
      <span>{selectedSession?.sessionName ?? 'Serial terminal'}</span>
      <strong>{controlEnabled ? 'CONTROL' : 'READ ONLY'}</strong>
    </div>
    <div className="sd-phone-receive-panel">
      <div className="sd-phone-receive-label"><span>INCOMING SERIAL</span><Activity size={13} aria-hidden="true" /></div>
      <PhoneWaveform active={isLive} />
      <div className="sd-phone-receive-state"><span>{isLive ? 'Receiving as it arrives' : 'Waiting for phone to join'}</span><span className="sd-phone-pulse-count">{pulse ? `packet ${pulse}` : '—'}</span></div>
    </div>
    <div className="sd-phone-feed-list" aria-live="polite">
      <div className="sd-phone-feed-list-heading"><span>RECENT PACKETS</span><span>{selectedSession?.port ?? 'PORT'}</span></div>
      {feed.length ? feed.map((line, index) => <div className={`sd-phone-feed-line ${index === feed.length - 1 && isLive ? 'is-new' : ''}`} key={line.id}>
        <span className="sd-phone-feed-time">{line.time}</span>
        <span className="sd-phone-feed-text">{line.text}</span>
        <span className="sd-phone-feed-bytes">{line.bytes}B</span>
      </div>) : <div className="sd-phone-feed-empty"><span className="sd-phone-empty-caret" />{isLive ? 'Listening for the next packet…' : 'Scan the QR code to start the stream.'}</div>}
    </div>
    <div className={`sd-phone-permission ${controlEnabled ? 'is-control' : ''}`}><ShieldCheck size={14} aria-hidden="true" /><span>{controlEnabled ? 'Remote control is on' : 'Read-only by default'}</span></div>
  </div>;
}

function PhoneStatusIcon({ state }: { state: PhoneState }) {
  if (state === 'error') return <AlertTriangle size={14} aria-hidden="true" />;
  if (state === 'creating') return <LoaderCircle className="sd-spin" size={14} aria-hidden="true" />;
  if (state === 'ready') return <QrCode size={14} aria-hidden="true" />;
  if (state === 'connected' || state === 'control') return <CheckCircle2 size={14} aria-hidden="true" />;
  return <Radio size={14} aria-hidden="true" />;
}

export function MobileCompanionPreview({ nativeEnabled, selectedSession, terminalShare, workspaceShare }: MobileCompanionPreviewProps) {
  const [feed, setFeed] = useState<PhoneFeedLine[]>([]);
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    setFeed([]);
    setPulse(0);
    if (!nativeEnabled || !selectedSession?.native || selectedSession.connectionState !== 'connected') return undefined;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    const onData = (event: SerialDataEvent) => {
      if (disposed) return;
      setFeed((current) => [...current, ...feedLinesForEvent(event)].slice(-4));
      setPulse((current) => current + 1);
    };
    void listenForSerialData(selectedSession.id, onData).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch(() => {
      // The terminal can disappear while the mobile page is mounting. The
      // phone stays useful as a share-status surface in that case.
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeEnabled, selectedSession?.connectionState, selectedSession?.id, selectedSession?.native]);

  const effectiveShare = useMemo(() => {
    if (terminalShare?.active) return terminalShare;
    if (workspaceShare?.active) return workspaceShare;
    return terminalShare ?? workspaceShare;
  }, [terminalShare, workspaceShare]);
  const linkActive = Boolean(effectiveShare?.active);
  const phoneCount = effectiveShare?.clientCount ?? 0;
  const controlEnabled = Boolean(effectiveShare?.controlEnabled);
  const notice = effectiveShare?.notice ?? null;
  const isWorking = Boolean(effectiveShare?.isWorking);

  let state: PhoneState;
  if (notice?.kind === 'error') state = 'error';
  else if (!nativeEnabled) state = 'preview';
  else if (!selectedSession || !selectedSession.native || selectedSession.connectionState !== 'connected') state = 'blocked';
  else if (isWorking && !linkActive) state = 'creating';
  else if (controlEnabled && phoneCount > 0) state = 'control';
  else if (phoneCount > 0) state = 'connected';
  else if (linkActive) state = 'ready';
  else state = 'idle';

  const scopeLabel = effectiveShare?.scope === 'workspace' ? 'Workspace link' : 'Terminal link';
  const sharingLabel = selectedSession ? selectedSession.sessionName : 'No terminal selected';
  const linkLabel = isWorking ? (linkActive ? 'Updating the mobile link' : 'Preparing a secure pairing link') : linkActive ? `${scopeLabel} is available` : 'No phone link created yet';
  const liveDescription = isWorking ? (linkActive ? 'The phone remains visible while its link state updates.' : 'Preparing a short-lived, read-only link for this terminal.') : stateDescription(state, phoneCount);
  const stepOneDone = linkActive || state === 'connected' || state === 'control';
  const stepTwoDone = phoneCount > 0;
  const stepThreeDone = phoneCount > 0 && feed.length > 0;

  return <section className="sd-mobile-companion-stage" aria-labelledby="mobile-companion-preview-title">
    <div className="sd-mobile-companion-copy">
      <div className="sd-mobile-companion-title-row">
        <span className={`sd-mobile-companion-status state-${state}`}><PhoneStatusIcon state={state} />{stateLabel(state)}</span>
        {linkActive && effectiveShare?.scope && <span className="sd-mobile-companion-scope"><Users size={13} aria-hidden="true" />{scopeLabel}</span>}
      </div>
      <h2 id="mobile-companion-preview-title">A live terminal,<br /><em>ready for your pocket.</em></h2>
      <p className="sd-mobile-companion-lede">Watch the same serial feed land on a focused phone view. The preview changes with the share link, QR scan, connection, and permissions.</p>

      <div className="sd-mobile-companion-context">
        <div><span>Sharing</span><strong>{sharingLabel}</strong><small>{selectedSession?.port ?? 'Choose a connected native terminal'}</small></div>
        <div><span>Delivery</span><strong>{linkLabel}</strong><small>{stateDescription(state, phoneCount)}</small></div>
      </div>

      <ol className="sd-mobile-companion-steps" aria-label="Mobile share status">
        <li className={stepOneDone ? 'is-done' : state === 'creating' ? 'is-current' : ''}><span>1</span><div><strong>Pairing link</strong><small>{stepOneDone ? 'QR code is ready' : state === 'creating' ? 'Creating now' : 'Create from the terminal card'}</small></div></li>
        <li className={stepTwoDone ? 'is-done' : stepOneDone ? 'is-current' : ''}><span>2</span><div><strong>Phone joins</strong><small>{stepTwoDone ? `${phoneCount} connected` : 'Scan or open the link'}</small></div></li>
        <li className={stepThreeDone ? 'is-done' : stepTwoDone ? 'is-current' : ''}><span>3</span><div><strong>Feed arrives</strong><small>{stepThreeDone ? 'Latest packets are visible' : 'Incoming data animates here'}</small></div></li>
      </ol>

      <p className="sd-mobile-companion-event" role="status"><span className="sd-mobile-companion-event-dot" />{notice?.text ?? liveDescription}</p>
    </div>

    <div className={`sd-phone-stage state-${state}`}>
      <div className="sd-phone-signal-note"><Signal size={14} aria-hidden="true" /><span>{phoneCount ? 'Signal is flowing' : 'Local link standby'}</span></div>
      <div className="sd-phone-device" role="img" aria-label={`Mobile companion preview: ${stateLabel(state)}`}>
        <svg className="sd-phone-border-ray" aria-hidden="true">
          <rect className="sd-phone-border-ray-halo" x="0.5" y="0.5" width="calc(100% - 1px)" height="calc(100% - 1px)" rx="51.5" ry="51.5" pathLength={1000} />
          <rect className="sd-phone-border-ray-trail" x="0.5" y="0.5" width="calc(100% - 1px)" height="calc(100% - 1px)" rx="51.5" ry="51.5" pathLength={1000} />
          <rect className="sd-phone-border-ray-core" x="0.5" y="0.5" width="calc(100% - 1px)" height="calc(100% - 1px)" rx="51.5" ry="51.5" pathLength={1000} />
        </svg>
        <span className="sd-phone-side-button side-top" aria-hidden="true" />
        <span className="sd-phone-side-button side-middle" aria-hidden="true" />
        <span className="sd-phone-side-button side-power" aria-hidden="true" />
        <div className="sd-phone-hardware">
          <div className="sd-phone-island" aria-hidden="true"><span /><span /></div>
          <div className="sd-phone-status-bar"><span>9:41</span><span><Signal size={11} /><Wifi size={11} /><i /></span></div>
          <div className="sd-phone-screen">
            <header className="sd-phone-app-header">
              <div className="sd-phone-brand"><span>B</span><div><strong>BaudTide</strong><small>Mobile companion</small></div></div>
              <span className="sd-phone-app-state"><i />{isWorking ? 'SYNC' : state === 'connected' || state === 'control' ? 'LIVE' : 'LOCAL'}</span>
            </header>
            {state === 'preview' || state === 'blocked' ? <PhoneBlockedView state={state} /> : state === 'idle' || state === 'creating' || state === 'ready' || state === 'error' ? <PhonePairingView state={state} /> : <PhoneStreamView selectedSession={selectedSession} phoneCount={phoneCount} controlEnabled={controlEnabled} isWorking={isWorking} feed={feed} pulse={pulse} />}
            <div className="sd-phone-screen-footer"><span><TerminalSquare size={11} aria-hidden="true" />{selectedSession?.port ?? 'Awaiting terminal'}</span><span>{state === 'error' ? 'LINK ERROR' : controlEnabled ? 'CONTROL' : 'READ ONLY'}</span></div>
          </div>
          <div className="sd-phone-home-indicator" aria-hidden="true" />
        </div>
      </div>
    </div>
  </section>;
}
