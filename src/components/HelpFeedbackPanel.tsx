import { useState } from 'react';
import { Check, ChevronDown, CircleHelp, Clipboard, ExternalLink, MessageSquareText } from 'lucide-react';
import './phase3-controls.css';

const diagnostics = `BaudTide\nPlatform: Linux\nSerial backend: managed by the desktop app\nWorkspace: local`;
const topics = [
  ['Linux serial permissions', 'Most USB serial devices appear as /dev/ttyUSB* or /dev/ttyACM*. Access commonly requires your account to be in the dialout group.'],
  ['Choosing a baud rate', 'Your device firmware must use the same baud rate configured in BaudTide.'],
  ['Panel controls', 'Pause stops rendering while logging continues. Clear affects only the visible display.'],
];

export function HelpFeedbackPanel() {
  const [openTopic, setOpenTopic] = useState(0); const [copied, setCopied] = useState(false); const [message, setMessage] = useState(''); const [sent, setSent] = useState(false);
  const copyDiagnostics = async () => { try { await navigator.clipboard?.writeText(diagnostics); } finally { setCopied(true); window.setTimeout(() => setCopied(false), 2200); } };
  return <section className="sd-help" aria-labelledby="help-heading"><div className="sd-screen-heading"><span className="sd-section-icon"><CircleHelp size={19} /></span><div><p>GETTING STARTED</p><h1 id="help-heading">Help &amp; feedback</h1><small>Guidance for working with local serial devices.</small></div></div>
    <div className="sd-help-grid"><div className="sd-help-card"><h2>Common questions</h2>{topics.map(([title, body], index) => <div className="sd-help-topic" key={title}><button onClick={() => setOpenTopic(openTopic === index ? -1 : index)} aria-expanded={openTopic === index}><span>{title}</span><ChevronDown size={17} /></button>{openTopic === index && <p>{body}</p>}</div>)}</div>
      <aside className="sd-help-card sd-diagnostics"><h2>Copy diagnostics</h2><p>Share this local diagnostics snapshot when reporting an issue. It contains no serial data.</p><pre>{diagnostics}</pre><button className="sd-secondary-button" onClick={copyDiagnostics}>{copied ? <><Check size={16} /> Copied</> : <><Clipboard size={16} /> Copy diagnostics</>}</button></aside></div>
    <form className="sd-feedback-card" onSubmit={(event) => { event.preventDefault(); setSent(true); }}><div><span className="sd-section-icon"><MessageSquareText size={18} /></span><div><h2>Feedback</h2><p>{sent ? 'Feedback capture is not connected yet.' : 'Describe an idea or issue for the project.'}</p></div></div><textarea value={message} onChange={(e) => { setMessage(e.target.value); setSent(false); }} placeholder="Describe an idea or issue…" /><button className="sd-primary-button" type="submit" disabled={!message.trim()}>{sent ? 'Not connected' : 'Submit feedback'}</button></form>
    <a className="sd-help-link" href="https://docs.kernel.org/driver-api/serial/" target="_blank" rel="noreferrer">Learn about Linux serial devices <ExternalLink size={15} /></a>
  </section>;
}
