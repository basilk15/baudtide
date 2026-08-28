import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AlertTriangle,
  CirclePause,
  CirclePlay,
  Download,
  FolderOpen,
  LoaderCircle,
  Plus,
  Radio,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  exportNativeTelemetryData,
  listNativeSavedLogs,
  readNativeTelemetryLog,
  type SavedLog,
} from '../lib/serial';
import {
  liveTelemetryStore,
  telemetrySnapshotFromCapture,
  type TelemetryField,
  type TelemetrySample,
  type TelemetrySessionSnapshot,
  type TelemetryValue,
} from '../lib/telemetry';
import { TELEMETRY_SERIES_COLORS } from '../lib/telemetryChart';
import { TelemetryCharts, type ChartMode } from './TelemetryECharts';
import { ThemedSelect } from './ThemedSelect';
import type { VisualizeScreenProps, VisualizeSession } from './VisualizeScreen';
import './telemetry-analysis-workspace.css';

type AlignmentMode = 'elapsed' | 'clock';
type ExportFormat = 'csv' | 'json';

type RecordedSource = {
  id: string;
  kind: 'recorded';
  name: string;
  detail: string;
  log: SavedLog;
  snapshot: TelemetrySessionSnapshot;
  truncated: boolean;
};

type LiveSource = {
  id: string;
  kind: 'live';
  name: string;
  detail: string;
  session: VisualizeSession;
  snapshot: TelemetrySessionSnapshot;
};

type AnalysisSource = LiveSource | RecordedSource;

type DisplayField = {
  id: string;
  sourceId: string;
  sourceName: string;
  field: TelemetryField;
  chartKey: string;
  latest?: TelemetryValue;
  colorIndex: number;
};

const MAX_SELECTED_FIELDS = 8;
const ANALYSIS_EPOCH_MS = Date.UTC(2000, 0, 1);
const WINDOW_OPTIONS = [
  { value: 0, label: 'All data' },
  { value: 10_000, label: '10 seconds' },
  { value: 30_000, label: '30 seconds' },
  { value: 60_000, label: '1 minute' },
  { value: 5 * 60_000, label: '5 minutes' },
] as const;

function recordedSourceId(path: string) {
  return `recorded:${path}`;
}

function liveSourceId(session: VisualizeSession) {
  return `live:${session.uiKey}`;
}

function sourceFieldId(sourceId: string, fieldKey: string) {
  return `${sourceId}\u0000${fieldKey}`;
}

function latestValues(snapshot: TelemetrySessionSnapshot) {
  const values = new Map<string, TelemetryValue>();
  for (let index = snapshot.samples.length - 1; index >= 0; index -= 1) {
    Object.entries(snapshot.samples[index].values).forEach(([key, value]) => {
      if (!values.has(key)) values.set(key, value);
    });
  }
  return values;
}

function formatFieldValue(value: TelemetryValue | undefined) {
  if (!value) return '—';
  const absolute = Math.abs(value.value);
  if ((absolute > 0 && absolute < 0.0001) || absolute >= 10_000_000) return value.value.toExponential(3);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 5 }).format(value.value);
}

