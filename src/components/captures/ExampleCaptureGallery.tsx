import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Check, FlaskConical, X } from 'lucide-react';
import examples from '../../../electron/examples/catalog.json';
import './example-capture-gallery.css';

type Props = { busy: boolean; onImport: (id: string) => void; onClose: () => void };

export function ExampleCaptureGallery({ busy, onImport, onClose }: Props) {
  const [selectedId, setSelectedId] = useState(examples[0].id);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const example = examples.find(item => item.id === selectedId)!;
  const low = Math.min(...example.preview); const high = Math.max(...example.preview);
  const points = example.preview.map((value, i) => `${12 + i / (example.preview.length - 1) * 456},${78 - (value - low) / (high - low || 1) * 58}`).join(' ');
  return <section id="example-capture-gallery" className="bt-examples" aria-labelledby="example-gallery-title" aria-busy={busy}>
    <header className="bt-examples-heading"><div><h2 id="example-gallery-title" tabIndex={-1} ref={heading}>Explore example captures</h2><p>Real analysis tools. Synthetic recordings. No hardware needed.</p></div><button type="button" className="sd-secondary-button" disabled={busy} onClick={onClose} aria-label="Close example gallery"><X size={17} /></button></header>
    <div className="bt-examples-workbench">
      <div className="bt-examples-list" role="group" aria-label="Choose an example capture">{examples.map(item => <button type="button" key={item.id} aria-pressed={item.id === selectedId} disabled={busy} onClick={() => setSelectedId(item.id)}><FlaskConical size={18} /><span><strong>{item.title}</strong><small>{item.format} · {item.durationSeconds} seconds</small></span>{item.id === selectedId && <Check size={16} />}</button>)}</div>
      <div className="bt-examples-detail">
        <div className="bt-examples-description"><h3>{example.title}</h3><span className="bt-examples-synthetic">Synthetic recording</span><p>{example.description}</p></div>
        <figure className="bt-examples-trace"><figcaption><span>{example.previewLabel}</span><span>{low}–{high} {example.previewUnit}</span></figcaption><svg viewBox="0 0 480 96" role="img" aria-label={`${example.previewLabel} over 60 seconds, from ${low} to ${high} ${example.previewUnit}`}><path d="M12 80H468" className="bt-examples-axis" /><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg><div><span>0 s</span><span>60 s</span></div></figure>
        <dl className="bt-examples-facts"><div><dt>Signals</dt><dd>{example.signals.join(', ')}</dd></div><div><dt>Decoder</dt><dd>{example.decoderName ?? 'Automatic detection'}</dd></div><div><dt>Includes</dt><dd>Recorded timing and one note</dd></div></dl>
        <div className="bt-examples-guide"><strong>What to inspect</strong><p>{example.guide}</p></div>
        <footer><p>Imports a new local copy. Your existing captures stay intact.</p><button type="button" className="sd-primary-button bt-examples-import" disabled={busy} onClick={() => onImport(example.id)}><ArrowDownToLine size={16} />{busy ? 'Importing…' : 'Import example'}</button></footer>
      </div>
    </div>
  </section>;
}
