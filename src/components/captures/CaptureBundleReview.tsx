import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Archive, FileText, X } from 'lucide-react';
import './capture-bundle-review.css';

type Props = {
  captureName: string;
  sizeBytes: number;
  noteCount: number;
  timing: 'recorded' | 'approximate';
  profiles: readonly { id: string; name: string }[];
  busy: boolean;
  error: string;
  onCancel: () => void;
  onExport: (decoderId: string | null) => void;
};

function readableSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** Review the exact scope of a local export before choosing its destination. */
export function CaptureBundleReview({ captureName, sizeBytes, noteCount, timing, profiles, busy, error, onCancel, onExport }: Props) {
  const [decoder, setDecoder] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  onCancelRef.current = onCancel;
  busyRef.current = busy;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); onCancelRef.current(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)') ?? []);
      if (!controls.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); if (previous?.isConnected) previous.focus(); };
  }, []);

  return <div className="bt-bundle-backdrop">
    <section className="bt-bundle-review" role="dialog" aria-modal="true" aria-labelledby="bundle-review-title" aria-describedby="bundle-review-description" aria-busy={busy} ref={dialog}>
      <header className="bt-bundle-header">
        <div><h2 id="bundle-review-title">Export capture bundle</h2><p id="bundle-review-description">Prepare a capture another BaudTide user can replay and inspect.</p></div>
        <button className="bt-bundle-close" type="button" aria-label="Close export review" disabled={busy} onClick={onCancel}><X size={18} /></button>
      </header>
      <div className="bt-bundle-body">
        <div className="bt-bundle-source"><span className="bt-bundle-source-icon"><FileText size={19} /></span><div><strong>{captureName}</strong><span>{readableSize(sizeBytes)} of raw output</span></div></div>
        <div className="bt-bundle-details" aria-label="Bundle contents">
          <div><span>Receive timing</span><strong>{timing === 'recorded' ? 'Recorded' : 'Approximate'}</strong></div>
          <div><span>Capture notes</span><strong>{noteCount} {noteCount === 1 ? 'note' : 'notes'}</strong></div>
        </div>
        <label className="bt-bundle-decoder" htmlFor="bundle-decoder">Decoder profile <span>Optional</span></label>
        <select id="bundle-decoder" value={decoder} disabled={busy} onChange={(event) => setDecoder(event.target.value)}>
          <option value="">Automatic detection</option>
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
        <p className="bt-bundle-help">Choose the profile used to interpret this capture, if needed.</p>
        <div className="bt-bundle-privacy"><AlertTriangle size={17} /><p>Raw output and notes may contain sensitive information. Review them before sharing; they are included without redaction.</p></div>
        {error && <p className="bt-bundle-error" role="alert">{error}</p>}
      </div>
      <footer className="bt-bundle-actions"><button ref={cancel} className="sd-secondary-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="sd-primary-button" type="button" disabled={busy} onClick={() => onExport(decoder || null)}><Archive size={16} /> {busy ? 'Exporting…' : 'Export bundle'}</button></footer>
    </section>
  </div>;
}
