import { ArrowRight, Cable, Clock3, Radio, ShieldCheck, Sparkles } from 'lucide-react';
import baudTideMark from '../assets/signaldeck-mark.png';
import './welcome-screen.css';
import './welcome-motion.css';

type WelcomeScreenProps = { nativeEnabled: boolean; onConnect: () => void; onExplore: () => void };

/** The first-run surface; connection setup itself stays in the shared dialog. */
export function WelcomeScreen({ nativeEnabled, onConnect, onExplore }: WelcomeScreenProps) {
  return <section className="sd-welcome" aria-labelledby="welcome-title">
    <div className="sd-welcome-copy">
      <div className="sd-welcome-brand"><img src={baudTideMark} alt="" /><span>baud<span>tide</span></span></div>
      <p className="sd-welcome-eyebrow"><Sparkles size={13} /> SERIAL MONITORING, MADE CALM</p>
      <h1 id="welcome-title">A clear view of every byte in motion.</h1>
      <p className="sd-welcome-intro">Connect a board, open a terminal, and keep the signal in focus. BaudTide is ready when your device is.</p>
      <div className="sd-welcome-actions"><button className="sd-welcome-primary" type="button" onClick={onConnect}><Radio size={17} /> Connect a serial device <ArrowRight size={16} /></button><button className="sd-welcome-secondary" type="button" onClick={onExplore}>Explore device discovery</button></div>
      <p className="sd-welcome-runtime"><span className={nativeEnabled ? 'is-ready' : ''} />{nativeEnabled ? 'Desktop serial backend is ready' : 'Preview mode — connect in the desktop app'}</p>
    </div>
    <div className="sd-welcome-visual" aria-hidden="true">
      <div className="sd-welcome-orbit sd-welcome-orbit-one" /><div className="sd-welcome-orbit sd-welcome-orbit-two" />
      <div className="sd-welcome-terminal"><header><span><i /><i /><i /></span><strong><Cable size={14} /> /dev/ttyUSB0</strong><em>115200 baud</em></header><div className="sd-welcome-terminal-body"><p><b>14:32:01.002</b> boot: BaudTide connected</p><p><b>14:32:01.204</b> device: ESP32 DevKitC</p><p><b>14:32:02.412</b> wifi: station connected</p><p className="sd-welcome-terminal-live"><b>14:32:03.001</b> <span>●</span> listening for serial data</p></div><footer><span>LIVE CAPTURE</span><div><i /><i /><i /><i /><i /><i /><i /></div></footer></div>
      <div className="sd-welcome-float sd-welcome-float-status"><ShieldCheck size={17} /><span><small>CONNECTION</small><strong>Signal stable</strong></span></div><div className="sd-welcome-float sd-welcome-float-time"><Clock3 size={16} /><span><small>CAPTURE</small><strong>00:14:32</strong></span></div>
    </div>
    <div className="sd-welcome-features"><article><span><Radio size={17} /></span><div><strong>Device-first setup</strong><p>Pick a detected port or enter one manually.</p></div></article><article><span><Cable size={17} /></span><div><strong>Focused live terminals</strong><p>Keep each device in its own monitor tab.</p></div></article><article><span><ShieldCheck size={17} /></span><div><strong>Local by design</strong><p>Your device traffic stays on this machine.</p></div></article></div>
  </section>;
}
