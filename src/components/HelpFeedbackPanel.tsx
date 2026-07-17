import { useState } from 'react';
import { Check, ChevronDown, CircleHelp, Clipboard, ExternalLink, MessageSquareText } from 'lucide-react';
import './phase3-controls.css';

const diagnostics = `SignalDeck UI preview\nPlatform: Linux\nSerial backend: not connected\nWorkspace: Basil's lab (mock)\nStorage: 1.4 GB / 10 GB (mock)`;
const topics = [
  ['Linux serial permissions', 'Most USB serial devices appear as /dev/ttyUSB* or /dev/ttyACM*. Access commonly requires your account to be in the dialout group.'],
  ['Choosing a baud rate', '115200 is a common ESP32 default. Your device firmware must use the same value as SignalDeck.'],
  ['Panel controls', 'Pause will eventually stop rendering without stopping logging; Clear will affect only the visible display.'],
];

/** Contextual help and a copyable, clearly mock diagnostics snapshot. */
export function HelpFeedbackPanel() {
  const [openTopic, setOpenTopic] = useState(0); const [copied, setCopied] = useState(false); const [message, setMessage] = useState(''); const [sent, setSent] = useState(false);
  const copyDiagnostics = async () => { try { await navigator.clipboard?.writeText(diagnostics); } finally { setCopied(true); window.setTimeout(() => setCopied(false), 2200); } };
  return <section className="sd-help" aria-labelledby="help-heading"><div className="sd-screen-heading"><span className="sd-section-icon"><CircleHelp size={19} /></span><div><p>GETTING STARTED</p><h1 id="help-heading">Help &amp; feedback</h1><small>Guidance is ready now; feedback submission remains a local UI preview.</small></div></div>
    <div className="sd-help-grid"><div className="sd-help-card"><h2>Common questions</h2>{topics.map(([title, body], index) => <div className="sd-help-topic" key={title}><button onClick={() => setOpenTopic(openTopic === index ? -1 : index)} aria-expanded={openTopic === index}><span>{title}</span><ChevronDown size={17} /></button>{openTopic === index && <p>{body}</p>}</div>)}</div>
      <aside className="sd-help-card sd-diagnostics"><h2>Copy diagnostics</h2><p>Share this local preview snapshot when reporting a UI issue. It contains no serial data.</p><pre>{diagnostics}</pre><button className="sd-secondary-button" onClick={copyDiagnostics}>{copied ? <><Check size={16} /> Copied</> : <><Clipboard size={16} /> Copy diagnostics</>}</button></aside></div>
    <form className="sd-feedback-card" onSubmit={(event) => { event.preventDefault(); setSent(true); }}><div><span className="sd-section-icon"><MessageSquareText size={18} /></span><div><h2>Send feedback</h2><p>{sent ? 'Thanks — this preview records feedback only in the current page.' : 'Tell us what would make SignalDeck easier to use.'}</p></div></div><textarea value={message} onChange={(e) => { setMessage(e.target.value); setSent(false); }} placeholder="Describe an idea or issue…" /><button className="sd-primary-button" type="submit" disabled={!message.trim()}>{sent ? 'Feedback recorded locally' : 'Send local preview feedback'}</button></form>
    <a className="sd-help-link" href="https://docs.kernel.org/driver-api/serial/" target="_blank" rel="noreferrer">Learn about Linux serial devices <ExternalLink size={15} /></a>
  </section>;
}
