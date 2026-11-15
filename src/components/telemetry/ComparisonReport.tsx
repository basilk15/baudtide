import { useEffect, useId, useRef, useState } from 'react';
import { Copy, FileText, X } from 'lucide-react';
import { comparisonReportMarkdown, type ComparisonReportOptions } from '../../lib/captures/comparisonReport';
import type { ComparisonSummarySnapshot } from '../../lib/captures/comparisonSummary';
import './comparison-report.css';

type Props = { snapshot: ComparisonSummarySnapshot; context: Omit<ComparisonReportOptions, 'includePaths'>; disabled?: boolean; label?: string };

export function ComparisonReport({ snapshot, context, disabled = false, label = 'current comparison' }: Props) {
  const [open, setOpen] = useState(false);
  const [includePaths, setIncludePaths] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copiedText, setCopiedText] = useState('');
  const [error, setError] = useState<{ text: string; message: string } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const preview = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  const alive = useRef(true);
  const operation = useRef({ copying: false, revision: 0 });
  const id = useId();
  const markdown = open ? comparisonReportMarkdown(snapshot, { ...context, includePaths }) : '';
  const currentText = useRef(markdown); currentText.current = markdown;
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current.revision += 1; }; }, []);
  useEffect(() => { if (open) { preview.current?.focus({ preventScroll: true }); panel.current?.scrollIntoView?.({ block: 'nearest' }); } }, [open]);
  function close() {
    operation.current.revision += 1; setOpen(false); setIncludePaths(false); setCopiedText(''); setError(null); trigger.current?.focus();
  }
  async function copy() {
    if (operation.current.copying || disabled) return;
    operation.current.copying = true; setCopying(true); setCopiedText(''); setError(null);
    const text = markdown; const revision = operation.current.revision;
    const isCurrent = () => alive.current && operation.current.revision === revision && currentText.current === text;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (isCurrent()) setCopiedText(text);
    } catch {
      if (isCurrent()) setError({ text, message: 'Could not copy this report. Use Select report, then copy the selected text.' });
    } finally { operation.current.copying = false; if (alive.current) setCopying(false); }
  }
  const Heading = context.kind === 'saved' ? 'h5' : 'h4';
  return <div className="bt-comparison-report">
    <button ref={trigger} type="button" className="sd-secondary-button" disabled={disabled && !open} aria-label={`${open ? 'Close report' : 'Create report'}: ${label}`} aria-expanded={open} aria-controls={open ? `${id}-panel` : undefined} onClick={() => open ? close() : setOpen(true)}><FileText size={15} aria-hidden="true" />{open ? 'Close report' : 'Create report'}</button>
    {open && <section ref={panel} id={`${id}-panel`} className="bt-comparison-report-panel" aria-label={`Comparison report: ${label}`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <header><div><Heading id={`${id}-title`}>Comparison report</Heading><p>{context.kind === 'saved' ? 'A historical snapshot, without reopening or rechecking captures.' : 'Evidence from the current comparison.'} Review the Markdown before sharing it.</p></div><button type="button" className="sd-secondary-button" aria-label={`Close report: ${label}`} onClick={close}><X size={17} aria-hidden="true" /></button></header>
      <div className="bt-comparison-report-tools"><button type="button" className="sd-primary-button" aria-label={`Copy Markdown: ${label}`} disabled={copying || disabled} onClick={() => void copy()}><Copy size={15} aria-hidden="true" />{copying ? 'Copying…' : 'Copy Markdown'}</button><button type="button" className="sd-secondary-button" aria-label={`Select report: ${label}`} onClick={() => { preview.current?.focus(); preview.current?.select(); }}>Select report</button>{context.paths && <label><input type="checkbox" aria-label={`Include local capture paths: ${label}`} checked={includePaths} disabled={copying || disabled} onChange={event => setIncludePaths(event.target.checked)} />Include local capture paths</label>}</div>
      <p id={`${id}-help`} className="bt-comparison-report-disclosure">{includePaths && context.paths ? 'Local capture path fields are included in this report.' : 'Local capture path fields are omitted.'} Names, signal labels and evidence notes remain included.</p>
      {error?.text === markdown && <p className="bt-comparison-report-error" role="alert">{error.message}</p>}
      <p className="bt-comparison-report-notice" role="status">{copiedText && copiedText === markdown ? 'Markdown report copied. Paste it into your issue or discussion.' : ''}</p>
      <textarea ref={preview} aria-label="Markdown comparison report" aria-describedby={`${id}-help`} name="comparison-report" readOnly spellCheck={false} wrap="off" value={markdown} />
    </section>}
  </div>;
}
