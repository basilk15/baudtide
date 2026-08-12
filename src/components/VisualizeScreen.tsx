import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { AlertTriangle, Check, CirclePause, CirclePlay, Eraser, LoaderCircle, PlugZap, Radio } from 'lucide-react';
import { liveTelemetryStore, type TelemetryField, type TelemetrySessionSnapshot, type TelemetryValue } from '../lib/telemetry';
import { TELEMETRY_SERIES_COLORS } from '../lib/telemetryChart';
import { TelemetryCharts } from './TelemetryCharts';
import { ThemedSelect } from './ThemedSelect';
import './visualize-screen.css';

export type VisualizeSession = {
  id: string;
  uiKey: string;
  sessionName: string;
  port: string;
  connectionState: 'connected' | 'reconnecting' | 'disconnected' | 'error';
};

export type VisualizeScreenProps = {
  nativeEnabled: boolean;
  sessions: VisualizeSession[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onRequestConnection: () => void;
};

const EMPTY_SESSION_KEY = '__baudtide-visualize-empty__';
const MAX_SELECTED_FIELDS = 8;
const AUTO_SELECTED_FIELDS = 3;
const WINDOW_OPTIONS = [
  { value: 10_000, label: '10s' },
  { value: 30_000, label: '30s' },
  { value: 60_000, label: '1m' },
  { value: 5 * 60_000, label: '5m' },
  { value: 15 * 60_000, label: '15m' },
] as const;
// The store still ingests every serial sample. This only caps visual refreshes
// so SVG reconciliation cannot fight scrolling or pointer interactions.
const LIVE_SNAPSHOT_INTERVAL_MS = 140;

function statusDetails(state: VisualizeSession['connectionState']) {
  switch (state) {
    case 'connected':
      return { label: 'Live', description: 'Receiving telemetry' };
    case 'reconnecting':
      return { label: 'Reconnecting', description: 'Waiting for the device' };
    case 'error':
      return { label: 'Needs attention', description: 'Connection error' };
    default:
      return { label: 'Disconnected', description: 'Showing the last snapshot' };
  }
}

function formatFieldValue(value: TelemetryValue | undefined) {
  if (!value) return '—';
  const absolute = Math.abs(value.value);
  if ((absolute && absolute < 0.0001) || absolute >= 10_000_000) return value.value.toExponential(3);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 5 }).format(value.value);
}

function formatCount(value: number, noun: string) {
  return `${value.toLocaleString()} ${noun}${value === 1 ? '' : 's'}`;
}

function latestValues(snapshot: TelemetrySessionSnapshot) {
  const values = new Map<string, TelemetryValue>();
  for (let index = snapshot.samples.length - 1; index >= 0; index -= 1) {
    for (const [key, value] of Object.entries(snapshot.samples[index].values)) {
      if (!values.has(key)) values.set(key, value);
    }
  }
  return values;
}

function formatSummary(snapshot: TelemetrySessionSnapshot) {
  const formats = new Set(snapshot.detectedSchemas.map((schema) => schema.format));
  if (!formats.size) snapshot.fields.forEach((field) => field.formats.forEach((format) => formats.add(format)));
  if (!formats.size) return 'Waiting for a repeated numeric record';
  const labels = [...formats].map((format) => ({ json: 'JSON', pairs: 'Key/value', csv: 'CSV', tsv: 'TSV' })[format]);
  return labels.join(' · ');
}

function FieldRow({ field, index, checked, latest, disabled, onToggle }: {
  field: TelemetryField;
  index: number;
  checked: boolean;
  latest: TelemetryValue | undefined;
  disabled: boolean;
  onToggle: () => void;
}) {
  const colorStyle = { '--bt-visualize-field-color': TELEMETRY_SERIES_COLORS[index % TELEMETRY_SERIES_COLORS.length] } as CSSProperties;
  return <label className={`bt-visualize-field ${checked ? 'is-selected' : ''}`} style={colorStyle}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
    <span className="bt-visualize-field-color" aria-hidden="true" />
    <span className="bt-visualize-field-name"><strong title={field.key}>{field.key}</strong><small>{field.formats.join(' · ')}</small></span>
    <span className="bt-visualize-field-value"><strong>{formatFieldValue(latest)}</strong>{latest?.unit || field.unit ? <small>{latest?.unit ?? field.unit}</small> : null}</span>
  </label>;
}