function formatDuration(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0s';
  if (milliseconds < 60_000) return `${Math.max(1, Math.round(milliseconds / 1_000))}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function sourceRange(snapshot: TelemetrySessionSnapshot) {
  const first = Date.parse(snapshot.samples[0]?.timestamp ?? '');
  const last = Date.parse(snapshot.samples[snapshot.samples.length - 1]?.timestamp ?? '');
  if (!Number.isFinite(first) || !Number.isFinite(last)) return { start: 0, end: 0, duration: 0 };
  return { start: first, end: last, duration: Math.max(0, last - first) };
}

function csvCell(value: unknown) {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function downloadInBrowser(contents: string, format: ExportFormat) {
  const blob = new Blob([contents], { type: format === 'json' ? 'application/json' : 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `baudtide-telemetry.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function FieldControl({ field, checked, disabled, onToggle }: {
  field: DisplayField;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const style = {
    '--bt-visualize-field-color': TELEMETRY_SERIES_COLORS[field.colorIndex % TELEMETRY_SERIES_COLORS.length],
  } as CSSProperties;
  return <label className={`bt-analysis-field ${checked ? 'is-selected' : ''}`} style={style}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
    <span className="bt-analysis-field-swatch" aria-hidden="true" />
    <span className="bt-analysis-field-label"><strong title={field.field.key}>{field.field.key}</strong><small>{field.field.formats.join(' · ')}</small></span>
    <span className="bt-analysis-field-value"><strong>{formatFieldValue(field.latest)}</strong>{field.latest?.unit || field.field.unit ? <small>{field.latest?.unit ?? field.field.unit}</small> : null}</span>
  </label>;
}

export type TelemetryAnalysisWorkspaceProps = VisualizeScreenProps & {
  requestedCapturePath?: string | null;
  onRequestedCaptureOpened?: () => void;
};

export function TelemetryAnalysisWorkspace({
  nativeEnabled,
  sessions,
  selectedSessionId,
  onSelectSession,
  onRequestConnection,
  requestedCapturePath,
  onRequestedCaptureOpened,
}: TelemetryAnalysisWorkspaceProps) {
  const [logs, setLogs] = useState<SavedLog[]>([]);
  const [activeSourceIds, setActiveSourceIds] = useState<string[]>([]);
  const [recordedSources, setRecordedSources] = useState<Record<string, RecordedSource>>({});
  const [sourceChoice, setSourceChoice] = useState('');
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState('');
  const [notice, setNotice] = useState('');
  const [liveRevision, setLiveRevision] = useState(0);
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [fieldsConfigured, setFieldsConfigured] = useState(false);
  const [alignment, setAlignment] = useState<AlignmentMode>('elapsed');
  const [windowMs, setWindowMs] = useState<(typeof WINDOW_OPTIONS)[number]['value']>(0);
  const [chartMode, setChartMode] = useState<ChartMode>('compare');
  const [displayPaused, setDisplayPaused] = useState(false);
  const frozenLiveSnapshots = useRef<Record<string, TelemetrySessionSnapshot>>({});
  const [replayProgress, setReplayProgress] = useState(1);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayRate, setReplayRate] = useState(1);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('csv');
  const [exporting, setExporting] = useState(false);
  const requestedCaptureHandled = useRef<string | null>(null);

  useEffect(() => {
    if (!nativeEnabled) return undefined;
    let cancelled = false;
    void listNativeSavedLogs()
      .then((nextLogs) => {
        if (!cancelled) {
          setLogs(nextLogs);
          setLibraryError('');
        }
      })
      .catch((reason) => {
        if (!cancelled) setLibraryError(reason instanceof Error ? reason.message : 'Could not load saved captures.');
      });
    return () => { cancelled = true; };
  }, [nativeEnabled]);

  useEffect(() => {
    if (activeSourceIds.length || !sessions.length) return;
    const selected = sessions.find((session) => session.id === selectedSessionId) ?? sessions[0];
    setActiveSourceIds([liveSourceId(selected)]);
  }, [activeSourceIds.length, selectedSessionId, sessions]);

  useEffect(() => {
    const liveKeys = activeSourceIds
      .filter((id) => id.startsWith('live:'))
      .map((id) => id.slice('live:'.length));
    if (!liveKeys.length || displayPaused) return undefined;
    let timer: number | undefined;
    const notify = () => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        setLiveRevision((current) => current + 1);
      }, 120);
    };
    const unsubscribers = liveKeys.map((key) => liveTelemetryStore.subscribe(key, notify));
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeSourceIds, displayPaused]);

  const loadCapture = useCallback(async (log: SavedLog) => {
    const id = recordedSourceId(log.path);
    if (recordedSources[id]) {
      setActiveSourceIds((current) => current.includes(id) ? current : [...current, id]);
      setNotice(`${log.sessionName} is on the comparison canvas.`);
      return;
    }
    setLoadingPath(log.path);
    setLibraryError('');
    try {
      const content = await readNativeTelemetryLog(log.path);
      const snapshot = telemetrySnapshotFromCapture(id, content.text, {
        startedAt: log.startedAt ?? log.modifiedAt,
        endedAt: log.endedAt,
        nativeSessionId: log.sessionId,
      });
      const source: RecordedSource = {
        id,
        kind: 'recorded',
        name: log.sessionName,
        detail: log.port ?? log.fileName,
        log,
        snapshot,
        truncated: content.truncated,
      };
      setRecordedSources((current) => ({ ...current, [id]: source }));
      setActiveSourceIds((current) => current.includes(id) ? current : [...current, id]);
      setReplayProgress(1);
      setNotice(snapshot.samples.length
        ? `${log.sessionName} loaded with ${snapshot.samples.length.toLocaleString()} retained telemetry records.`
        : `${log.sessionName} loaded, but no repeatable numeric telemetry was detected.`);
    } catch (reason) {
      setLibraryError(reason instanceof Error ? reason.message : 'Could not open that capture for analysis.');
    } finally {
      setLoadingPath(null);
    }
  }, [recordedSources]);

  useEffect(() => {
    if (!requestedCapturePath) {
      requestedCaptureHandled.current = null;
      return;
    }
    if (!logs.length || requestedCaptureHandled.current === requestedCapturePath) return;
    requestedCaptureHandled.current = requestedCapturePath;
    const log = logs.find((candidate) => candidate.path === requestedCapturePath);
    if (!log) {
      setLibraryError('That saved capture is no longer in the local library.');
      onRequestedCaptureOpened?.();
      return;
    }
    void loadCapture(log).finally(() => onRequestedCaptureOpened?.());
  }, [loadCapture, logs, onRequestedCaptureOpened, requestedCapturePath]);

  const liveSources = useMemo<LiveSource[]>(() => sessions.map((session) => {
    const id = liveSourceId(session);
    const snapshot = displayPaused
      ? frozenLiveSnapshots.current[id] ?? liveTelemetryStore.getSnapshot(session.uiKey)
      : liveTelemetryStore.getSnapshot(session.uiKey);
    return { id, kind: 'live', name: session.sessionName, detail: session.port, session, snapshot };
    // liveRevision deliberately promotes external-store changes into this memo.
  }), [displayPaused, liveRevision, sessions]);

  const allSources = useMemo<AnalysisSource[]>(() => [...liveSources, ...Object.values(recordedSources)], [liveSources, recordedSources]);
  const sourcesById = useMemo(() => new Map(allSources.map((source) => [source.id, source])), [allSources]);
  const activeSources = useMemo(() => activeSourceIds.map((id) => sourcesById.get(id)).filter((source): source is AnalysisSource => Boolean(source)), [activeSourceIds, sourcesById]);

  const availableSourceOptions = useMemo(() => allSources
    .filter((source) => !activeSourceIds.includes(source.id))
    .map((source) => ({
      value: source.id,
      label: `${source.kind === 'live' ? 'Live' : 'Capture'} · ${source.name} · ${source.detail}`,
    })), [activeSourceIds, allSources]);
  const unloadedLogOptions = useMemo(() => logs
    .filter((log) => !recordedSources[recordedSourceId(log.path)] && !activeSourceIds.includes(recordedSourceId(log.path)))
    .map((log) => ({ value: recordedSourceId(log.path), label: `Capture · ${log.sessionName} · ${log.port ?? log.fileName}` })), [activeSourceIds, logs, recordedSources]);
  const sourceOptions = [...availableSourceOptions, ...unloadedLogOptions];

  const addChosenSource = () => {
    if (!sourceChoice) return;
    const source = sourcesById.get(sourceChoice);
    if (source) {
      setActiveSourceIds((current) => current.includes(source.id) ? current : [...current, source.id]);
      if (source.kind === 'live') onSelectSession(source.session.id);
      setNotice(`${source.name} added to the canvas.`);
      setSourceChoice('');
      return;
    }
    const log = logs.find((candidate) => recordedSourceId(candidate.path) === sourceChoice);
    if (log) void loadCapture(log).then(() => setSourceChoice(''));
  };

  const removeSource = (source: AnalysisSource) => {
    setActiveSourceIds((current) => current.filter((id) => id !== source.id));
    setSelectedFields((current) => current.filter((id) => !id.startsWith(`${source.id}\u0000`)));
    setFieldsConfigured(true);
    setNotice(`${source.name} removed from the canvas.`);
  };

  const displayFields = useMemo(() => {
    let colorIndex = 0;
    const sourceNameCounts = new Map<string, number>();
    const sourceNameOrdinals = new Map<string, number>();
    activeSources.forEach((source) => sourceNameCounts.set(source.name, (sourceNameCounts.get(source.name) ?? 0) + 1));
    return activeSources.flatMap((source) => {
      const latest = latestValues(source.snapshot);
      const ordinal = (sourceNameOrdinals.get(source.name) ?? 0) + 1;
      sourceNameOrdinals.set(source.name, ordinal);
      const sourceLabel = (sourceNameCounts.get(source.name) ?? 0) > 1
        ? `${source.name} ${ordinal}`
        : source.name;
      return source.snapshot.fields.map<DisplayField>((field) => ({
        id: sourceFieldId(source.id, field.key),
        sourceId: source.id,
        sourceName: source.name,
        field,
        chartKey: `${sourceLabel} · ${field.key}`,
        latest: latest.get(field.key),
        colorIndex: colorIndex++,
      }));
    });
  }, [activeSources]);

  useEffect(() => {
    const available = new Set(displayFields.map((field) => field.id));
    setSelectedFields((current) => {
      const retained = current.filter((id) => available.has(id));
      if (retained.length || fieldsConfigured || !displayFields.length) return retained;
      return displayFields.slice(0, 3).map((field) => field.id);
    });
  }, [displayFields, fieldsConfigured]);

  const selectedFieldSet = useMemo(() => new Set(selectedFields), [selectedFields]);
  const toggleField = (field: DisplayField) => {
    const selected = selectedFieldSet.has(field.id);
    if (!selected && selectedFields.length >= MAX_SELECTED_FIELDS) {
      setNotice(`Choose up to ${MAX_SELECTED_FIELDS} signals. Remove one before adding another.`);
      return;
    }
    setFieldsConfigured(true);
    setSelectedFields((current) => selected ? current.filter((id) => id !== field.id) : [...current, field.id]);
  };

  const recordedDuration = useMemo(() => Math.max(0, ...activeSources
    .filter((source): source is RecordedSource => source.kind === 'recorded')
    .map((source) => sourceRange(source.snapshot).duration)), [activeSources]);

  useEffect(() => {
    if (!replayPlaying || !recordedDuration) return undefined;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - previous;
      previous = now;
      setReplayProgress((current) => {
        const next = current + (elapsed * replayRate) / recordedDuration;
        if (next >= 1) {
          setReplayPlaying(false);
          return 1;
        }
        return next;
      });
    }, 80);
    return () => window.clearInterval(timer);
  }, [recordedDuration, replayPlaying, replayRate]);

  const combined = useMemo(() => {
    const fields: TelemetryField[] = [];
    const samples: TelemetrySample[] = [];
    const chartKeysByFieldId = new Map(displayFields.map((field) => [field.id, field.chartKey]));

    activeSources.forEach((source) => {
      const range = sourceRange(source.snapshot);
      const replayEnd = source.kind === 'recorded'
        ? range.start + range.duration * replayProgress
        : Number.POSITIVE_INFINITY;
      source.snapshot.fields.forEach((field) => {
        const fieldId = sourceFieldId(source.id, field.key);
        const chartKey = chartKeysByFieldId.get(fieldId);
        if (chartKey) fields.push({ ...field, key: chartKey });
      });
      source.snapshot.samples.forEach((sample) => {
        const timestampMs = Date.parse(sample.timestamp);
        if (source.kind === 'recorded' && timestampMs > replayEnd) return;
        const alignedTimestamp = alignment === 'elapsed'
          ? ANALYSIS_EPOCH_MS + Math.max(0, timestampMs - range.start)
          : timestampMs;
        const values = Object.fromEntries(Object.entries(sample.values).map(([key, value]) => {
          const chartKey = chartKeysByFieldId.get(sourceFieldId(source.id, key));
          return chartKey ? [chartKey, value] : null;
        }).filter((entry): entry is [string, TelemetryValue] => Boolean(entry)));
        samples.push({ ...sample, id: `${source.id}:${sample.id}`, timestamp: new Date(alignedTimestamp).toISOString(), values });
      });
    });
    samples.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    return {
      fields,
      samples,
      selectedChartKeys: selectedFields.map((id) => chartKeysByFieldId.get(id)).filter((key): key is string => Boolean(key)),
    };
  }, [activeSources, alignment, displayFields, replayProgress, selectedFields]);

  const toggleDisplayPause = () => {
    if (displayPaused) {
      frozenLiveSnapshots.current = {};
      setDisplayPaused(false);
      setNotice('Live sources resumed.');
      return;
    }
    frozenLiveSnapshots.current = Object.fromEntries(liveSources.map((source) => [source.id, source.snapshot]));
    setDisplayPaused(true);
    setNotice('Live sources paused on the canvas. Devices continue recording.');
  };

  const resetView = () => {
    setAlignment('elapsed');
    setWindowMs(0);
    setChartMode('compare');
    setReplayProgress(1);
    setReplayPlaying(false);
    setFieldsConfigured(false);
    setSelectedFields(displayFields.slice(0, 3).map((field) => field.id));
    setNotice('Analysis view reset. Source data is unchanged.');
  };

  const exportData = async () => {
    if (!combined.selectedChartKeys.length || !combined.samples.length) return;
    const rows = activeSources.flatMap((source) => {
      const range = sourceRange(source.snapshot);
      const replayEnd = source.kind === 'recorded' ? range.start + range.duration * replayProgress : Number.POSITIVE_INFINITY;
      return source.snapshot.samples.flatMap((sample) => {
        const originalTimestampMs = Date.parse(sample.timestamp);
        if (originalTimestampMs > replayEnd) return [];
        const alignedTimestampMs = alignment === 'elapsed'
          ? ANALYSIS_EPOCH_MS + Math.max(0, originalTimestampMs - range.start)
          : originalTimestampMs;
        return Object.entries(sample.values)
          .filter(([field]) => selectedFieldSet.has(sourceFieldId(source.id, field)))
          .map(([field, value]) => ({
            source: source.name,
            sourceType: source.kind,
            originalTimestamp: sample.timestamp,
            alignedTimestamp: new Date(alignedTimestampMs).toISOString(),
            elapsedMs: Math.max(0, originalTimestampMs - range.start),
            field,
            value: value.value,
            unit: value.unit ?? '',
          }));
      });
    });
    const contents = exportFormat === 'json'
      ? JSON.stringify({ alignment, exportedAt: new Date().toISOString(), rows }, null, 2)
      : [
        ['source', 'source_type', 'original_timestamp', 'aligned_timestamp', 'elapsed_ms', 'signal', 'value', 'unit'].join(','),
        ...rows.map((row) => [row.source, row.sourceType, row.originalTimestamp, row.alignedTimestamp, row.elapsedMs, row.field, row.value, row.unit].map(csvCell).join(',')),
      ].join('\n');
    setExporting(true);
    try {
      const defaultName = `baudtide-comparison-${new Date().toISOString().slice(0, 10)}.${exportFormat}`;
      const savedPath = nativeEnabled
        ? await exportNativeTelemetryData(contents, exportFormat, defaultName)
        : (downloadInBrowser(contents, exportFormat), defaultName);
      if (savedPath) setNotice(`Exported ${rows.length.toLocaleString()} selected telemetry values${nativeEnabled ? ` to ${savedPath}` : ''}.`);
    } catch (reason) {
      setLibraryError(reason instanceof Error ? reason.message : 'Could not export the selected telemetry.');
    } finally {
      setExporting(false);
    }
  };

  const hasRecordedSource = activeSources.some((source) => source.kind === 'recorded');
  const truncatedSources = activeSources.filter((source): source is RecordedSource => source.kind === 'recorded' && source.truncated);

  return <section className="bt-analysis" aria-labelledby="visualize-title">
    <header className="bt-analysis-header">
      <div><h1 id="visualize-title">Telemetry analysis</h1><span>Replay captures and compare live or recorded signals on one aligned timeline.</span></div>
      <div className="bt-analysis-add-source">
        <span>Sources</span>
        <div><ThemedSelect value={sourceChoice} options={sourceOptions} placeholder={sourceOptions.length ? 'Choose a live session or capture' : 'No other sources available'} label="Source to add" onChange={setSourceChoice} /><button className="sd-primary-button" type="button" disabled={!sourceChoice || Boolean(loadingPath)} onClick={addChosenSource}>{loadingPath ? <LoaderCircle className="sd-spin" size={16} /> : <Plus size={16} />} Add source</button></div>
      </div>
    </header>

    {libraryError ? <div className="bt-analysis-message is-error" role="alert"><AlertTriangle size={16} /><span>{libraryError}</span><button type="button" onClick={() => setLibraryError('')} aria-label="Dismiss error"><X size={15} /></button></div> : null}
    {truncatedSources.length ? <div className="bt-analysis-message is-warning" role="status"><AlertTriangle size={16} /><span>{truncatedSources.map((source) => source.name).join(', ')} exceeded the 16 MB replay window. The original capture is untouched; this canvas uses its first 16 MB.</span></div> : null}

    <div className="bt-analysis-source-ruler" aria-label="Comparison sources">
      <div className="bt-analysis-ruler-label"><span>Alignment</span><ThemedSelect compact value={alignment} options={[{ value: 'elapsed', label: 'Align starts' }, { value: 'clock', label: 'Clock time' }]} placeholder="Align starts" label="Timeline alignment" onChange={(value) => setAlignment(value as AlignmentMode)} /></div>
      <div className="bt-analysis-source-track">
        {activeSources.length ? activeSources.map((source) => {
          const range = sourceRange(source.snapshot);
          const state = source.kind === 'live' ? source.session.connectionState : 'recorded';
          return <article className={`bt-analysis-source is-${source.kind}`} key={source.id}>
            <i aria-hidden="true" />
            <span><strong>{source.name}</strong><small>{source.kind === 'live' ? `${source.detail} · ${state}` : `${source.detail} · ${formatDuration(range.duration)}`}</small></span>
            <em>{source.kind === 'live' ? 'LIVE' : 'CAPTURE'}</em>
            <button type="button" onClick={() => removeSource(source)} aria-label={`Remove ${source.name} from comparison`}><X size={14} /></button>
          </article>;
        }) : <div className="bt-analysis-source-empty"><FolderOpen size={18} /><span>Add a live session or saved capture to begin.</span></div>}
      </div>
    </div>

    <div className="bt-analysis-workbench">
      <aside className="bt-analysis-fields" aria-label="Signals by source">
        <header><div><h2>Signals</h2><span>Choose across every source</span></div><strong>{selectedFields.length} / {MAX_SELECTED_FIELDS}</strong></header>
        <div className="bt-analysis-field-scroll">
          {activeSources.map((source) => {
            const fields = displayFields.filter((field) => field.sourceId === source.id);
            return <section className="bt-analysis-field-group" key={source.id}>
              <header><span>{source.name}</span><small>{source.kind === 'live' ? 'live' : 'recorded'} · {fields.length} signal{fields.length === 1 ? '' : 's'}</small></header>
              {fields.length ? fields.map((field) => <FieldControl key={field.id} field={field} checked={selectedFieldSet.has(field.id)} disabled={!selectedFieldSet.has(field.id) && selectedFields.length >= MAX_SELECTED_FIELDS} onToggle={() => toggleField(field)} />) : <p>No repeatable numeric fields detected.</p>}
            </section>;
          })}
          {!activeSources.length ? <div className="bt-analysis-fields-empty"><Radio size={20} /><strong>No analysis sources</strong><span>Add a connected device or a saved capture above.</span>{!sessions.length ? <button className="sd-secondary-button" type="button" onClick={onRequestConnection}>Connect a device</button> : null}</div> : null}
        </div>
      </aside>

      <main className="bt-analysis-canvas">
        <header className="bt-analysis-toolbar">
          <div><h2>{hasRecordedSource ? 'Aligned comparison' : displayPaused ? 'Paused live traces' : 'Live traces'}</h2><span>{combined.selectedChartKeys.length ? `${combined.selectedChartKeys.length} selected signals · ${alignment === 'elapsed' ? 'starts aligned' : 'clock aligned'}` : 'Select signals from the rail'}</span></div>
          <div className="bt-analysis-actions">
            <div className="bt-analysis-compact-select"><span>View</span><ThemedSelect compact value={chartMode} options={[{ value: 'compare', label: 'Overlay' }, { value: 'lanes', label: 'Separate plots' }]} placeholder="Overlay" label="Chart presentation" onChange={(value) => setChartMode(value as ChartMode)} /></div>
            <div className="bt-analysis-compact-select"><span>Window</span><ThemedSelect compact value={String(windowMs)} options={WINDOW_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))} placeholder="All data" label="Chart time window" onChange={(value) => setWindowMs(Number(value) as typeof windowMs)} /></div>
            {liveSources.length ? <button className={`bt-visualize-control ${displayPaused ? 'is-active' : ''}`} type="button" onClick={toggleDisplayPause}>{displayPaused ? <CirclePlay size={15} /> : <CirclePause size={15} />}{displayPaused ? 'Resume live' : 'Pause live'}</button> : null}
            <button className="bt-visualize-control" type="button" onClick={resetView}><RotateCcw size={15} /> Reset view</button>
          </div>
        </header>

        {hasRecordedSource ? <section className="bt-analysis-replay" aria-label="Capture replay controls">
          <button type="button" className="bt-analysis-replay-button" onClick={() => {
            if (replayProgress >= 1) setReplayProgress(0);
            setReplayPlaying((current) => !current);
          }}>{replayPlaying ? <CirclePause size={16} /> : <CirclePlay size={16} />}<span>{replayPlaying ? 'Pause replay' : 'Replay captures'}</span></button>
          <div className="bt-analysis-scrubber"><input type="range" min="0" max="1000" value={Math.round(replayProgress * 1000)} aria-label="Replay position" onChange={(event) => { setReplayPlaying(false); setReplayProgress(Number(event.target.value) / 1000); }} /><div><span>Start</span><strong>{Math.round(replayProgress * 100)}% · reconstructed timing</strong><span>{formatDuration(recordedDuration)}</span></div></div>
          <div className="bt-analysis-rate"><span>Rate</span><ThemedSelect compact value={String(replayRate)} options={[1, 2, 4, 16].map((rate) => ({ value: String(rate), label: `${rate}×` }))} placeholder="1×" label="Replay rate" onChange={(value) => setReplayRate(Number(value))} /></div>
        </section> : null}

        <TelemetryCharts samples={combined.samples} fields={combined.fields} gaps={[]} selectedFieldKeys={combined.selectedChartKeys} windowMs={windowMs} paused={displayPaused || replayPlaying} mode={chartMode} />

        <footer className="bt-analysis-footer">
          <div><span><strong>{activeSources.length}</strong> source{activeSources.length === 1 ? '' : 's'}</span><span><strong>{combined.samples.length.toLocaleString()}</strong> retained records</span><span><strong>{combined.selectedChartKeys.length}</strong> selected</span></div>
          <div className="bt-analysis-export"><ThemedSelect compact value={exportFormat} options={[{ value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON' }]} placeholder="CSV" label="Export format" onChange={(value) => setExportFormat(value as ExportFormat)} /><button className="sd-primary-button" type="button" disabled={exporting || !combined.selectedChartKeys.length || !combined.samples.length} onClick={() => void exportData()}>{exporting ? <LoaderCircle className="sd-spin" size={15} /> : <Download size={15} />} Export selected</button></div>
        </footer>
      </main>
    </div>
    <p className="bt-visualize-notice" role="status" aria-live="polite">{notice}</p>
  </section>;
}
