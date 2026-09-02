import { useEffect, useState } from 'react';
import { Activity, ArrowRight, Radio, ShieldCheck, Sparkles } from 'lucide-react';
import './home-screen.css';
import './welcome-motion.css';

type WelcomeScreenProps = { nativeEnabled: boolean; onConnect: () => void; onExplore: () => void };

type ChartPoint = { x: number; y: number };

const chartBounds = { left: 24, right: 656, top: 16, bottom: 292 };
const sampleCount = 40;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** A deterministic, shifting signal is clearer than a motionless empty-state chart. */
function makeTelemetryPoints(frame: number, channel: 'primary' | 'secondary') {
  return Array.from({ length: sampleCount }, (_, index) => {
    const progress = index / (sampleCount - 1);
    const sample = frame * 0.31 + index * 0.42;
    const primary = .52
      + .155 * Math.sin(sample * 1.16)
      + .11 * Math.sin(sample * .43 + 1.2)
      + .053 * Math.sin(sample * 2.37 - .5)
      + .021 * Math.sin(sample * 4.7);
    const secondary = .46
      + .09 * Math.sin(sample * .67 + .85)
      + .046 * Math.sin(sample * 1.47 - .2)
      + .018 * Math.sin(sample * 3.08 + .5);
    const value = clamp(channel === 'primary' ? primary : secondary, .09, .91);
    return {
      x: chartBounds.left + progress * (chartBounds.right - chartBounds.left),
      y: chartBounds.bottom - value * (chartBounds.bottom - chartBounds.top),
    };
  });
}

function smoothPath(points: ChartPoint[]) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    const next = points[index + 1];
    const afterNext = points[index + 2] ?? next;
    const controlOneX = current.x + (next.x - previous.x) / 6;
    const controlOneY = current.y + (next.y - previous.y) / 6;
    const controlTwoX = next.x - (afterNext.x - current.x) / 6;
    const controlTwoY = next.y - (afterNext.y - current.y) / 6;
    path += ` C ${controlOneX} ${controlOneY}, ${controlTwoX} ${controlTwoY}, ${next.x} ${next.y}`;
  }
  return path;
}

/** The first-run surface; connection setup itself stays in the shared dialog. */
export function WelcomeScreen({ nativeEnabled, onConnect, onExplore }: WelcomeScreenProps) {
  const [signalFrame, setSignalFrame] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setSignalFrame((frame) => frame + 1), 650);
    return () => window.clearInterval(timer);
  }, []);

  const runtimeLabel = nativeEnabled ? 'Desktop bridge online' : 'Preview mode';
  const primaryPoints = makeTelemetryPoints(signalFrame, 'primary');
  const secondaryPoints = makeTelemetryPoints(signalFrame, 'secondary');
  const primaryPath = smoothPath(primaryPoints);
  const secondaryPath = smoothPath(secondaryPoints);
  const lastPrimaryPoint = primaryPoints[primaryPoints.length - 1];
  const pulse = 48.2 + Math.sin(signalFrame * .47) * .7 + Math.sin(signalFrame * .19) * .25;
  const throughput = 1.18 + Math.sin(signalFrame * .3) * .12 + Math.sin(signalFrame * .81) * .04;

  return <section className="bt-home" aria-labelledby="welcome-title">
    <div className="bt-home-main">
      <div className="bt-home-copy">
        <div className="bt-home-kicker"><span><Sparkles size={14} /> BaudTide workspace</span><span className={`bt-home-kicker-status ${nativeEnabled ? 'is-ready' : ''}`}><i />{runtimeLabel}</span></div>
        <h1 id="welcome-title" className="bt-home-title">Bring every <em>signal</em> into focus.</h1>
        <p className="bt-home-intro">A calm, precise place to connect hardware, read the stream, and understand what your device is saying—one byte at a time.</p>
        <div className="bt-home-actions">
          <button className="bt-home-primary" type="button" onClick={onConnect}><Radio size={18} /> Connect a device <ArrowRight size={17} /></button>
          <button className="bt-home-secondary" type="button" onClick={onExplore}>Browse available ports</button>
        </div>
        <div className="bt-home-runtime"><span className={nativeEnabled ? 'is-ready' : ''} />{nativeEnabled ? 'Your desktop serial backend is ready to receive a connection.' : 'Open BaudTide on desktop to connect a local serial device.'}</div>
      </div>

      <div className="bt-home-visual" aria-hidden="true">
        <div className="bt-home-console">
          <div className="bt-home-console-header">
            <div className="bt-home-console-source"><span className="bt-home-console-mark"><Activity size={15} /></span><span><small>TELEMETRY PREVIEW</small><strong>Rolling signal simulation</strong></span></div>
            <span className="bt-home-live-badge"><i /> sampling</span>
          </div>
          <div className="bt-home-chart">
            <div className="bt-home-chart-label"><span>Signal view</span><span>rolling 30.0 s</span></div>
            <svg viewBox="0 0 680 314" focusable="false">
              <defs>
                <linearGradient id="bt-home-trace-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="currentColor" stopOpacity=".24" />
                  <stop offset="1" stopColor="currentColor" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path className="bt-home-grid" d="M24 38H656M24 100H656M24 162H656M24 224H656M24 286H656M104 16V292M224 16V292M344 16V292M464 16V292M584 16V292" />
              <path className="bt-home-fill" d={`${primaryPath} L ${chartBounds.right} ${chartBounds.bottom} L ${chartBounds.left} ${chartBounds.bottom} Z`} />
              <path className="bt-home-trace-secondary" d={secondaryPath} />
              <path className="bt-home-trace-primary" d={primaryPath} />
              <circle className="bt-home-trace-point" cx={lastPrimaryPoint.x} cy={lastPrimaryPoint.y} r="6" />
            </svg>
            <div className="bt-home-readout"><span><i /> RX {throughput.toFixed(2)} kB/s</span><span>{pulse.toFixed(1)} Hz · 3 channels</span></div>
          </div>
          <div className="bt-home-console-footer"><span><small>PORT</small><strong>Choose a device to begin</strong></span><span><small>ENCODING</small><strong>UTF-8</strong></span><span><small>CAPTURE</small><strong>Local only</strong></span></div>
        </div>
      </div>
    </div>

    <div className="bt-home-paths">
      <article><span><b>01</b><Radio size={17} /></span><div><strong>Connect with confidence</strong><p>Choose a detected port or enter one directly.</p></div></article>
      <article><span><b>02</b><Activity size={17} /></span><div><strong>Watch the stream</strong><p>Keep each device in its own focused terminal.</p></div></article>
      <article><span><b>03</b><ShieldCheck size={17} /></span><div><strong>Keep it yours</strong><p>Device traffic and captures stay on this machine.</p></div></article>
    </div>
  </section>;
}