/**
 * The visualization surface is intentionally a read-only subscriber. Serial
 * events continue to be owned and ordered by LiveMonitor before entering the
 * shared telemetry store.
 */
export function VisualizeScreen({ nativeEnabled, sessions, selectedSessionId, onSelectSession, onRequestConnection }: VisualizeScreenProps) {
  const activeSession = sessions.find((session) => session.id === selectedSessionId) ?? sessions[0] ?? null;
  const activeSessionKey = activeSession?.uiKey ?? EMPTY_SESSION_KEY;
  const subscribe = useCallback((listener: () => void) => {
    let notificationTimer: number | undefined;
    const unsubscribe = liveTelemetryStore.subscribe(activeSessionKey, () => {
      // Serial chunks can arrive much faster than a useful chart refresh. Keep
      // ingestion lossless while bounding expensive 10k-sample snapshots and
      // React renders to roughly 12 frames per second.
      if (notificationTimer !== undefined) return;
      notificationTimer = window.setTimeout(() => {
        notificationTimer = undefined;
        listener();
      }, LIVE_SNAPSHOT_INTERVAL_MS);
    });
    return () => {
      unsubscribe();
      if (notificationTimer !== undefined) window.clearTimeout(notificationTimer);
    };
  }, [activeSessionKey]);
  const getSnapshot = useCallback(() => liveTelemetryStore.getSnapshot(activeSessionKey), [activeSessionKey]);
  const liveSnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const frozenSnapshot = useRef<TelemetrySessionSnapshot | null>(null);
  const [paused, setPaused] = useState(false);
  const [windowMs, setWindowMs] = useState<(typeof WINDOW_OPTIONS)[number]['value']>(30_000);
  const [manualSelections, setManualSelections] = useState<Record<string, readonly string[]>>({});
  const [manuallyConfiguredSessions, setManuallyConfiguredSessions] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState('');

  useEffect(() => {
    frozenSnapshot.current = null;
    setPaused(false);
    setNotice('');
  }, [activeSessionKey]);

  const snapshot = paused && frozenSnapshot.current ? frozenSnapshot.current : liveSnapshot;
  const availableKeys = useMemo(() => new Set(snapshot.fields.map((field) => field.key)), [snapshot.fields]);
  const selectedFieldKeys = useMemo(() => {
    if (!activeSession) return [];
    const configured = manuallyConfiguredSessions.has(activeSessionKey)
      ? manualSelections[activeSessionKey] ?? []
      : snapshot.fields.slice(0, AUTO_SELECTED_FIELDS).map((field) => field.key);
    return configured.filter((key) => availableKeys.has(key));
  }, [activeSession, activeSessionKey, availableKeys, manualSelections, manuallyConfiguredSessions, snapshot.fields]);
  const selectedKeySet = useMemo(() => new Set(selectedFieldKeys), [selectedFieldKeys]);
  const latestByKey = useMemo(() => latestValues(snapshot), [snapshot]);
  const status = activeSession ? statusDetails(activeSession.connectionState) : null;
  const windowLabel = WINDOW_OPTIONS.find((option) => option.value === windowMs)?.label ?? '30s';

  const toggleField = (fieldKey: string) => {
    if (!activeSession) return;
    const isSelected = selectedKeySet.has(fieldKey);
    const next = isSelected
      ? selectedFieldKeys.filter((key) => key !== fieldKey)
      : [...selectedFieldKeys, fieldKey];
    if (!isSelected && next.length > MAX_SELECTED_FIELDS) {
      setNotice(`Choose up to ${MAX_SELECTED_FIELDS} fields at a time. Remove one before adding another.`);
      return;
    }
    setManualSelections((current) => ({ ...current, [activeSessionKey]: next }));
    setManuallyConfiguredSessions((current) => new Set(current).add(activeSessionKey));
    setNotice(isSelected ? `${fieldKey} hidden from the chart.` : `${fieldKey} added to the chart.`);
  };

  const togglePause = () => {
    if (!activeSession) return;
    if (paused) {
      frozenSnapshot.current = null;
      setPaused(false);
      setNotice('Live chart resumed.');
      return;
    }
    frozenSnapshot.current = liveSnapshot;
    setPaused(true);
    setNotice('Chart paused. Telemetry is still being received.');
  };

  const clearChart = () => {
    if (!activeSession) return;
    const confirmed = window.confirm(`Clear detected telemetry for “${activeSession.sessionName}”? This only clears the visualization cache; terminal output and any device logging are untouched.`);
    if (!confirmed) return;
    liveTelemetryStore.removeSession(activeSessionKey);
    frozenSnapshot.current = null;
    setPaused(false);
    setManualSelections((current) => ({ ...current, [activeSessionKey]: [] }));
    setManuallyConfiguredSessions((current) => {
      const next = new Set(current);
      next.delete(activeSessionKey);
      return next;
    });
    setNotice('Chart data cleared. New repeated numeric records will appear as they arrive.');
  };

  if (!activeSession) {
    return <section className="bt-visualize bt-visualize-empty" aria-labelledby="visualize-title">
      <div className="bt-visualize-empty-icon">{nativeEnabled ? <LoaderCircle className="sd-spin" size={27} /> : <PlugZap size={27} />}</div>
      <p>LIVE VISUALIZE</p>
      <h1 id="visualize-title">{nativeEnabled ? 'Waiting for a serial session' : 'Visualize telemetry from a desktop session'}</h1>
      <span>{nativeEnabled
        ? 'Open a device session, then BaudTide will detect repeated numeric fields and plot them here.'
        : 'Open BaudTide desktop, connect a device, and return here to inspect its live numeric telemetry.'}</span>
      <button className="sd-primary-button" type="button" onClick={onRequestConnection}><Radio size={16} /> Connect a device</button>
    </section>;
  }

  return <section className="bt-visualize" aria-labelledby="visualize-title">
    <header className="bt-visualize-header">
      <div className="bt-visualize-title-group">
        <p>VISUALIZE</p>
        <h1 id="visualize-title">Live telemetry</h1>
        <span>Inspect changing device values without leaving the terminal.</span>
      </div>
      <div className="bt-visualize-session-picker">
        <span className="bt-visualize-form-label">SESSION</span>
        <ThemedSelect
          value={activeSession.id}
          options={sessions.map((session) => ({ value: session.id, label: `${session.sessionName} · ${session.port}` }))}
          placeholder="Select a device session"
          label="Device session"
          onChange={onSelectSession}
        />
      </div>
    </header>

    <div className="bt-visualize-workbench">
      <div className={`bt-visualize-connection is-${activeSession.connectionState}`}>
        <div className="bt-visualize-device">
          <span className="bt-visualize-connection-signal" aria-hidden="true" />
          <span><strong>{activeSession.sessionName}</strong><small>{activeSession.port}</small></span>
        </div>
        <div className="bt-visualize-connection-meta"><span className="bt-visualize-session-name">{status?.label}</span><small>{status?.description}</small></div>
      </div>

      <div className="bt-visualize-layout">
      <aside className="bt-visualize-fields" aria-label="Detected numeric fields">
        <header><div><p>DATA CHANNELS</p><h2>Signals</h2></div><span>{selectedFieldKeys.length} / {MAX_SELECTED_FIELDS}</span></header>
        {snapshot.fields.length ? <>
          <p className="bt-visualize-field-help">Select up to {MAX_SELECTED_FIELDS} fields to compare on the same canvas.</p>
          <div className="bt-visualize-field-list">
            {snapshot.fields.map((field, index) => <FieldRow key={field.key} field={field} index={index} checked={selectedKeySet.has(field.key)} latest={latestByKey.get(field.key)} disabled={!selectedKeySet.has(field.key) && selectedFieldKeys.length >= MAX_SELECTED_FIELDS} onToggle={() => toggleField(field.key)} />)}
          </div>
        </> : <div className="bt-visualize-field-empty"><LoaderCircle className={activeSession.connectionState === 'connected' || activeSession.connectionState === 'reconnecting' ? 'sd-spin' : ''} size={20} /><strong>{snapshot.receivedCompleteLineCount ? 'No numeric fields detected yet' : 'Listening for telemetry'}</strong><span>{snapshot.receivedCompleteLineCount
          ? 'BaudTide needs repeated JSON, key/value, CSV, or TSV numeric records before it creates a signal.'
          : 'Send repeated numeric records from the device to populate this list.'}</span></div>}
      </aside>

      <main className="bt-visualize-chart-card">
        <header className="bt-visualize-chart-toolbar">
          <div><p>LIVE PLOT</p><h2>{paused ? 'Paused snapshot' : 'Overview'}</h2><span className="bt-visualize-chart-subtitle">{selectedFieldKeys.length ? `${selectedFieldKeys.length} signal${selectedFieldKeys.length === 1 ? '' : 's'} · last ${windowLabel}` : 'Select a signal to begin'}</span></div>
          <div className="bt-visualize-chart-actions">
            <span className={`bt-visualize-live-state ${paused ? 'is-paused' : ''}`} role="status"><i aria-hidden="true" />{paused ? 'Paused' : 'Live'}</span>
            <div className="bt-visualize-window"><span>Window</span><ThemedSelect compact value={String(windowMs)} options={WINDOW_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))} placeholder="Select window" label="Chart time window" onChange={(value) => setWindowMs(Number(value) as typeof windowMs)} /></div>
            <button className={`bt-visualize-control ${paused ? 'is-active' : ''}`} type="button" onClick={togglePause} title={paused ? 'Resume live chart' : 'Pause displayed chart'}>{paused ? <CirclePlay size={15} /> : <CirclePause size={15} />}{paused ? 'Resume' : 'Pause'}</button>
            <button className="bt-visualize-control" type="button" disabled={!snapshot.samples.length && !snapshot.fields.length} onClick={clearChart} title="Clear chart data"><Eraser size={15} /> Clear</button>
          </div>
        </header>
        {paused && <div className="bt-visualize-paused"><CirclePause size={14} /><span>Display paused — incoming telemetry continues in the background.</span></div>}
        {!snapshot.fields.length ? <div className="bt-visualize-chart-empty"><PlugZap size={27} /><h3>Looking for repeatable numeric telemetry</h3><p>BaudTide recognizes JSON objects, named key/value pairs, CSV, and TSV streams after it sees a consistent record.</p></div>
          : !selectedFieldKeys.length ? <div className="bt-visualize-chart-empty"><Check size={27} /><h3>Select at least one signal</h3><p>Choose a numeric field in the Signals list to start charting its values.</p></div>
            : <TelemetryCharts samples={snapshot.samples} fields={snapshot.fields} gaps={snapshot.gaps} selectedFieldKeys={selectedFieldKeys} windowMs={windowMs} paused={paused} />}
        <footer className="bt-visualize-summary">
          <span><b>{formatCount(snapshot.acceptedSampleCount, 'sample')}</b> accepted</span>
          <span><b>{formatSummary(snapshot)}</b> format{snapshot.detectedSchemas.length === 1 ? '' : 's'}</span>
          {snapshot.gaps.length ? <span><b>{formatCount(snapshot.gaps.length, 'reconnect gap')}</b> marked</span> : null}
          {snapshot.droppedOverlongLineCount ? <span className="is-warning"><AlertTriangle size={13} /> {formatCount(snapshot.droppedOverlongLineCount, 'overlong line')} ignored</span> : null}
        </footer>
      </main>
      </div>
    </div>
    <p className="bt-visualize-notice" role="status" aria-live="polite">{notice}</p>
  </section>;
}
