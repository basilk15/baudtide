import { useEffect, useState } from 'react';
import baudTideMark from '../assets/signaldeck-mark.png';
import './app-startup-screen.css';

type AppStartupScreenProps = {
  onComplete: () => void;
};

/** A short branded handoff before the interactive workspace becomes available. */
export function AppStartupScreen({ onComplete }: AppStartupScreenProps) {
  const [isLeaving, setLeaving] = useState(false);

  useEffect(() => {
    const leaveTimer = window.setTimeout(() => setLeaving(true), 1_750);
    const completeTimer = window.setTimeout(onComplete, 2_100);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(completeTimer);
    };
  }, [onComplete]);

  return <main className={`sd-startup-screen${isLeaving ? ' is-leaving' : ''}`} aria-label="Launching BaudTide">
    <div className="sd-startup-grid" aria-hidden="true" />
    <div className="sd-startup-halo sd-startup-halo-one" aria-hidden="true" />
    <div className="sd-startup-halo sd-startup-halo-two" aria-hidden="true" />
    <div className="sd-startup-content">
      <div className="sd-startup-mark-wrap">
        <span className="sd-startup-mark-glow" aria-hidden="true" />
        <img className="sd-startup-mark" src={baudTideMark} alt="BaudTide" />
      </div>
      <div className="sd-startup-wordmark" aria-hidden="true">baud<span>tide</span></div>
      <p className="sd-startup-tagline">SERIAL MONITORING, MADE CALM</p>
    </div>
    <div className="sd-startup-loader" role="status" aria-live="polite">
      <div className="sd-startup-loader-copy"><span className="sd-startup-loader-dot" aria-hidden="true" /> Preparing your workspace</div>
      <div className="sd-startup-progress" aria-hidden="true"><i /></div>
    </div>
  </main>;
}
