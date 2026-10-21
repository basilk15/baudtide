import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, BookmarkPlus, LoaderCircle, TextSearch, ListChecks, X } from 'lucide-react';
import type { CaptureEvent } from '../../lib/captures/captureEvents';
import type { CaptureContext } from '../../lib/captures/captureContext';
import './capture-event-timeline.css';

export type MarkerSource = { capturePath: string; sourceName: string; startMs: number; endMs: number; currentMs: number; live: boolean };
export type EventInspection = { event: CaptureEvent; loading: boolean; error: string; context?: CaptureContext };
type Props = {
  events: readonly CaptureEvent[]; source?: MarkerSource; inspection: EventInspection | null;
  markerError: string; busy: boolean;
  onInspect: (event: CaptureEvent, before: number, after: number) => void;
  onCloseInspection: () => void;
  onSaveMarker: (title: string, note: string, timestampMs: number) => boolean;
};

function eventTime(timestamp: string) {
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function CaptureEventTimeline({ events, source, inspection, markerError, busy, onInspect, onCloseInspection, onSaveMarker }: Props) {
  const [before, setBefore] = useState('10');
  const [after, setAfter] = useState('10');
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [seconds, setSeconds] = useState('0');
  const [formError, setFormError] = useState('');
  const [shown, setShown] = useState(50);
  const heading = useRef<HTMLHeadingElement>(null);
  const contextView = useRef<HTMLDivElement>(null);
  useEffect(() => { setFormOpen(false); setFormError(''); setShown(50); }, [source?.capturePath]);
  useEffect(() => {
    if (inspection) {
      heading.current?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
      heading.current?.focus({ preventScroll: true });
    }
  }, [inspection?.event.id, inspection?.loading]);
  const anchor = inspection ? Date.parse(inspection.event.timestamp) : 0;
  const nearestLine = inspection?.context?.lines.reduce((nearest, line, index, lines) =>
    Math.abs(line.timestampMs - anchor) < Math.abs(lines[nearest].timestampMs - anchor) ? index : nearest, 0);
  useEffect(() => {
    const element = contextView.current?.querySelector<HTMLElement>('[data-nearest="true"]');
    if (element && contextView.current) contextView.current.scrollTop += element.getBoundingClientRect().top - contextView.current.getBoundingClientRect().top - 64;
  }, [inspection?.context]);
  const inspect = (event: CaptureEvent) => onInspect(event, before.trim() ? Number(before) : NaN, after.trim() ? Number(after) : NaN);
  const sortedEvents = [...events].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  return <section className="bt-event-timeline" aria-labelledby="capture-events-heading">
    <header className="bt-event-heading">
      <div><h3 id="capture-events-heading">Event timeline</h3><p>{events.length ? `${events.length} event${events.length === 1 ? '' : 's'} in this capture · choose one to inspect` : 'Mark a bench change or inspect a watch breach.'}</p></div>
      <button className="sd-secondary-button" type="button" disabled={!source || busy || !!markerError} aria-expanded={formOpen} aria-controls="capture-marker-form" onClick={() => {
        setTitle(''); setNote(''); setFormError(''); setSeconds(String(Math.max(0, ((inspection?.event.capturePath === source?.capturePath ? anchor : source?.currentMs ?? 0) - (source?.startMs ?? 0)) / 1000)));
        setFormOpen((value) => !value);
      }}><BookmarkPlus size={15} /> Add marker</button>
    </header>
    {markerError && <p className="bt-event-error" role="alert">{markerError}</p>}
    {!source && <p className="bt-event-empty">Choose a live terminal with a capture or add a saved capture to use markers.</p>}
    {formOpen && source && <form id="capture-marker-form" className="bt-marker-form" onSubmit={(event) => {
      event.preventDefault();
      const timestamp = source.live ? Date.now() : source.startMs + Number(seconds) * 1000;
      if (!title.trim()) { setFormError('Give this marker a title.'); return; }
      if (!source.live && (!seconds.trim() || !Number.isFinite(timestamp) || timestamp < source.startMs || timestamp > source.endMs)) {
        setFormError(`Choose a time between 0 and ${Math.max(0, (source.endMs - source.startMs) / 1000).toFixed(3)} seconds.`); return;
      }
      if (onSaveMarker(title.trim(), note.trim(), timestamp)) { setFormOpen(false); setFormError(''); }
    }}>
      <div className="bt-marker-fields"><label>Marker title<input autoFocus required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Motor started" /></label>
        {source.live ? <div className="bt-marker-time"><span>Capture time</span><strong>When you save</strong><small>{source.sourceName}</small></div> : <label>Time from capture start (seconds)<input type="number" min="0" max={Math.max(0, (source.endMs - source.startMs) / 1000)} step="any" value={seconds} onChange={(event) => setSeconds(event.target.value)} /></label>}
      </div>
      <label>Notes <span className="bt-event-optional">(optional)</span><textarea maxLength={2000} rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="What changed on the bench?" /></label>
      {formError && <p className="bt-event-error" role="alert">{formError}</p>}
      <div className="bt-event-actions"><button className="sd-primary-button" type="submit">Save marker</button><button className="sd-secondary-button" type="button" onClick={() => setFormOpen(false)}>Cancel</button><span>Saved locally with this capture.</span></div>
    </form>}
    {sortedEvents.length > 0 && <ol className="bt-event-list" aria-label="Capture events">{sortedEvents.slice(0, shown).map((event) => <li key={`${event.kind}:${event.id}`}>
      <button type="button" className={`bt-event-row ${inspection?.event.id === event.id ? 'is-selected' : ''}`} disabled={busy} aria-pressed={inspection?.event.id === event.id} onClick={() => inspect(event)}>
        {event.kind === 'breach' ? <AlertTriangle className="bt-event-breach-icon" size={16} /> : event.kind === 'log' ? <TextSearch className="bt-event-breach-icon" size={16} /> : event.kind === 'command' ? <ListChecks size={16} /> : <BookmarkPlus size={16} />}
        <span><strong>{event.label}</strong>{event.note && <small>{event.note}</small>}</span>
        <time dateTime={event.timestamp}>{eventTime(event.timestamp)}</time><span className="bt-event-inspect-label">Inspect</span>
      </button>
    </li>)}</ol>}
    {sortedEvents.length > shown && <button className="sd-secondary-button bt-event-more" type="button" onClick={() => setShown((value) => value + 50)}>Show older events · {sortedEvents.length - shown} more</button>}
    {inspection && <section className="bt-event-inspection" aria-labelledby="event-inspection-heading" aria-busy={inspection.loading}>
      <header className="bt-event-heading"><div><h3 ref={heading} tabIndex={-1} id="event-inspection-heading">{inspection.event.label}</h3><p>{inspection.event.sourceName} · {eventTime(inspection.event.timestamp)}</p>{inspection.event.note && <p className="bt-event-note">{inspection.event.note}</p>}</div><button className="sd-secondary-button" type="button" onClick={onCloseInspection} aria-label="Close event inspection"><X size={16} /></button></header>
      <form className="bt-event-window" onSubmit={(event) => { event.preventDefault(); inspect(inspection.event); }}>
        <label>Before (seconds)<input type="number" min="0" max="3600" step="any" value={before} onChange={(event) => setBefore(event.target.value)} /></label>
        <label>After (seconds)<input type="number" min="0" max="3600" step="any" value={after} onChange={(event) => setAfter(event.target.value)} /></label>
        <button className="sd-secondary-button" type="submit" disabled={busy || inspection.loading}>Apply window</button>
      </form>
      {inspection.loading && <p className="bt-event-loading" role="status"><LoaderCircle className="sd-spin" size={16} /> Opening capture and reading serial context…</p>}
      {inspection.error && <p className="bt-event-error" role="alert">{inspection.error}</p>}
      {inspection.context && <>
        <div className="bt-event-context-heading"><strong>Serial output around event</strong><span>{inspection.context.lines.length} of {inspection.context.matched} lines{inspection.context.matched > inspection.context.lines.length ? ' · nearest lines shown' : ''}</span></div>
        {inspection.context.timingMode === 'approximate' && <p className="bt-event-timing-note">This capture has approximate timing. Line positions are estimated from byte offsets.</p>}
        {inspection.context.lines.length ? <div className="bt-event-context" ref={contextView} role="region" aria-label="Serial output around event" tabIndex={0}>{inspection.context.lines.map((line, index) => <div key={index} data-nearest={index === nearestLine}>
          <time title={new Date(line.timestampMs).toISOString()}>{line.timestampMs >= anchor ? '+' : '−'}{(Math.abs(line.timestampMs - anchor) / 1000).toFixed(3)}s</time><pre>{line.text || ' '}{line.shortened ? ' … [line shortened]' : ''}</pre>
        </div>)}</div> : <p className="bt-event-empty">No serial lines were recorded in this time window. Try a wider window.</p>}
      </>}
    </section>}
  </section>;
}
