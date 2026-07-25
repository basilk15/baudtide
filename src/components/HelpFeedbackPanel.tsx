import { useMemo, useState } from 'react';
import { AlertCircle, Check, ChevronDown, CircleHelp, Clipboard, ExternalLink, MessageSquareText } from 'lucide-react';
import './phase3-controls.css';

const topics = [
  ['Linux serial permissions', 'Most USB serial devices appear as /dev/ttyUSB* or /dev/ttyACM*. Access commonly requires your account to be in the dialout group.'],
  ['Choosing a baud rate', 'Your device firmware must use the same baud rate configured in BaudTide.'],
  ['Panel controls', 'Pause stops rendering while logging continues. Clear affects only the visible display.'],
];

type HelpFeedbackPanelProps = { nativeEnabled: boolean; openSessionCount: number; activeSessionCount: number };
type CopyStatus = 'idle' | 'success' | 'error';

export function HelpFeedbackPanel({ nativeEnabled, openSessionCount, activeSessionCount }: HelpFeedbackPanelProps) {
  const [openTopic, setOpenTopic] = useState(0); const [diagnosticsCopyStatus, setDiagnosticsCopyStatus] = useState<CopyStatus>('idle'); const [message, setMessage] = useState(''); const [feedbackCopyStatus, setFeedbackCopyStatus] = useState<CopyStatus>('idle');
  const diagnostics = useMemo(() => [
    'BaudTide diagnostics',
    `Runtime: ${nativeEnabled ? 'Tauri desktop' : 'browser preview (serial unavailable)'}`,
    `Platform: ${navigator.platform || 'not reported'}`,
    `Language: ${navigator.language || 'not reported'}`,
    `Open terminals: ${openSessionCount}`,
    `Active terminal connections: ${activeSessionCount}`,
    'Serial payloads and log contents are intentionally excluded.',
  ].join('\n'), [activeSessionCount, nativeEnabled, openSessionCount]);
  const copyText = async (text: string, onComplete: (status: CopyStatus) => void) => {
    if (!navigator.clipboard?.writeText) {
      onComplete('error');
      window.setTimeout(() => onComplete('idle'), 2200);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      onComplete('success');
    } catch {
      onComplete('error');
    }
    window.setTimeout(() => onComplete('idle'), 2200);
  };
  const copyDiagnostics = () => void copyText(diagnostics, setDiagnosticsCopyStatus);
  const copyFeedback = () => void copyText(`BaudTide feedback\n\n${message.trim()}\n\n--- Diagnostics ---\n${diagnostics}`, setFeedbackCopyStatus);
  return <section className="sd-help" aria-labelledby="help-heading"><div className="sd-screen-heading"><span className="sd-section-icon"><CircleHelp size={19} /></span><div><p>GETTING STARTED</p><h1 id="help-heading">Help &amp; feedback</h1><small>Guidance for working with local serial devices.</small></div></div>
    <div className="sd-help-grid"><div className="sd-help-card"><h2>Common questions</h2>{topics.map(([title, body], index) => <div className="sd-help-topic" key={title}><button onClick={() => setOpenTopic(openTopic === index ? -1 : index)} aria-expanded={openTopic === index}><span>{title}</span><ChevronDown size={17} /></button>{openTopic === index && <p>{body}</p>}</div>)}</div>
      <aside className="sd-help-card sd-diagnostics"><h2>Copy diagnostics</h2><p>Share this local diagnostics snapshot when reporting an issue. It contains no serial data.</p><pre>{diagnostics}</pre><button className="sd-secondary-button" onClick={copyDiagnostics}>{diagnosticsCopyStatus === 'success' ? <><Check size={16} /> Copied</> : diagnosticsCopyStatus === 'error' ? <><AlertCircle size={16} /> Copy failed</> : <><Clipboard size={16} /> Copy diagnostics</>}</button></aside></div>
    <section className="sd-feedback-card" aria-labelledby="feedback-heading"><div><span className="sd-section-icon"><MessageSquareText size={18} /></span><div><h2 id="feedback-heading">Prepare feedback</h2><p>Copy a local feedback draft with the diagnostics snapshot, then send it through the project channel you use.</p></div></div><textarea value={message} onChange={(e) => { setMessage(e.target.value); setFeedbackCopyStatus('idle'); }} placeholder="Describe an idea or issue…" /><button className="sd-primary-button" type="button" onClick={copyFeedback} disabled={!message.trim()}>{feedbackCopyStatus === 'success' ? <><Check size={16} /> Copied</> : feedbackCopyStatus === 'error' ? <><AlertCircle size={16} /> Copy failed</> : <><Clipboard size={16} /> Copy draft</>}</button></section>
    <a className="sd-help-link" href="https://docs.kernel.org/driver-api/serial/" target="_blank" rel="noreferrer">Learn about Linux serial devices <ExternalLink size={15} /></a>
  </section>;
}
