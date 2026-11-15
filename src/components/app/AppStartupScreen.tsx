import { useEffect, useState } from 'react';
import baudTideMark from '../../assets/signaldeck-mark.png';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import './app-startup-screen.css';

type AppStartupScreenProps = {
  ready: boolean;
  onComplete: () => void;
};

/** A short setup handoff; a stalled backend must not hide help and recovery UI. */
export function AppStartupScreen({ ready, onComplete }: AppStartupScreenProps) {
  const [isLeaving, setLeaving] = useState(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    setLeaving(ready);
    if (!ready) {
      // This only dismisses the splash. App keeps connection recovery guarded
      // until the underlying settings/session requests actually settle.
      const escapeTimer = window.setTimeout(onComplete, 1000);
      return () => window.clearTimeout(escapeTimer);
    }
    if (reducedMotion) { onComplete(); return; }
    const completeTimer = window.setTimeout(onComplete, 140);
    return () => window.clearTimeout(completeTimer);
  }, [ready, reducedMotion, onComplete]);

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
