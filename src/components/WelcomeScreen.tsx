import { Activity, ArrowRight, Radio, ShieldCheck, Sparkles } from 'lucide-react';
import './welcome-screen.css';
import './welcome-motion.css';

type WelcomeScreenProps = { nativeEnabled: boolean; onConnect: () => void; onExplore: () => void };

/** The first-run surface; connection setup itself stays in the shared dialog. */
export function WelcomeScreen({ nativeEnabled, onConnect, onExplore }: WelcomeScreenProps) {
  return <section className="sd-welcome" aria-labelledby="welcome-title">
    <div className="sd-welcome-copy">
      <p className="sd-welcome-eyebrow"><Sparkles size={13} /> SERIAL MONITORING, MADE CALM</p>
      <h1 id="welcome-title">A clear view of every byte in motion.</h1>
      <p className="sd-welcome-intro">Connect a board, open a terminal, and keep the signal in focus. BaudTide is ready when your device is.</p>
      <div className="sd-welcome-actions"><button className="sd-welcome-primary" type="button" onClick={onConnect}><Radio size={17} /> Connect a serial device <ArrowRight size={16} /></button><button className="sd-welcome-secondary" type="button" onClick={onExplore}>Explore device discovery</button></div>
      <p className="sd-welcome-runtime"><span className={nativeEnabled ? 'is-ready' : ''} />{nativeEnabled ? 'Desktop serial backend is ready' : 'Preview mode — connect in the desktop app'}</p>
    </div>
    <div className="sd-welcome-visual" aria-hidden="true">
      <div className="sd-welcome-instrument">
        <div className="sd-welcome-instrument-heading"><span>Illustrative trace</span><span>3 fields · 30 s window</span></div>
        <svg className="sd-welcome-trace" viewBox="0 0 620 300" role="img" aria-label="Illustrative telemetry trace">
          <path className="sd-welcome-trace-grid" d="M16 34H604M16 92H604M16 150H604M16 208H604M16 266H604M52 14V286M156 14V286M260 14V286M364 14V286M468 14V286M572 14V286" />
          <path className="sd-welcome-trace-secondary" d="M16 205C47 198 54 188 79 195S118 224 145 211S188 171 214 180S248 209 276 199S321 163 347 171S390 221 418 206S463 161 489 176S532 216 558 199S585 174 604 181" />
          <path className="sd-welcome-trace-primary" d="M16 168C35 168 40 112 61 128S82 185 104 161S123 96 146 111S171 215 192 195S218 123 239 144S260 182 281 159S308 68 332 96S356 236 379 211S407 130 430 150S452 184 474 162S503 86 526 111S554 199 575 177S593 142 604 147" />
          <circle className="sd-welcome-trace-point" cx="526" cy="111" r="5" />
        </svg>
        <div className="sd-welcome-instrument-footer"><span><i className="is-live" /> Signal ready to inspect</span><span className="sd-welcome-instrument-unit"><Activity size={14} /> voltage / temperature / current</span></div>
      </div>
      <div className="sd-welcome-float sd-welcome-float-status"><ShieldCheck size={17} /><span><small>SESSION</small><strong>Ready to inspect</strong></span></div>
    </div>
    <div className="sd-welcome-features"><article><span><Radio size={17} /></span><div><strong>Device-first setup</strong><p>Pick a detected port or enter one manually.</p></div></article><article><span><Activity size={17} /></span><div><strong>Focused live terminals</strong><p>Keep each device in its own monitor tab.</p></div></article><article><span><ShieldCheck size={17} /></span><div><strong>Local by design</strong><p>Your device traffic stays on this machine.</p></div></article></div>
  </section>;
}
