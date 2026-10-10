import { useDocumentVisible } from '../lib/useDocumentVisible';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AlertTriangle,
  BookmarkPlus,
  BellRing,
  CirclePause,
  CirclePlay,
  Download,
  FolderOpen,
  LoaderCircle,
  Plus,
  Radio,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  beginNativeTelemetryExport,
  appendNativeTelemetryExport,
  finishNativeTelemetryExport,
  cancelNativeTelemetryExport,
  listNativeSavedLogs,
  type SavedLog,
} from '../lib/serial';
import {
  liveTelemetryStore,
  type TelemetryGap,
  type TelemetryField,
  type TelemetrySample,
  type TelemetrySessionSnapshot,
  type TelemetryValue,
} from '../lib/telemetry';
import {
  watchOptionsError,
  type TelemetryAlertCondition,
  type TelemetryAlertEvent,
  type TelemetryAlertRule,
} from '../lib/telemetryAlerts';
import { loadAnalysisWorkspaces, storeAnalysisWorkspaces, resolveAnalysisSession, selectedAnalysisFields, preserveUnavailableAnalysisSources, type SavedAnalysisWorkspace, type AnalysisSourcePreset } from '../lib/analysisWorkspaces';
import { stableTerminalSessionIdentity } from '../lib/sessionWorkspaces';
import { defaultSerialConnectionSettings } from '../lib/serial';
import { analyzeNativeCapture, type CaptureAnalysisIndex, type CaptureRange } from '../lib/captureAnalysis';
import { telemetryExportChunks, type TelemetryExportRow } from '../lib/telemetryExport';
import { telemetryReplayTimeline } from '../lib/telemetryReplay';
import { WatchHistoryJournal, watchHistoryExportChunks, type WatchHistoryRow } from '../lib/watchHistory';
import { TelemetryWatchEngine } from '../lib/telemetryWatchEngine';
import { TelemetryProjectionCache } from '../lib/telemetryProjection';
import type { TelemetryDecoderProfile } from '../lib/telemetryDecoders';
import { telemetrySeriesColor } from '../lib/telemetryChart';
import { TelemetryCharts, type ChartMode } from './TelemetryECharts';
import { TelemetryDecoderPanel, type TelemetryDecoderSource } from './TelemetryDecoderPanel';
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
  index: CaptureAnalysisIndex;
  selection: CaptureRange;
  timingMode: 'recorded' | 'approximate';
  decoderProfile?: TelemetryDecoderProfile;
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

type WatchEventRow = WatchHistoryRow;

const MAX_SELECTED_FIELDS = 8;
const MAX_WATCH_EVENTS = 100;
const ANALYSIS_EPOCH_MS = Date.UTC(2000, 0, 1);
const WINDOW_OPTIONS = [
  { value: 0, label: 'All data' },
  { value: 10_000, label: '10 seconds' },
  { value: 30_000, label: '30 seconds' },
  { value: 60_000, label: '1 minute' },
  { value: 5 * 60_000, label: '5 minutes' },
] as const;
const CUSTOM_WINDOW_VALUE = 'custom';
const CUSTOM_WINDOW_UNITS = [
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
] as const;

type CustomWindowUnit = (typeof CUSTOM_WINDOW_UNITS)[number]['value'];
type CustomWindow = Readonly<{ amount: number; unit: CustomWindowUnit }>;

// Selection memory also supports callers that mount an independent analysis view.
let signalSelectionMemory: Readonly<{ configured: boolean; fieldIds: readonly string[]; sourceIds: readonly string[] }> = { configured: false, fieldIds: [], sourceIds: [] };

function rememberSignalSelection(fieldIds: readonly string[], sourceId?: string) {
  signalSelectionMemory = { configured: true, fieldIds: [...fieldIds], sourceIds: sourceId ? [...new Set([...signalSelectionMemory.sourceIds, sourceId])] : signalSelectionMemory.sourceIds };
}

function forgetSignalSelection() {
  signalSelectionMemory = { configured: false, fieldIds: [], sourceIds: [] };
}

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
    if (values.size >= snapshot.fields.length) break;
  }
  return values;
}

function formatFieldValue(value: TelemetryValue | undefined) {
  if (!value) return '—';
  const absolute = Math.abs(value.value);
  if ((absolute > 0 && absolute < 0.0001) || absolute >= 10_000_000) return value.value.toExponential(3);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 5 }).format(value.value);
}

function formatWatchTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Just now';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
}

function formatWatchTarget(rule: Pick<TelemetryAlertRule, 'condition' | 'threshold' | 'min' | 'max' | 'unit'>) {
  const unit = rule.unit ? ` ${rule.unit}` : '';
  if (rule.condition === 'above') return `above ${formatFieldValue({ value: typeof rule.threshold === 'number' ? rule.threshold : Number.NaN })}${unit}`;
  if (rule.condition === 'below') return `below ${formatFieldValue({ value: typeof rule.threshold === 'number' ? rule.threshold : Number.NaN })}${unit}`;
  return `outside ${formatFieldValue({ value: rule.min ?? Number.NaN })}–${formatFieldValue({ value: rule.max ?? Number.NaN })}${unit}`;
}

function formatWatchRule(rule: Pick<TelemetryAlertRule, 'fieldKey' | 'condition' | 'threshold' | 'min' | 'max' | 'unit'>) {
  return `${rule.fieldKey} · ${formatWatchTarget(rule)}`;
}

function formatWatchEvent(event: TelemetryAlertEvent) {
  const unit = event.unit ? ` ${event.unit}` : '';
  const observed = `${formatFieldValue({ value: event.value })}${unit}`;
  if (event.condition === 'above') return `${observed} is above ${formatFieldValue({ value: event.threshold ?? Number.NaN })}${unit}`;
  if (event.condition === 'below') return `${observed} is below ${formatFieldValue({ value: event.threshold ?? Number.NaN })}${unit}`;
  return `${observed} is outside ${formatFieldValue({ value: event.min ?? Number.NaN })}–${formatFieldValue({ value: event.max ?? Number.NaN })}${unit}`;
}

function freshWatchId() {
  return globalThis.crypto?.randomUUID?.() ?? `watch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatDuration(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0s';
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const roundedSeconds = Math.round(milliseconds / 1_000);
  if (roundedSeconds < 60) return `${roundedSeconds}s`;
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function customWindowMilliseconds(amount: number, unit: CustomWindowUnit) {
  return amount * (unit === 'hours' ? 60 * 60_000 : 60_000);
}

function formatCustomWindow({ amount, unit }: CustomWindow) {
  const quantity = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(amount);
  const singular = amount === 1;
  return `${quantity} ${unit === 'hours' ? singular ? 'hour' : 'hours' : singular ? 'minute' : 'minutes'}`;
}

function customWindowValidation(value: string, unit: CustomWindowUnit) {
  if (!value.trim()) return 'Enter a duration greater than zero.';
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 'Enter a duration greater than zero.';
  if (!Number.isSafeInteger(customWindowMilliseconds(amount, unit))) return 'Enter a smaller duration.';
  return '';
}

function sourceRange(snapshot: TelemetrySessionSnapshot) {
  const first = Date.parse(snapshot.samples[0]?.timestamp ?? '');
  const last = Date.parse(snapshot.samples[snapshot.samples.length - 1]?.timestamp ?? '');
  if (!Number.isFinite(first) || !Number.isFinite(last)) return { start: 0, end: 0, duration: 0 };
  return { start: first, end: last, duration: Math.max(0, last - first) };
}

function analysisSourceLabel(source: AnalysisSource) {
  return source.kind === 'live' ? source.session.port : source.name;
}

function analysisSourceRange(source: AnalysisSource) {
  if (source.kind === 'live') return sourceRange(source.snapshot);
  const { start, end } = source.index.range;
  return { start, end, duration: Math.max(0, end - start) };
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
    '--bt-visualize-field-color-dark': telemetrySeriesColor(field.colorIndex),
    '--bt-visualize-field-color-light': telemetrySeriesColor(field.colorIndex, true),
  } as CSSProperties;
  return <label className={`bt-analysis-field ${checked ? 'is-selected' : ''}`} style={style}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
    <span className="bt-analysis-field-swatch" aria-hidden="true" />
    <span className="bt-analysis-field-label"><strong title={field.field.key}>{field.field.key}</strong></span>
    <span className="bt-analysis-field-value"><strong>{formatFieldValue(field.latest)}</strong>{field.latest?.unit || field.field.unit ? <small>{field.latest?.unit ?? field.field.unit}</small> : null}</span>
    <span className="bt-analysis-field-toggle" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m3.5 8 3 3 6-6" /></svg></span>
  </label>;
}

export type TelemetryAnalysisWorkspaceProps = VisualizeScreenProps & {
  requestedAnalysis?: { id: string; revision: number } | null;
  onRequestedAnalysisRestored?: () => void;
  requestedCapturePath?: string | null;
  onRequestedCaptureOpened?: () => void;
};

export function TelemetryAnalysisWorkspace({
  workspaceVisible = true,
  nativeEnabled,
  sessions,
  selectedSessionId,
  onSelectSession,
  onRequestConnection,
  onTelemetryAlert,
  requestedCapturePath,
  requestedAnalysis,
  onRequestedAnalysisRestored,
  onRequestedCaptureOpened,
}: TelemetryAnalysisWorkspaceProps) {
  const pageRef = useRef<HTMLElement>(null);
  const [logs, setLogs] = useState<SavedLog[]>([]);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const libraryRefresh = useRef(0);
  const [loadedLibraryRefresh, setLoadedLibraryRefresh] = useState(0);
  const [savedLibrary, setSavedLibrary] = useState(loadAnalysisWorkspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(savedLibrary.activeId ?? '');
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const [restoringWorkspace, setRestoringWorkspace] = useState(false);
  const [pendingDevices, setPendingDevices] = useState<string[]>([]);
  const [missingCaptures, setMissingCaptures] = useState<string[]>([]);
  const restoreGeneration = useRef(0);
  const initialRestoreDone = useRef(false);
  const restoreIntent = useRef<{ workspace: SavedAnalysisWorkspace; pendingLives: AnalysisSourcePreset[]; bindings: Map<string, string>; removedCapturePaths: Set<string> } | null>(null);
  const pendingSelections = useRef(new Map<string, string[]>());
  const [restoreRevision, setRestoreRevision] = useState(0);
  const [activeSourceIds, setActiveSourceIds] = useState<string[]>([]);
  const excludedLiveSources = useRef(new Set<string>());
  const [recordedSources, setRecordedSources] = useState<Record<string, RecordedSource>>({});
  const [sourceChoice, setSourceChoice] = useState('');
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState(0);
  const captureLoad = useRef<AbortController | null>(null);
  const captureIndexes = useRef(new Set<CaptureAnalysisIndex>());
  const exportAbort = useRef<AbortController | null>(null);
  const [rangeSourceId, setRangeSourceId] = useState('');
  const [rangeStart, setRangeStart] = useState('0');
  const [rangeEnd, setRangeEnd] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [rangeEditorOpen, setRangeEditorOpen] = useState(false);
  const [querying, setQuerying] = useState(false);
  useEffect(() => () => {
    captureLoad.current?.abort(); exportAbort.current?.abort(); historyExportAbort.current?.abort();
    captureIndexes.current.forEach((index) => void index.dispose().catch(() => undefined));
    captureIndexes.current.clear();
  }, []);
  const [libraryError, setLibraryError] = useState('');
  const [notice, setNotice] = useState('');
  const [liveRevision, setLiveRevision] = useState(0);
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [viewedSourceId, setViewedSourceId] = useState('');
  const configuredSources = useRef(new Set<string>(signalSelectionMemory.sourceIds));
  const [fieldQuery, setFieldQuery] = useState('');
  const [fieldsConfigured, setFieldsConfigured] = useState(false);
  const [alignment, setAlignment] = useState<AlignmentMode>('elapsed');
  const [windowMs, setWindowMs] = useState(0);
  const [customWindow, setCustomWindow] = useState<CustomWindow | null>(null);
  const [customWindowOpen, setCustomWindowOpen] = useState(false);
  const [customWindowAmount, setCustomWindowAmount] = useState('15');
  const [customWindowUnit, setCustomWindowUnit] = useState<CustomWindowUnit>('minutes');
  const [customWindowError, setCustomWindowError] = useState('');
  const customWindowInputRef = useRef<HTMLInputElement>(null);
  const [chartMode, setChartMode] = useState<ChartMode>('compare');
  const [chartResetRevision, setChartResetRevision] = useState(0);
  const [displayPaused, setDisplayPaused] = useState(false);
  const frozenLiveSnapshots = useRef<Record<string, TelemetrySessionSnapshot>>({});
  const [replayProgress, setReplayProgress] = useState(1);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayRate, setReplayRate] = useState(1);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('csv');
  const [exporting, setExporting] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [watchRules, setWatchRules] = useState<TelemetryAlertRule[]>([]);
  const [watchEvents, setWatchEvents] = useState<WatchEventRow[]>([]);
  const [watchBreachCounts, setWatchBreachCounts] = useState<Record<string, number>>({});
  const [activeBreach, setActiveBreach] = useState<WatchEventRow | null>(null);
  const [watchFieldId, setWatchFieldId] = useState('');
  const [watchCondition, setWatchCondition] = useState<TelemetryAlertCondition>('above');
  const [watchThreshold, setWatchThreshold] = useState('');
  const [watchMinimum, setWatchMinimum] = useState('');
  const [watchMaximum, setWatchMaximum] = useState('');
  const [watchSustain, setWatchSustain] = useState('0');
  const [watchHysteresis, setWatchHysteresis] = useState('0');
  const [watchStale, setWatchStale] = useState('10');
  const [historyJournal] = useState(() => new WatchHistoryJournal());
  const [historyCount, setHistoryCount] = useState(0);
  const [historyError, setHistoryError] = useState('');
  const [historyWriteError, setHistoryWriteError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyExporting, setHistoryExporting] = useState(false);
  const historyExportAbort = useRef<AbortController | null>(null);
  const historyMounted = useRef(true);
  const [watchFormError, setWatchFormError] = useState('');
  const [watchStateRevision, setWatchStateRevision] = useState(0);
  const requestedCaptureHandled = useRef<string | null>(null);
  const requestedAnalysisHandled = useRef<{ id: string; revision: number } | null>(null);
  const requestedAnalysisRef = useRef(requestedAnalysis);
  requestedAnalysisRef.current = requestedAnalysis;
  const watchBreachCountsRef = useRef(new Map<string, number>());
  const onTelemetryAlertRef = useRef(onTelemetryAlert);

  useEffect(() => {
    onTelemetryAlertRef.current = onTelemetryAlert;
  }, [onTelemetryAlert]);

  useEffect(() => {
    if (!nativeEnabled) { setLibraryLoaded(true); return; }
    if (!workspaceVisible && !savedLibrary.activeId && !requestedAnalysis && !requestedCapturePath) return undefined;
    const refresh = ++libraryRefresh.current;
    let cancelled = false;
    void listNativeSavedLogs()
      .then((nextLogs) => {
        if (!cancelled) {
          setLogs(nextLogs);
          setLibraryLoaded(true);
          setLoadedLibraryRefresh(refresh);
          setLibraryError('');
        }
      })
      .catch((reason) => {
        if (!cancelled) setLibraryError(reason instanceof Error ? reason.message : 'Could not load saved captures.');
      });
    return () => { cancelled = true; };
  }, [nativeEnabled, workspaceVisible, requestedAnalysis?.id, requestedAnalysis?.revision, requestedCapturePath]);

  useEffect(() => {
    // Saved comparisons retain their intended membership. Current analysis
    // discovers all open terminals, including ones opened after this page.
    if (activeWorkspaceId || restoringWorkspace || restoreIntent.current) return;
    const detected = sessions.map(liveSourceId).filter((id) => !excludedLiveSources.current.has(id));
    setActiveSourceIds((current) => {
      const additions = detected.filter((id) => !current.includes(id));
      return additions.length ? [...current, ...additions] : current;
    });
  }, [activeWorkspaceId, restoringWorkspace, sessions]);

  useEffect(() => {
    const liveKeys = new Set(sessions.map((session) => session.uiKey));
    setActiveSourceIds((current) => {
      const retained = current.filter((id) => !id.startsWith('live:') || liveKeys.has(id.slice('live:'.length)));
      return retained.length === current.length ? current : retained;
    });
    setWatchRules((current) => {
      const retained = current.filter((rule) => liveKeys.has(rule.sessionKey));
      return retained.length === current.length ? current : retained;
    });
  }, [sessions]);

  const resolvedViewedSourceId = activeSourceIds.includes(viewedSourceId) ? viewedSourceId
    : activeSourceIds.find((id) => sessions.some((session) => session.id === selectedSessionId && liveSourceId(session) === id)) ?? activeSourceIds[0] ?? '';
  const documentVisible = useDocumentVisible();
  const displayVisible = workspaceVisible && documentVisible;
  const cachedLiveSnapshots = useRef<Record<string, TelemetrySessionSnapshot>>({});
  useEffect(() => {
    // Observation schedules paints only for the visible source. The shared
    // serial store and watch engine ingest all ports independently of this.
    const liveKeys = resolvedViewedSourceId.startsWith('live:') ? [resolvedViewedSourceId.slice('live:'.length)] : [];
    if (!liveKeys.length || displayPaused || !displayVisible) return undefined;
    let timer: number | undefined;
    let scrollTimer: number | undefined;
    let scrolling = false;
    let dirty = false;
    const scroller = pageRef.current?.closest<HTMLElement>('.signaldeck-main');
    const notify = () => {
      dirty = true;
      if (timer !== undefined || scrolling) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        dirty = false;
        setLiveRevision((current) => current + 1);
      }, 120);
    };
    const onScroll = () => {
      scrolling = true;
      if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
      if (scrollTimer !== undefined) window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        scrollTimer = undefined;
        scrolling = false;
        if (dirty) { dirty = false; setLiveRevision((current) => current + 1); }
      }, 100);
    };
    // The store and watch engine keep consuming every sample. Only the costly
    // display snapshot waits while native scrolling has the user's attention.
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    const unsubscribers = liveKeys.map((key) => liveTelemetryStore.subscribe(key, notify));
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      scroller?.removeEventListener('scroll', onScroll);
      if (timer !== undefined) window.clearTimeout(timer);
      if (scrollTimer !== undefined) window.clearTimeout(scrollTimer);
    };
  }, [resolvedViewedSourceId, displayPaused, displayVisible]);

  const loadCapture = useCallback(async (log: SavedLog, profile?: TelemetryDecoderProfile, replace = false, requestedRange?: CaptureRange) => {
    const id = recordedSourceId(log.path);
    if (recordedSources[id] && !replace) {
      setActiveSourceIds((current) => current.includes(id) ? current : [...current, id]);
      setNotice(`${log.sessionName} is on the comparison canvas.`);
      return recordedSources[id];
    }
    captureLoad.current?.abort();
    const abort = new AbortController(); captureLoad.current = abort;
    setLoadingPath(log.path); setLoadProgress(0); setLibraryError('');
    try {
      const result = await analyzeNativeCapture(id, log, { profile, signal: abort.signal, onProgress: setLoadProgress });
      abort.signal.throwIfAborted(); captureIndexes.current.add(result.index);
      const selection = requestedRange ? {
        start: Math.max(result.index.range.start, Math.min(result.index.range.end, requestedRange.start)),
        end: Math.max(result.index.range.start, Math.min(result.index.range.end, requestedRange.end)),
      } : result.index.range;
      const source: RecordedSource = { id, kind: 'recorded', name: log.sessionName, detail: log.port ?? log.fileName, log,
        snapshot: result.snapshot, index: result.index, selection, timingMode: result.index.timingMode, decoderProfile: profile };
      setRecordedSources((current) => ({ ...current, [id]: source }));
      const previous = recordedSources[id];
      if (previous) { captureIndexes.current.delete(previous.index); void previous.index.dispose().catch(() => undefined); }
      setActiveSourceIds((current) => current.includes(id) ? current : [...current, id]);
      setReplayProgress(1);
      if (!restoreIntent.current) { setViewedSourceId(id); setRangeSourceId(id); }
      setNotice(`${log.sessionName} indexed ${result.index.totalRecords.toLocaleString()} telemetry records from the complete capture.`);
      return source;
    } catch (reason) {
      if (!abort.signal.aborted) setLibraryError(reason instanceof Error ? reason.message : 'Could not open that capture for analysis.');
      return undefined;
    } finally {
      if (captureLoad.current === abort) { captureLoad.current = null; setLoadingPath(null); }
    }
  }, [recordedSources]);

  useEffect(() => {
    if (!requestedCapturePath) {
      requestedCaptureHandled.current = null;
      return;
    }
    // This view stays mounted while hidden. A new request must use the current
    // refresh, including when an older, nonempty capture list is still retained.
    if (!loadedLibraryRefresh || loadedLibraryRefresh !== libraryRefresh.current || requestedCaptureHandled.current === requestedCapturePath) return;
    requestedCaptureHandled.current = requestedCapturePath;
    const log = logs.find((candidate) => candidate.path === requestedCapturePath);
    if (!log) {
      setLibraryError('That saved capture is no longer in the local library.');
      onRequestedCaptureOpened?.();
      return;
    }
    void loadCapture(log).finally(() => onRequestedCaptureOpened?.());
  }, [loadCapture, logs, loadedLibraryRefresh, onRequestedCaptureOpened, requestedCapturePath]);

  const liveSources = useMemo<LiveSource[]>(() => sessions.map((session) => {
    const id = liveSourceId(session);
    const snapshot = displayPaused
      ? frozenLiveSnapshots.current[id] ?? liveTelemetryStore.getSnapshot(session.uiKey)
      : id === resolvedViewedSourceId ? liveTelemetryStore.getSnapshot(session.uiKey)
        : cachedLiveSnapshots.current[id] ?? liveTelemetryStore.getSnapshot(session.uiKey);
    cachedLiveSnapshots.current[id] = snapshot;
    return { id, kind: 'live', name: session.sessionName, detail: session.port, session, snapshot };
    // liveRevision deliberately promotes external-store changes into this memo.
  }), [displayPaused, liveRevision, sessions, resolvedViewedSourceId, displayVisible]);
  useEffect(() => {
    const openIds = new Set(sessions.map(liveSourceId));
    for (const id of Object.keys(cachedLiveSnapshots.current)) {
      if (!openIds.has(id)) delete cachedLiveSnapshots.current[id];
    }
  }, [sessions]);

  useEffect(() => {
    if (loadingPath || restoringWorkspace) return;
    const retained = new Set(Object.values(recordedSources).map((source) => source.index));
    for (const index of captureIndexes.current) {
      if (!retained.has(index)) { captureIndexes.current.delete(index); void index.dispose().catch(() => undefined); }
    }
  }, [recordedSources, loadingPath, restoringWorkspace]);

  const recordedSelectionKey = selectedFields.join('\u0000');
  const recordedQueryKey = Object.values(recordedSources).map((source) => `${source.id}:${source.index.id}:${source.selection.start}:${source.selection.end}`).join('|');
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    const sources = Object.values(recordedSources);
    if (!sources.length) { setQuerying(false); return undefined; }
    setQuerying(true);
    void (async () => {
      try {
        for (const source of sources) {
          const prefix = `${source.id}\u0000`;
          const keys = selectedFields.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
          const result = await source.index.query(source.selection, keys.length ? keys : undefined, abort.signal);
          if (cancelled) return;
          setRecordedSources((current) => current[source.id]?.index === source.index
            ? { ...current, [source.id]: { ...current[source.id], snapshot: result.snapshot } } : current);
        }
      } catch (reason) {
        if (!cancelled) setLibraryError(reason instanceof Error ? reason.message : 'Could not read the selected capture range.');
      } finally { if (!cancelled) setQuerying(false); }
    })();
    return () => { cancelled = true; abort.abort(); };
    // Index IDs and ranges change only when loading, removing, or selecting a capture.
    // Updated overview snapshots deliberately do not restart their own disk query.
  }, [recordedQueryKey, recordedSelectionKey]);

  const rangedCapture = recordedSources[rangeSourceId] ?? Object.values(recordedSources)[0];
  useEffect(() => {
    if (!rangedCapture) return;
    setRangeSourceId(rangedCapture.id);
    setRangeStart(String((rangedCapture.selection.start - rangedCapture.index.range.start) / 1000));
    setRangeEnd(String((rangedCapture.selection.end - rangedCapture.index.range.start) / 1000));
    setRangeError('');
  }, [rangedCapture?.id, rangedCapture?.selection.start, rangedCapture?.selection.end]);
  const applyCaptureRange = (all = false) => {
    if (!rangedCapture) return;
    const from = all ? 0 : Number(rangeStart);
    const to = all ? (rangedCapture.index.range.end - rangedCapture.index.range.start) / 1000 : Number(rangeEnd);
    const duration = (rangedCapture.index.range.end - rangedCapture.index.range.start) / 1000;
    if ((!all && (!rangeStart.trim() || !rangeEnd.trim())) || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from || to > duration) {
      setRangeError(`Enter a range from 0 to ${duration.toFixed(3)} seconds, with the end at or after the start.`); return;
    }
    const selection = { start: rangedCapture.index.range.start + from * 1000, end: rangedCapture.index.range.start + to * 1000 };
    if (selection.start === rangedCapture.selection.start && selection.end === rangedCapture.selection.end) { setRangeError(''); return; }
    setQuerying(true);
    setRecordedSources((current) => ({ ...current, [rangedCapture.id]: { ...current[rangedCapture.id], selection } }));
    setRangeError(''); setReplayProgress(1); setReplayPlaying(false);
    setNotice(all ? `Showing the complete ${rangedCapture.name} capture.` : `Showing ${from}–${to} seconds from ${rangedCapture.name}.`);
  };

  const allSources = useMemo<AnalysisSource[]>(() => [...liveSources, ...Object.values(recordedSources)], [liveSources, recordedSources]);
  const sourcesById = useMemo(() => new Map(allSources.map((source) => [source.id, source])), [allSources]);
  const activeSources = useMemo(() => activeSourceIds.map((id) => sourcesById.get(id)).filter((source): source is AnalysisSource => Boolean(source)), [activeSourceIds, sourcesById]);
  const viewedSource = activeSources.find((source) => source.id === viewedSourceId)
    ?? activeSources.find((source) => source.kind === 'live' && source.session.id === selectedSessionId)
    ?? activeSources[0];
  const visibleSources = useMemo(() => viewedSource ? [viewedSource] : [], [viewedSource]);

  const availableSourceOptions = useMemo(() => allSources
    .filter((source) => !activeSourceIds.includes(source.id))
    .map((source) => ({
      value: source.id,
      label: `${source.kind === 'live' ? 'Live' : 'Capture'} · ${source.name} · ${source.detail}`,
    })), [activeSourceIds, allSources]);
  const unloadedLogOptions = useMemo(() => logs
    .filter((log) => !recordedSources[recordedSourceId(log.path)] && !activeSourceIds.includes(recordedSourceId(log.path)))
    .map((log) => ({ value: recordedSourceId(log.path), label: `Capture · ${log.sessionName} · ${log.port ?? log.fileName}` })), [activeSourceIds, logs, recordedSources]);
  const sourceOptions = [...availableSourceOptions.filter((option) => !option.value.startsWith('live:')), ...unloadedLogOptions];
  const availableTerminals = liveSources.filter((source) => !activeSourceIds.includes(source.id));

  const addChosenSource = () => {
    if (!sourceChoice) return;
    const source = sourcesById.get(sourceChoice);
    if (source) {
      setActiveSourceIds((current) => current.includes(source.id) ? current : [...current, source.id]);
      if (source.kind === 'live') onSelectSession(source.session.id);
      setNotice(`${source.name} added to the canvas.`);
      setViewedSourceId(source.id);
      if (source.kind === 'recorded') setRangeSourceId(source.id);
      setSourceChoice('');
      return;
    }
    const log = logs.find((candidate) => recordedSourceId(candidate.path) === sourceChoice);
    if (log) void loadCapture(log).then(() => setSourceChoice(''));
  };

  const applyDecoder = async (sourceId: string, profile?: TelemetryDecoderProfile) => {
    const source = sourcesById.get(sourceId);
    if (!source) return;
    if (source.kind === 'live') {
      // The live store remains the sole ordered telemetry observer. Selecting a
      // profile only swaps its optional parser; terminal display and raw
      // capture continue through the existing LiveMonitor path unchanged.
      liveTelemetryStore.setDecoderProfile(source.session.uiKey, profile);
    } else {
      const rebuilt = await loadCapture(source.log, profile, true, source.index.totalRecords ? source.selection : undefined);
      if (!rebuilt) return;
    }

    frozenLiveSnapshots.current = {};
    setWatchStateRevision((current) => current + 1);
    setDisplayPaused(false);
    setReplayPlaying(false);
    pendingSelections.current.clear();
    forgetSignalSelection();
    configuredSources.current.clear();
    setFieldsConfigured(false);
    setSelectedFields([]);
    setNotice(profile
      ? `Applied “${profile.name}” to ${source.name}. Raw capture is unchanged.`
      : `Automatic detection restored for ${source.name}. Raw capture is unchanged.`);
  };

  const removeDeletedDecoderProfile = (profile: TelemetryDecoderProfile) => {
    const affectedLiveSources = liveSources.filter((source) => source.snapshot.decoderProfile?.id === profile.id);
    const affectedRecordedSources = Object.values(recordedSources)
      .filter((source) => source.decoderProfile?.id === profile.id);
    if (!affectedLiveSources.length && !affectedRecordedSources.length) return;

    affectedLiveSources.forEach((source) => liveTelemetryStore.setDecoderProfile(source.session.uiKey));
    if (affectedRecordedSources.length) {
      // Loads are sequential so each decoder reset remains cancellable and bounded.
      void (async () => {
        const generation = restoreGeneration.current;
        for (const source of affectedRecordedSources) {
          if (generation !== restoreGeneration.current) break;
          await loadCapture(source.log, undefined, true, source.index.totalRecords ? source.selection : undefined);
        }
      })();
    }

    frozenLiveSnapshots.current = {};
    setWatchStateRevision((current) => current + 1);
    setDisplayPaused(false);
    setReplayPlaying(false);
    pendingSelections.current.clear();
    forgetSignalSelection();
    configuredSources.current.clear();
    setFieldsConfigured(false);
    setSelectedFields([]);
    setNotice(`Deleted “${profile.name}” and restored automatic detection for ${affectedLiveSources.length + affectedRecordedSources.length} loaded source${affectedLiveSources.length + affectedRecordedSources.length === 1 ? '' : 's'}.`);
  };

  const removeSource = (source: AnalysisSource) => {
    pendingSelections.current.delete(source.id);
    setActiveSourceIds((current) => current.filter((id) => id !== source.id));
    setSelectedFields((current) => {
      const next = current.filter((id) => !id.startsWith(`${source.id}\u0000`));
      rememberSignalSelection(next);
      return next;
    });
    if (source.kind === 'live') {
      excludedLiveSources.current.add(source.id);
      setWatchRules((current) => current.filter((rule) => rule.sessionKey !== source.session.uiKey));
    } else {
      restoreIntent.current?.removedCapturePaths.add(source.log.path);
      captureIndexes.current.delete(source.index);
      void source.index.dispose().catch(() => undefined);
      // Analysis survives navigation now; removing a capture must release its
      // potentially large byte/timing buffers as well as its visible traces.
      setRecordedSources((current) => {
        const { [source.id]: _removed, ...retained } = current;
        return retained;
      });
    }
    setFieldsConfigured(true);
    setNotice(`${source.name} removed from the canvas.`);
  };

  const displayFields = useMemo(() => {
    let colorIndex = 0;
    const sourceNameCounts = new Map<string, number>();
    const sourceNameOrdinals = new Map<string, number>();
    activeSources.forEach((source) => sourceNameCounts.set(analysisSourceLabel(source), (sourceNameCounts.get(analysisSourceLabel(source)) ?? 0) + 1));
    return activeSources.flatMap((source) => {
      const latest = latestValues(source.snapshot);
      const name = analysisSourceLabel(source);
      const ordinal = (sourceNameOrdinals.get(name) ?? 0) + 1;
      sourceNameOrdinals.set(name, ordinal);
      const sourceLabel = (sourceNameCounts.get(name) ?? 0) > 1 ? `${name} (${ordinal})` : name;
      return source.snapshot.fields.map<DisplayField>((field) => ({
        id: sourceFieldId(source.id, field.key),
        sourceId: source.id,
        sourceName: sourceLabel,
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
      if (retained.length || fieldsConfigured || !displayFields.length) return retained.length === current.length && retained.every((id, index) => id === current[index]) ? current : retained;
      if (signalSelectionMemory.configured) {
        const remembered = signalSelectionMemory.fieldIds.filter((id) => available.has(id));
        if (remembered.length || signalSelectionMemory.fieldIds.length === 0) return remembered;
      }
      return retained;
    });
  }, [displayFields, fieldsConfigured]);

  const selectedFieldSet = useMemo(() => new Set(selectedFields), [selectedFields]);
  const visibleFields = useMemo(() => displayFields.filter((field) => field.sourceId === viewedSource?.id), [displayFields, viewedSource?.id]);
  const visibleSelectedFields = useMemo(() => visibleFields.filter((field) => selectedFieldSet.has(field.id)), [visibleFields, selectedFieldSet]);
  const chooseViewedSource = (source: AnalysisSource) => {
    const fields = displayFields.filter((field) => field.sourceId === source.id);
    if (!activeWorkspaceId && fields.length && !configuredSources.current.has(source.id)) {
      configuredSources.current.add(source.id);
      setSelectedFields((current) => { const next = current.some((id) => fields.some((field) => field.id === id)) ? current : [...current, ...fields.slice(0, 3).map((field) => field.id)]; rememberSignalSelection(next, source.id); return next; });
    }
    setViewedSourceId(source.id);
    setFieldQuery('');
    if (source.kind === 'recorded') setRangeSourceId(source.id);
  };
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const surface = pageRef.current?.querySelector('.bt-analysis-canvas');
    const animation = surface?.animate([{ opacity: 0.65 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
    return () => animation?.cancel();
  }, [viewedSource?.id]);
  useEffect(() => {
    if (!viewedSource || !visibleFields.length || restoringWorkspace || activeWorkspaceId || pendingSelections.current.has(viewedSource.id) || configuredSources.current.has(viewedSource.id)) return;
    configuredSources.current.add(viewedSource.id);
    setSelectedFields((current) => { const next = current.some((id) => visibleFields.some((field) => field.id === id)) ? current : [...current, ...visibleFields.slice(0, 3).map((field) => field.id)]; rememberSignalSelection(next, viewedSource.id); return next; });
  }, [viewedSource?.id, visibleFields, restoringWorkspace, activeWorkspaceId]);
  const watchableFields = useMemo(() => displayFields.filter((field) => sourcesById.get(field.sourceId)?.kind === 'live'), [displayFields, sourcesById]);
  const watchFieldsById = useMemo(() => new Map(watchableFields.map((field) => [field.id, field])), [watchableFields]);
  const watchEventHandler = useRef<(event: TelemetryAlertEvent) => void>(() => undefined);
  const [watchEngine] = useState(() => new TelemetryWatchEngine(liveTelemetryStore, (event) => watchEventHandler.current(event)));
  useEffect(() => { watchEngine.setRules(watchRules); }, [watchEngine, watchRules]);
  useEffect(() => () => watchEngine.dispose(), [watchEngine]);
  useEffect(() => {
    if (!watchRules.length || !displayVisible) return undefined;
    setWatchStateRevision((value) => value + 1);
    const timer = window.setInterval(() => setWatchStateRevision((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [watchRules.length, displayVisible]);
  const activeWatchRuleIds = useMemo(() => {
    void watchStateRevision;
    return new Set(watchRules.filter((rule) => watchEngine.isBreached(rule.id)).map((rule) => rule.id));
  }, [watchEngine, watchRules, watchStateRevision]);
  const watchBreachTotal = useMemo(() => Object.values(watchBreachCounts).reduce((total, count) => total + count, 0), [watchBreachCounts]);
  const watchSources = useMemo(() => activeSources
    .filter((source): source is LiveSource => source.kind === 'live')
    .map((source) => ({ id: source.id, name: analysisSourceLabel(source), sessionKey: source.session.uiKey })), [activeSources]);
  const liveSourceNames = useMemo(() => new Map(watchSources.map((source) => [source.sessionKey, source.name])), [watchSources]);

  useEffect(() => {
    if (watchFieldId && watchFieldsById.has(watchFieldId)) return;
    setWatchFieldId(watchableFields[0]?.id ?? '');
  }, [watchFieldId, watchFieldsById, watchableFields]);

  useEffect(() => {
    if (!activeBreach) return undefined;
    const timer = window.setTimeout(() => setActiveBreach(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [activeBreach]);

  const refreshWatchHistory = async () => {
    setHistoryLoading(true);
    try {
      const recent = await historyJournal.latest();
      const summary = await historyJournal.summary();
      if (!historyMounted.current) return;
      setWatchEvents((current) => [...new Map([...current, ...recent.map((record) => record.event)].map((event) => [event.id, event])).values()].slice(0, MAX_WATCH_EVENTS));
      setHistoryCount(summary.count); setHistoryError('');
    } catch (error) { if (historyMounted.current) setHistoryError(error instanceof Error ? error.message : 'Could not open breach history.'); }
    finally { if (historyMounted.current) setHistoryLoading(false); }
  };
  useEffect(() => {
    historyMounted.current = true; void refreshWatchHistory();
    return () => { historyMounted.current = false; historyExportAbort.current?.abort(); };
  }, [historyJournal]);

  const exportWatchHistory = async () => {
    if (historyExporting) return;
    const abort = new AbortController(); historyExportAbort.current = abort;
    setHistoryExporting(true);
    let id: string | null = null;
    try {
      const format = exportFormat;
      id = nativeEnabled ? await beginNativeTelemetryExport(format, `baudtide-breaches-${new Date().toISOString().slice(0, 10)}.${format}`) : null;
      if (nativeEnabled && !id) return;
      const parts: string[] = [];
      for await (const chunk of watchHistoryExportChunks(historyJournal.events(abort.signal), format)) {
        abort.signal.throwIfAborted();
        if (id) await appendNativeTelemetryExport(id, chunk); else parts.push(chunk);
      }
      abort.signal.throwIfAborted();
      if (id) { await finishNativeTelemetryExport(id); id = null; } else downloadInBrowser(parts.join(''), format);
      setNotice('Exported saved breach history. Watches continued running.');
    } catch (error) {
      if (abort.signal.aborted) setNotice('Breach history export cancelled.');
      else setHistoryError(error instanceof Error ? error.message : 'Could not export breach history.');
    } finally {
      if (id) await cancelNativeTelemetryExport(id).catch(() => undefined);
      if (historyMounted.current) setHistoryExporting(false);
      historyExportAbort.current = null;
    }
  };

  watchEventHandler.current = (event) => {
    const occurrence = (watchBreachCountsRef.current.get(event.ruleId) ?? 0) + 1;
    watchBreachCountsRef.current.set(event.ruleId, occurrence);
    const session = sessions.find((candidate) => candidate.uiKey === event.sessionKey);
    const row: WatchEventRow = { ...event, id: freshWatchId(), sourceName: session?.port ?? liveSourceNames.get(event.sessionKey) ?? 'Device', occurrence, sourceIdentity: session?.identity, capturePath: session?.capturePath };
    void historyJournal.append(row).then(() => historyJournal.summary()).then((summary) => { if (historyMounted.current) setHistoryCount(summary.count); }).catch((error) => { if (historyMounted.current) setHistoryWriteError(error instanceof Error ? error.message : 'Breach history was not saved.'); });
    setWatchEvents((current) => [row, ...current].slice(0, MAX_WATCH_EVENTS));
    setWatchBreachCounts(Object.fromEntries(watchBreachCountsRef.current));
    setActiveBreach(row);
    setWatchStateRevision((current) => current + 1);
    onTelemetryAlertRef.current?.({ title: `Watch triggered · ${event.fieldKey}`, detail: `${row.sourceName} · ${formatWatchEvent(event)}.` });
  };

  const watchStatus = (rule: TelemetryAlertRule) => {
    const session = sessions.find((candidate) => candidate.uiKey === rule.sessionKey);
    if (!session || session.connectionState !== 'connected') return session?.connectionState.toUpperCase() ?? 'DISCONNECTED';
    const last = watchEngine.lastReadings.get(rule.id);
    if (last === undefined) return 'WAITING';
    if (Date.now() - last > (rule.staleAfterMs ?? 10_000)) return 'STALE';
    if (watchEngine.isPending(rule.id)) return 'PENDING';
    return activeWatchRuleIds.has(rule.id) ? 'BREACH' : 'LIVE';
  };

  const waitingWatchCount = watchRules.filter((rule) => !['LIVE', 'BREACH'].includes(watchStatus(rule))).length;
  const currentBreachCount = watchRules.filter((rule) => watchStatus(rule) === 'BREACH').length;

  const saveAnalysisWorkspace = (update = false) => {
    const existing = update ? savedLibrary.workspaces.find((workspace) => workspace.id === activeWorkspaceId) : undefined;
    const name = existing?.name ?? workspaceName.trim();
    if (!name || !activeSources.length) { setLibraryError('Enter a workspace name and add at least one analysis source.'); return; }
    const sources = activeSources.map<AnalysisSourcePreset>((source, ordinal) => {
      const key = `source-${ordinal}`;
      const profile = source.kind === 'live' ? source.snapshot.decoderProfile : source.decoderProfile;
      const target = source.kind === 'recorded' ? source.log.path : source.session.identity ?? stableTerminalSessionIdentity({ port: source.session.port, baudRate: source.session.baudRate ?? 115200, settings: source.session.settings ?? defaultSerialConnectionSettings });
      return { key, kind: source.kind, target, name: source.name,
        selectedFields: selectedAnalysisFields(source.id, selectedFields, pendingSelections.current.get(source.id)),
        ...(profile ? { decoder: profile } : {}), ...(source.kind === 'recorded' ? { rangeSeconds: { start: (source.selection.start - source.index.range.start) / 1000, end: (source.selection.end - source.index.range.start) / 1000 } } : {}) };
    });
    let workspace: SavedAnalysisWorkspace = { id: existing?.id ?? freshWatchId(), name, updatedAt: Date.now(), alignment, chartMode, windowMs, replayRate,
      sources, watches: watchRules.flatMap((rule) => {
        const ordinal = activeSources.findIndex((source) => source.kind === 'live' && source.session.uiKey === rule.sessionKey);
        if (ordinal < 0) return [];
        const { id: _id, sessionKey: _key, ...settings } = rule;
        return [{ ...settings, sourceKey: `source-${ordinal}` }];
      }) };
    // Updating preserves references to missing captures and devices, too.
    if (existing && restoreIntent.current?.workspace.id === existing.id) {
      const intent = restoreIntent.current;
      workspace = preserveUnavailableAnalysisSources(workspace, intent.workspace, intent.pendingLives, intent.removedCapturePaths);
    }
    const next = { ...savedLibrary, activeId: workspace.id, workspaces: [workspace, ...savedLibrary.workspaces.filter((candidate) => candidate.id !== workspace.id)] };
    try { storeAnalysisWorkspaces(next);
      if (existing && restoreIntent.current?.workspace.id === existing.id) {
        const intent = restoreIntent.current;
        intent.pendingLives = workspace.sources.filter((source) => source.kind === 'live' && intent.pendingLives.some((pending) => pending.target === source.target));
        intent.workspace = workspace;
      }
      setSavedLibrary(next); setActiveWorkspaceId(workspace.id); setSavingWorkspace(false); setWorkspaceName(''); setNotice(`Saved “${name}” locally. This analysis will restore when BaudTide reopens.`); }
    catch (reason) { setLibraryError(reason instanceof Error ? reason.message : 'Could not save this analysis.'); }
  };

  const restoreAnalysisWorkspace = async (workspace: SavedAnalysisWorkspace) => {
    const generation = ++restoreGeneration.current;
    captureLoad.current?.abort(); exportAbort.current?.abort();
    restoreIntent.current = { workspace, pendingLives: workspace.sources.filter((source) => source.kind === 'live'), bindings: new Map(), removedCapturePaths: new Set() };
    pendingSelections.current.clear();
    setPendingDevices(restoreIntent.current.pendingLives.map((source) => source.name)); setMissingCaptures([]);
    setActiveSourceIds([]); setRestoreRevision((value) => value + 1);
    setRestoringWorkspace(true); setSelectedFields([]); setFieldsConfigured(true);
    watchEngine.setRules([]); setWatchRules([]);
    setAlignment(workspace.alignment); setChartMode(workspace.chartMode); setWindowMs(workspace.windowMs); setReplayRate(workspace.replayRate);
    setCustomWindow(WINDOW_OPTIONS.some((option) => option.value === workspace.windowMs) || workspace.windowMs === 0 ? null : { amount: workspace.windowMs / 60000, unit: 'minutes' });
    setDisplayPaused(false); frozenLiveSnapshots.current = {}; setReplayPlaying(false); setReplayProgress(1);
    const restoredIds: string[] = [];
    const missing: string[] = [];
    try {
      for (const preset of workspace.sources.filter((source) => source.kind === 'recorded')) {
        if (generation !== restoreGeneration.current) return;
        const log = logs.find((candidate) => candidate.path === preset.target);
        if (!log) { missing.push(preset.name); continue; }
        const source = await loadCapture(log, preset.decoder, true);
        if (!source) { missing.push(preset.name); continue; }
        if (generation !== restoreGeneration.current) return;
        if (preset.rangeSeconds) {
          const start = Math.min(source.index.range.end, source.index.range.start + preset.rangeSeconds.start * 1000);
          const end = Math.min(source.index.range.end, source.index.range.start + preset.rangeSeconds.end * 1000);
          setRecordedSources((current) => ({ ...current, [source.id]: { ...current[source.id], selection: { start, end } } }));
        }
        restoredIds.push(source.id); pendingSelections.current.set(source.id, preset.selectedFields);
      }
      if (generation !== restoreGeneration.current) return;
      setRecordedSources((current) => {
        const keep = Object.fromEntries(Object.entries(current).filter(([id]) => restoredIds.includes(id)));
        return keep;
      });
      setActiveSourceIds((current) => {
        const available = new Set([...current, ...restoredIds]);
        return workspace.sources.map((preset) => preset.kind === 'recorded' ? recordedSourceId(preset.target) : restoreIntent.current?.bindings.get(preset.key))
          .filter((id): id is string => Boolean(id && available.has(id)));
      });
      setMissingCaptures(missing); setRestoreRevision((value) => value + 1);
      setNotice(`Restored “${workspace.name}”. Missing devices remain disconnected; connect them from Live terminal.`);
    } finally { if (generation === restoreGeneration.current) setRestoringWorkspace(false); }
  };

  useEffect(() => {
    if (!restoreIntent.current) return;
    const intent = restoreIntent.current;
    const remaining: AnalysisSourcePreset[] = [];
    const restoredRules: TelemetryAlertRule[] = [];
    for (const preset of intent.pendingLives) {
      const session = resolveAnalysisSession(preset.target, sessions);
      if (!session) { remaining.push(preset); continue; }
      const sourceId = liveSourceId(session);
      const previousDecoder = liveTelemetryStore.getSnapshot(session.uiKey).decoderProfile;
      if (JSON.stringify(previousDecoder ?? null) !== JSON.stringify(preset.decoder ?? null)) liveTelemetryStore.setDecoderProfile(session.uiKey, preset.decoder);
      intent.bindings.set(preset.key, sourceId);
      setActiveSourceIds((current) => current.includes(sourceId) ? current : [...current, sourceId]);
      pendingSelections.current.set(sourceId, preset.selectedFields);
      restoredRules.push(...intent.workspace.watches.filter((watch) => watch.sourceKey === preset.key).map((watch) => {
        const { sourceKey: _key, ...rule } = watch;
        return { ...rule, id: freshWatchId(), sessionKey: session.uiKey };
      }));
    }
    intent.pendingLives = remaining;
    if (remaining.length !== pendingDevices.length) setActiveSourceIds((current) => {
      const ordered = intent.workspace.sources.map((preset) => preset.kind === 'recorded' ? recordedSourceId(preset.target) : intent.bindings.get(preset.key))
        .filter((id): id is string => Boolean(id && current.includes(id)));
      return [...ordered, ...current.filter((id) => !ordered.includes(id))];
    });
    setPendingDevices(remaining.map((source) => source.name));
    if (restoredRules.length) { const next = [...watchRules, ...restoredRules]; watchEngine.setRules(next); setWatchRules(next); setWatchOpen(true); }
    if (remaining.length !== pendingDevices.length) setLiveRevision((value) => value + 1);
  }, [sessions, restoringWorkspace, restoreRevision]);

  useEffect(() => {
    if (!pendingSelections.current.size) return;
    const nextIds: string[] = [];
    for (const [sourceId, fields] of pendingSelections.current) {
      const available = fields.filter((field) => displayFields.some((candidate) => candidate.id === sourceFieldId(sourceId, field)));
      nextIds.push(...available.map((field) => sourceFieldId(sourceId, field)));
      const remaining = fields.filter((field) => !available.includes(field));
      if (remaining.length) pendingSelections.current.set(sourceId, remaining); else pendingSelections.current.delete(sourceId);
    }
    if (nextIds.length) setSelectedFields((current) => [...new Set([...current, ...nextIds])]);
  }, [displayFields, restoreRevision]);

  useEffect(() => {
    if (initialRestoreDone.current || !libraryLoaded || requestedAnalysis) return;
    initialRestoreDone.current = true;
    const workspace = savedLibrary.workspaces.find((candidate) => candidate.id === savedLibrary.activeId);
    if (workspace) void restoreAnalysisWorkspace(workspace);
  }, [libraryLoaded]);

  useEffect(() => {
    if (!requestedAnalysis) { requestedAnalysisHandled.current = null; return; }
    if (!libraryLoaded) return;
    // A previous successful visit does not make the current capture scan ready.
    // The refresh effect above advances the generation before this effect runs.
    if (nativeEnabled && (!loadedLibraryRefresh || loadedLibraryRefresh !== libraryRefresh.current)) return;
    if (requestedAnalysisHandled.current?.id === requestedAnalysis.id
      && requestedAnalysisHandled.current.revision === requestedAnalysis.revision) return;
    requestedAnalysisHandled.current = requestedAnalysis;
    const request = requestedAnalysis;
    const complete = () => {
      if (requestedAnalysisRef.current?.id === request.id && requestedAnalysisRef.current.revision === request.revision) onRequestedAnalysisRestored?.();
    };
    const library = loadAnalysisWorkspaces();
    const workspace = library.workspaces.find((candidate) => candidate.id === requestedAnalysis.id);
    if (!workspace) { setLibraryError('The analysis linked to this setup is unavailable. Save or select another analysis.'); complete(); return; }
    try {
      const next = { ...library, activeId: workspace.id };
      storeAnalysisWorkspaces(next); setSavedLibrary(next); setActiveWorkspaceId(workspace.id);
      initialRestoreDone.current = true;
      void restoreAnalysisWorkspace(workspace).catch((error) => setLibraryError(error instanceof Error ? error.message : 'Could not restore the linked analysis.')).finally(complete);
    } catch (error) { setLibraryError(error instanceof Error ? error.message : 'Could not restore the linked analysis.'); complete(); }
  }, [requestedAnalysis?.id, requestedAnalysis?.revision, libraryLoaded, nativeEnabled, loadedLibraryRefresh]);

  const chooseAnalysisWorkspace = (id: string) => {
    const workspace = savedLibrary.workspaces.find((candidate) => candidate.id === id);
    const next = { ...savedLibrary, activeId: workspace?.id ?? null };
    try { storeAnalysisWorkspaces(next); setSavedLibrary(next); setActiveWorkspaceId(workspace?.id ?? ''); }
    catch (reason) { setLibraryError(reason instanceof Error ? reason.message : 'Could not select this analysis.'); return; }
    if (workspace) void restoreAnalysisWorkspace(workspace);
    else { restoreGeneration.current += 1; restoreIntent.current = null; pendingSelections.current.clear(); setPendingDevices([]); setMissingCaptures([]); }
  };

  const addWatch = () => {
    const field = watchFieldsById.get(watchFieldId);
    const source = field ? sourcesById.get(field.sourceId) : undefined;
    if (!field || !source || source.kind !== 'live') {
      setWatchFormError('Choose a live signal before adding a watch.');
      return;
    }
    if (watchRules.some((rule) => rule.sessionKey === source.session.uiKey && rule.fieldKey === field.field.key)) {
      setWatchFormError('This signal already has a watch. Remove it before setting a new boundary.');
      return;
    }
    const unit = field.latest?.unit ?? field.field.unit;
    const threshold = Number(watchThreshold);
    const minimum = Number(watchMinimum);
    const maximum = Number(watchMaximum);
    let rule: TelemetryAlertRule;
    if (watchCondition === 'outsideRange') {
      if (!watchMinimum.trim() || !watchMaximum.trim() || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum >= maximum) {
        setWatchFormError('Enter a lower value and a higher value for the expected range.');
        return;
      }
      rule = {
        id: freshWatchId(),
        sessionKey: source.session.uiKey,
        fieldKey: field.field.key,
        ...(unit ? { unit } : {}),
        condition: 'outsideRange',
        min: minimum,
        max: maximum,
        enabled: true,
      };
    } else {
      if (!watchThreshold.trim() || !Number.isFinite(threshold)) {
        setWatchFormError('Enter a numeric boundary for this watch.');
        return;
      }
      rule = {
        id: freshWatchId(),
        sessionKey: source.session.uiKey,
        fieldKey: field.field.key,
        ...(unit ? { unit } : {}),
        condition: watchCondition,
        threshold,
        enabled: true,
      };
    }
    const options = { sustainMs: Math.round(Number(watchSustain) * 1000), hysteresis: Number(watchHysteresis), staleAfterMs: Math.round(Number(watchStale) * 1000) };
    const optionsError = !watchSustain.trim() || !watchHysteresis.trim() || !watchStale.trim() ? 'Enter a duration, recovery margin, and stale timeout.' : watchOptionsError({ ...rule, ...options });
    if (optionsError) { setWatchFormError(optionsError); return; }
    rule = { ...rule, ...options };
    watchEngine.setRules([...watchRules, rule]);
    setWatchRules((current) => [...current, rule]);
    setWatchFormError('');
    setWatchThreshold('');
    setWatchMinimum('');
    setWatchMaximum('');
    setWatchOpen(true);
    setNotice(`Watching ${field.field.key} from ${source.name}.`);
  };

  const removeWatch = (rule: TelemetryAlertRule) => {
    watchEngine.setRules(watchRules.filter((candidate) => candidate.id !== rule.id));
    setWatchRules((current) => current.filter((candidate) => candidate.id !== rule.id));
    setNotice(`Stopped watching ${rule.fieldKey}.`);
  };

  const toggleField = (field: DisplayField) => {
    const selected = selectedFieldSet.has(field.id);
    if (!selected && visibleSelectedFields.length >= MAX_SELECTED_FIELDS) {
      setNotice(`Choose up to ${MAX_SELECTED_FIELDS} signals. Remove one before adding another.`);
      return;
    }
    pendingSelections.current.delete(field.sourceId);
    configuredSources.current.add(field.sourceId);
    setFieldsConfigured(true);
    setSelectedFields((current) => {
      const next = selected ? current.filter((id) => id !== field.id) : [...current, field.id];
      rememberSignalSelection(next, field.sourceId);
      return next;
    });
  };

  const replayTimeline = useMemo(() => telemetryReplayTimeline(activeSources
    .filter((source): source is RecordedSource => source.kind === 'recorded')
    .map((source) => ({ id: source.id, start: source.selection.start, end: source.selection.end, origin: source.index.range.start })), alignment, replayProgress), [activeSources, alignment, replayProgress]);
  const recordedDuration = replayTimeline.duration;

  useEffect(() => {
    if (!replayPlaying || !recordedDuration || !workspaceVisible) return undefined;
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
  }, [recordedDuration, replayPlaying, replayRate, workspaceVisible]);

  useEffect(() => {
    if (!customWindowOpen) return undefined;
    const focusTimer = window.setTimeout(() => customWindowInputRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [customWindowOpen]);

  const chartTimeline = useMemo(() => alignment === 'elapsed'
    ? { kind: 'elapsed' as const, originMs: ANALYSIS_EPOCH_MS } : { kind: 'clock' as const }, [alignment]);
  const [projectionCache] = useState(() => new TelemetryProjectionCache());
  const combined = useMemo(() => {
    const fields: TelemetryField[] = [];
    const samples: TelemetrySample[] = [];
    const gaps: TelemetryGap[] = [];
    const chartKeysByFieldId = new Map(displayFields.map((field) => [field.id, field.chartKey]));

    visibleSources.forEach((source) => {
      const range = analysisSourceRange(source);
      const replayEnd = source.kind === 'recorded'
        ? replayTimeline.sourceEnds.get(source.id) ?? source.selection.end
        : Number.POSITIVE_INFINITY;
      source.snapshot.fields.forEach((field) => {
        const fieldId = sourceFieldId(source.id, field.key);
        const chartKey = chartKeysByFieldId.get(fieldId);
        if (chartKey) fields.push({ ...field, key: chartKey });
      });
      source.snapshot.gaps.forEach((gap) => {
        const timestamp = Date.parse(gap.timestamp);
        gaps.push({ ...gap, id: `${source.id}:${gap.id}`, timestamp: new Date(alignment === 'elapsed' ? ANALYSIS_EPOCH_MS + Math.max(0, timestamp - range.start) : timestamp).toISOString(), fieldKeys: source.snapshot.fields.map((field) => chartKeysByFieldId.get(sourceFieldId(source.id, field.key))).filter((key): key is string => Boolean(key)) });
      });
      const fieldKeys = new Map(source.snapshot.fields.flatMap((field) => {
        const chartKey = chartKeysByFieldId.get(sourceFieldId(source.id, field.key));
        return chartKey ? [[field.key, chartKey] as const] : [];
      }));
      samples.push(...projectionCache.project(source.snapshot.samples, {
        sourceId: source.id, fieldKeys, alignment, startMs: range.start,
        epochMs: ANALYSIS_EPOCH_MS, endMs: replayEnd,
      }));
    });
    samples.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    return {
      fields,
      samples,
      gaps,
      selectedChartKeys: visibleSelectedFields.map((field) => field.chartKey),
    };
  }, [visibleSources, alignment, displayFields, replayTimeline, visibleSelectedFields, projectionCache]);

  const toggleDisplayPause = () => {
    if (displayPaused) {
      frozenLiveSnapshots.current = {};
      setDisplayPaused(false);
      setNotice('Live sources resumed.');
      return;
    }
    frozenLiveSnapshots.current = Object.fromEntries(liveSources.map((source) => [source.id, liveTelemetryStore.getSnapshot(source.session.uiKey)]));
    setDisplayPaused(true);
    setNotice('Live sources paused on the canvas. Devices continue recording.');
  };

  const resetView = () => {
    setWindowMs(0);
    setCustomWindow(null);
    setCustomWindowOpen(false);
    setCustomWindowError('');
    setReplayProgress(1);
    setReplayPlaying(false);
    setChartResetRevision((current) => current + 1);
    setNotice('Showing all data. Chart zoom reset; your selected signals and alignment are preserved.');
  };

  const chooseWindow = (value: string) => {
    if (value === CUSTOM_WINDOW_VALUE) {
      setCustomWindowOpen(true);
      setCustomWindowError('');
      return;
    }
    setWindowMs(Number(value));
    setCustomWindow(null);
    setCustomWindowOpen(false);
    setCustomWindowError('');
  };

  const applyCustomWindow = () => {
    const error = customWindowValidation(customWindowAmount, customWindowUnit);
    if (error) {
      setCustomWindowError(error);
      customWindowInputRef.current?.focus();
      return;
    }
    const nextCustomWindow = { amount: Number(customWindowAmount), unit: customWindowUnit } satisfies CustomWindow;
    setWindowMs(customWindowMilliseconds(nextCustomWindow.amount, nextCustomWindow.unit));
    setCustomWindow(nextCustomWindow);
    setCustomWindowOpen(false);
    setCustomWindowError('');
    setNotice(`Showing the last ${formatCustomWindow(nextCustomWindow)} of retained data.`);
  };

  const windowOptions = [
    ...WINDOW_OPTIONS.map((option) => ({ value: String(option.value), label: option.label })),
    { value: CUSTOM_WINDOW_VALUE, label: customWindow ? `Custom · ${formatCustomWindow(customWindow)}` : 'Custom…' },
  ];
  const selectedWindowValue = customWindow ? CUSTOM_WINDOW_VALUE : String(windowMs);

  const exportData = async () => {
    if (!combined.selectedChartKeys.length || !combined.samples.length || querying) return;
    const abort = new AbortController(); exportAbort.current = abort;
    setExporting(true);
    let exportId: string | null = null;
    let exportedRows = 0;
    const format = exportFormat;
    const latestAligned = Date.parse(combined.samples[combined.samples.length - 1]?.timestamp ?? '');
    async function* rows(): AsyncGenerator<TelemetryExportRow> {
      for (const source of visibleSources) {
        const range = analysisSourceRange(source);
        const end = source.kind === 'recorded' ? replayTimeline.sourceEnds.get(source.id) ?? source.selection.end : Infinity;
        if (source.kind === 'recorded' && end < source.selection.start) continue;
        const iterator = source.kind === 'recorded' ? source.index.samples({ start: source.selection.start, end }, abort.signal) : source.snapshot.samples;
        for await (const sample of iterator) {
          abort.signal.throwIfAborted();
          const time = Date.parse(sample.timestamp);
          const aligned = alignment === 'elapsed' ? ANALYSIS_EPOCH_MS + Math.max(0, time - range.start) : time;
          if (windowMs > 0 && aligned < latestAligned - windowMs) continue;
          for (const [field, value] of Object.entries(sample.values)) {
            if (!selectedFieldSet.has(sourceFieldId(source.id, field))) continue;
            exportedRows += 1;
            yield { source: analysisSourceLabel(source), sourceType: source.kind, originalTimestamp: sample.timestamp,
              alignedTimestamp: new Date(aligned).toISOString(), elapsedMs: Math.max(0, time - range.start),
              field, value: value.value, unit: value.unit ?? '', timing: source.kind === 'live' ? 'live' : source.timingMode };
          }
        }
      }
    }
    try {
      const defaultName = `baudtide-comparison-${new Date().toISOString().slice(0, 10)}.${format}`;
      exportId = nativeEnabled ? await beginNativeTelemetryExport(format, defaultName) : null;
      if (nativeEnabled && !exportId) return;
      const browserParts: string[] = [];
      for await (const chunk of telemetryExportChunks(rows(), format, alignment)) {
        abort.signal.throwIfAborted();
        if (exportId) await appendNativeTelemetryExport(exportId, chunk); else browserParts.push(chunk);
      }
      abort.signal.throwIfAborted();
      const savedPath = exportId ? await finishNativeTelemetryExport(exportId) : (downloadInBrowser(browserParts.join(''), format), defaultName);
      exportId = null;
      setNotice(`Exported ${exportedRows.toLocaleString()} selected telemetry values to ${savedPath}.`);
    } catch (reason) {
      if (abort.signal.aborted) setNotice('Telemetry export cancelled.');
      else setLibraryError(reason instanceof Error ? reason.message : 'Could not export the selected telemetry.');
    } finally {
      if (exportId) await cancelNativeTelemetryExport(exportId).catch(() => undefined);
      exportAbort.current = null; setExporting(false);
    }
  };

  const hasRecordedSource = activeSources.some((source) => source.kind === 'recorded');
  const approximateSources = activeSources.filter((source): source is RecordedSource => source.kind === 'recorded' && source.timingMode === 'approximate');
  const replayTimingLabel = approximateSources.length
    ? activeSources.some((source) => source.kind === 'recorded' && source.timingMode === 'recorded') ? 'mixed timing' : 'approximate timing'
    : 'recorded receive timing';

  return <section ref={pageRef} className="bt-analysis" aria-labelledby="visualize-title">
    <header className="bt-analysis-header">
      <div><h1 id="visualize-title">Telemetry analysis</h1><span>Choose a terminal or capture to inspect its signals. Other terminals keep collecting data.</span></div>
      <div className="bt-analysis-add-source">
        <span>Add a saved capture</span>
        <div><ThemedSelect value={sourceChoice} options={sourceOptions} placeholder={sourceOptions.length ? 'Choose a capture' : 'No saved captures available'} label="Capture to add" disabled={!sourceOptions.length || Boolean(loadingPath) || restoringWorkspace} onChange={setSourceChoice} /><button className="sd-primary-button" type="button" disabled={!sourceChoice || Boolean(loadingPath) || restoringWorkspace} onClick={addChosenSource}>{loadingPath ? <LoaderCircle className="sd-spin" size={16} /> : <Plus size={16} />} Add capture</button></div>
        <small>Open terminals appear automatically in current analysis.</small>
      </div>
    </header>

    <section className="bt-analysis-presets" aria-label="Saved analysis workspaces">
      <span>Saved analysis</span>
      <ThemedSelect compact value={activeWorkspaceId || '__current'} label="Open saved analysis" placeholder="Saved analysis" options={[{ value: '__current', label: 'Current analysis' }, ...savedLibrary.workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))]} onChange={chooseAnalysisWorkspace} disabled={exporting || Boolean(loadingPath) || restoringWorkspace} />
      <button className="sd-secondary-button" type="button" disabled={!activeSources.length || exporting || querying || Boolean(loadingPath) || restoringWorkspace} onClick={() => { setSavingWorkspace((value) => !value); setWorkspaceName(''); }}><BookmarkPlus size={14} /> Save as…</button>
      {activeWorkspaceId ? <button className="sd-secondary-button" type="button" disabled={!activeSources.length || exporting || querying || Boolean(loadingPath) || restoringWorkspace} onClick={() => saveAnalysisWorkspace(true)}>Update saved analysis</button> : null}
      {savingWorkspace ? <form onSubmit={(event) => { event.preventDefault(); saveAnalysisWorkspace(); }}><label><span>Workspace name</span><input autoFocus maxLength={80} value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="e.g. Motor bench" /></label><button className="sd-primary-button" type="submit">Save analysis</button><button className="sd-secondary-button" type="button" onClick={() => setSavingWorkspace(false)}>Cancel</button></form> : null}
    </section>
    {pendingDevices.length || missingCaptures.length ? <div className="bt-analysis-message" role="status"><FolderOpen size={16} /><span>{pendingDevices.length ? `Waiting for saved devices: ${pendingDevices.join(', ')}. Connect the intended device from Live terminal; ambiguous matches stay unassigned. ` : ''}{missingCaptures.length ? `Unavailable captures: ${missingCaptures.join(', ')}.` : ''}</span></div> : null}

    {activeBreach ? <aside className="bt-analysis-breach-toast" role="alert" aria-label={`Watch breach for ${activeBreach.fieldKey}`}>
      <AlertTriangle size={18} aria-hidden="true" />
      <div><strong>Watch breach · {activeBreach.fieldKey}</strong><span>{activeBreach.sourceName} · {formatWatchEvent(activeBreach)}</span><time dateTime={activeBreach.timestamp}>Breach {activeBreach.occurrence} · {formatWatchTimestamp(activeBreach.timestamp)}</time></div>
      <button type="button" onClick={() => setActiveBreach(null)} aria-label="Dismiss breach alert" title="Dismiss breach alert"><X size={16} /></button>
    </aside> : null}

    <TelemetryDecoderPanel
      preferredSourceId={viewedSource?.id}
      busy={exporting || restoringWorkspace || Boolean(loadingPath)}
      sources={activeSources.map<TelemetryDecoderSource>((source) => ({
        id: source.id,
        name: analysisSourceLabel(source),
        detail: source.kind === 'live' && source.name !== source.detail ? `Terminal name: ${source.name}` : source.detail,
        kind: source.kind,
        receivedCompleteLineCount: source.snapshot.receivedCompleteLineCount,
        detectedFieldCount: source.snapshot.fields.length,
        appliedProfile: source.kind === 'live' ? source.snapshot.decoderProfile : source.decoderProfile,
      }))}
      onApply={applyDecoder}
      onProfileDeleted={removeDeletedDecoderProfile}
    />

    {libraryError ? <div className="bt-analysis-message is-error" role="alert"><AlertTriangle size={16} /><span>{libraryError}</span><button type="button" onClick={() => setLibraryError('')} aria-label="Dismiss error"><X size={15} /></button></div> : null}
    {loadingPath ? <div className="bt-analysis-message" role="status"><LoaderCircle className="sd-spin" size={16} /><span>Indexing complete capture · {Math.round(loadProgress * 100)}%</span><button type="button" onClick={() => { captureLoad.current?.abort(); restoreGeneration.current += 1; setRestoringWorkspace(false); restoreIntent.current = null; pendingSelections.current.clear(); setPendingDevices([]); setNotice('Capture load cancelled.'); }}>Cancel load</button></div> : null}
    {approximateSources.length ? <div className="bt-analysis-message is-warning" role="status"><AlertTriangle size={16} /><span>{approximateSources.map((source) => source.name).join(', ')} {approximateSources.length === 1 ? 'has' : 'have'} no complete receive timing. Replay uses approximate spacing; pauses and bursts may differ from the original session.</span></div> : null}

    {availableTerminals.length ? <section className="bt-analysis-available-terminals" aria-label="Available terminals">
      <span>Open terminals</span>
      {availableTerminals.map((source) => <button type="button" key={source.id} disabled={exporting || restoringWorkspace || Boolean(loadingPath)} onClick={() => {
        excludedLiveSources.current.delete(source.id);
        setActiveSourceIds((current) => current.includes(source.id) ? current : [...current, source.id]);
        setViewedSourceId(source.id);
      }} aria-label={`Add ${source.name} on ${source.detail} to comparison`}><Plus size={14} /><strong>{source.name}</strong><code>{source.detail}</code></button>)}
    </section> : null}

    <div className="bt-analysis-source-ruler" aria-label="Analysis sources">
      <div className="bt-analysis-ruler-label">
        <span>Alignment</span>
        <div className="bt-analysis-alignment-options" role="group" aria-label="Timeline alignment">
          <button type="button" aria-pressed={alignment === 'elapsed'} onClick={() => setAlignment('elapsed')}>Align starts</button>
          <button type="button" aria-pressed={alignment === 'clock'} onClick={() => setAlignment('clock')}>Clock time</button>
        </div>
      </div>
      <div className="bt-analysis-source-track" role="tablist" aria-label="Source to visualize">
        {activeSources.length ? activeSources.map((source) => {
          const range = analysisSourceRange(source);
          const state = source.kind === 'live' ? source.session.connectionState : 'recorded';
          const selectedCount = displayFields.filter((field) => field.sourceId === source.id && selectedFieldSet.has(field.id)).length;
          const isViewed = source.id === viewedSource?.id;
          return <article className={`bt-analysis-source is-${source.kind}${isViewed ? ' is-viewed' : ''}`} key={source.id}>
            <button type="button" className="bt-analysis-source-select" role="tab" id={`source-tab-${source.id}`} aria-selected={isViewed} aria-controls="visualized-source-panel" tabIndex={isViewed ? 0 : -1} onClick={() => chooseViewedSource(source)} onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const index = activeSources.findIndex((candidate) => candidate.id === source.id);
              const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? activeSources.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + activeSources.length) % activeSources.length;
              const next = activeSources[nextIndex]; chooseViewedSource(next);
              document.getElementById(`source-tab-${next.id}`)?.focus({ preventScroll: true });
            }}>
            <span className="bt-analysis-source-info">
              <span className="bt-analysis-source-heading"><strong title={source.kind === 'live' ? `Terminal: ${source.name} · ${source.session.port}` : source.name}>{analysisSourceLabel(source)}</strong><em className={`is-${state}`}>{source.kind === 'recorded' ? 'Capture' : state === 'connected' ? 'Live' : state === 'reconnecting' ? 'Reconnecting' : state === 'error' ? 'Error' : 'Disconnected'}</em></span>
              <small className={isViewed ? 'has-selected-signals' : ''}>{isViewed ? selectedCount ? `Showing ${selectedCount} signal${selectedCount === 1 ? '' : 's'}` : source.snapshot.fields.length ? 'Choose signals below' : 'Waiting for numeric data' : source.kind === 'live' ? state === 'connected' ? 'Collecting in background' : 'Not receiving data' : 'Ready to view'}</small>
              {source.kind === 'recorded' ? <small title={source.detail}>{formatDuration(range.duration)} · {source.timingMode === 'recorded' ? 'Recorded timing' : 'Approximate timing'}</small> : null}
            </span>
            </button>
            <button className="bt-analysis-source-remove" type="button" onClick={() => removeSource(source)} disabled={exporting || restoringWorkspace || Boolean(loadingPath)} aria-label={`Remove ${analysisSourceLabel(source)} from comparison`}><X size={14} /></button>
          </article>;
        }) : <div className="bt-analysis-source-empty"><FolderOpen size={18} /><span>Add a live session or saved capture to begin.</span></div>}
      </div>
    </div>

    {rangedCapture ? <section className="bt-analysis-capture-range" aria-label="Capture time range">
      <div><strong>Capture range</strong><span>{formatDuration(rangedCapture.selection.start - rangedCapture.index.range.start)}–{formatDuration(rangedCapture.selection.end - rangedCapture.index.range.start)} of {formatDuration(rangedCapture.index.range.end - rangedCapture.index.range.start)} · {rangedCapture.snapshot.acceptedSampleCount.toLocaleString()} readings</span></div>
      <ThemedSelect compact value={rangedCapture.id} label="Capture to inspect" placeholder="Choose capture" options={Object.values(recordedSources).map((source) => ({ value: source.id, label: source.name }))} onChange={setRangeSourceId} />
      <button className="sd-secondary-button" type="button" aria-expanded={rangeEditorOpen} aria-controls="capture-range-editor" onClick={() => setRangeEditorOpen((current) => !current)}>{rangeEditorOpen ? 'Hide range editor' : 'Edit range'}</button>
      {rangeEditorOpen && <form id="capture-range-editor" onSubmit={(event) => { event.preventDefault(); applyCaptureRange(); }}>
        <label><span>From (seconds)</span><input aria-label="Capture range start" type="number" min="0" step="any" value={rangeStart} onChange={(event) => { setRangeStart(event.target.value); setRangeError(''); }} /></label>
        <label><span>To (seconds)</span><input aria-label="Capture range end" type="number" min="0" step="any" value={rangeEnd} onChange={(event) => { setRangeEnd(event.target.value); setRangeError(''); }} /></label>
        <button className="sd-primary-button" type="submit" disabled={querying || exporting || Boolean(loadingPath)}>{querying ? <LoaderCircle className="sd-spin" size={14} /> : null} Apply range</button>
        <button className="sd-secondary-button" type="button" disabled={querying || exporting || Boolean(loadingPath)} onClick={() => applyCaptureRange(true)}>Full capture</button>
      </form>}
      {rangeError && rangeEditorOpen ? <p role="alert">{rangeError}</p> : null}
    </section> : null}

    <div className="bt-analysis-workbench" role="tabpanel" id="visualized-source-panel" aria-labelledby={viewedSource ? `source-tab-${viewedSource.id}` : undefined}>
      <aside className="bt-analysis-fields" aria-label="Signals by source">
        <header><div><h2>Signals</h2><span>Select up to {MAX_SELECTED_FIELDS} to compare</span></div><strong aria-label={`${visibleSelectedFields.length} of ${MAX_SELECTED_FIELDS} signals selected`}>{visibleSelectedFields.length}<span> / {MAX_SELECTED_FIELDS}</span></strong></header>
        {visibleFields.length > 0 && <div className="bt-analysis-signal-tools"><label><Search size={14} aria-hidden="true" /><input type="search" value={fieldQuery} onChange={(event) => setFieldQuery(event.target.value)} placeholder="Find a signal" aria-label="Find a signal" /></label><button type="button" disabled={!visibleSelectedFields.length} onClick={() => { setFieldsConfigured(true); if (viewedSource) { configuredSources.current.add(viewedSource.id); pendingSelections.current.delete(viewedSource.id); } setSelectedFields((current) => { const next = current.filter((id) => !visibleFields.some((field) => field.id === id)); rememberSignalSelection(next, viewedSource?.id); return next; }); }} aria-label="Clear selected signals">Clear</button></div>}
        <div className="bt-analysis-field-scroll">
          {visibleSources.map((source) => {
            const allFields = displayFields.filter((field) => field.sourceId === source.id);
            const query = fieldQuery.trim().toLowerCase();
            const fields = allFields.filter((field) => !query || `${field.sourceName} ${source.name} ${field.field.key} ${field.field.unit ?? ''}`.toLowerCase().includes(query));
            if (query && !fields.length) return null;
            return <section className="bt-analysis-field-group" key={source.id}>
              <header><span title={source.name}>{analysisSourceLabel(source)}</span><small>{source.kind === 'live' ? 'Live' : 'Recorded'} · {allFields.filter((field) => selectedFieldSet.has(field.id)).length} / {allFields.length} signals selected{allFields.length ? ` · ${[...new Set(allFields.flatMap((field) => field.field.formats))].join(' / ').toUpperCase()}` : ''}</small></header>
              {fields.length ? fields.map((field) => <FieldControl key={field.id} field={field} checked={selectedFieldSet.has(field.id)} disabled={!selectedFieldSet.has(field.id) && visibleSelectedFields.length >= MAX_SELECTED_FIELDS} onToggle={() => toggleField(field)} />) : <p>No repeatable numeric fields detected.</p>}
            </section>;
          })}
          {fieldQuery.trim() && !visibleFields.some((field) => `${field.sourceName} ${sourcesById.get(field.sourceId)?.name ?? ''} ${field.field.key} ${field.field.unit ?? ''}`.toLowerCase().includes(fieldQuery.trim().toLowerCase())) && <p className="bt-analysis-no-matches">No matching signals. Try a signal name or terminal port.</p>}
          {!activeSources.length ? <div className="bt-analysis-fields-empty"><Radio size={20} /><strong>No analysis sources</strong><span>Add a connected device or a saved capture above.</span>{!sessions.length ? <button className="sd-secondary-button" type="button" onClick={onRequestConnection}>Connect a device</button> : null}</div> : null}
        </div>
      </aside>

      <main className="bt-analysis-canvas">
        <header className="bt-analysis-toolbar">
          <div><h2>{viewedSource?.kind === 'recorded' ? 'Recorded signals' : displayPaused ? 'Paused live traces' : 'Live traces'}</h2><span>{combined.selectedChartKeys.length ? `Plotting ${visibleSources.map(analysisSourceLabel).join('')} · ${combined.selectedChartKeys.length} signals` : 'Select signals from the rail'}</span></div>
          <div className="bt-analysis-actions">
            <div className="bt-analysis-compact-select"><span>View</span><ThemedSelect compact value={chartMode} options={[{ value: 'compare', label: 'Overlay' }, { value: 'lanes', label: 'Separate' }]} placeholder="Overlay" label="Chart presentation" onChange={(value) => setChartMode(value as ChartMode)} /></div>
            <div className="bt-analysis-compact-select"><span>Window</span><ThemedSelect compact value={selectedWindowValue} options={windowOptions} placeholder="All data" label="Chart time window" onChange={chooseWindow} /></div>
            {watchableFields.length || watchRules.length || historyCount || historyError || historyWriteError ? <button className={`bt-visualize-control bt-analysis-watch-toggle ${watchOpen ? 'is-active' : ''} ${currentBreachCount ? 'has-breach' : ''}`} type="button" onClick={() => setWatchOpen((current) => !current)} aria-expanded={watchOpen} aria-controls="signal-watch-panel"><BellRing size={15} />{watchRules.length ? `Watches · ${watchRules.length}` : 'Watch signals'}</button> : null}
            {liveSources.length ? <button className={`bt-visualize-control ${displayPaused ? 'is-active' : ''}`} type="button" onClick={toggleDisplayPause}>{displayPaused ? <CirclePlay size={15} /> : <CirclePause size={15} />}{displayPaused ? 'Resume live' : 'Pause live'}</button> : null}
            <button className="bt-visualize-control" type="button" onClick={resetView}><RotateCcw size={15} /> Reset view</button>
          </div>
        </header>

        {customWindowOpen ? <section className="bt-analysis-custom-window" aria-labelledby="custom-window-heading">
          <form onSubmit={(event) => { event.preventDefault(); applyCustomWindow(); }}>
            <div className="bt-analysis-custom-window-intro"><h3 id="custom-window-heading">Custom time window</h3><p>Show only the newest portion of the retained telemetry.</p></div>
            <label className="bt-analysis-custom-window-field" htmlFor="custom-window-duration"><span>Duration</span><input ref={customWindowInputRef} id="custom-window-duration" inputMode="decimal" type="number" min="0" step="any" value={customWindowAmount} onChange={(event) => { setCustomWindowAmount(event.target.value); setCustomWindowError(''); }} onBlur={() => setCustomWindowError(customWindowValidation(customWindowAmount, customWindowUnit))} aria-invalid={customWindowError ? true : undefined} aria-describedby={customWindowError ? 'custom-window-error' : undefined} /></label>
            <div className="bt-analysis-custom-window-field"><span>Unit</span><ThemedSelect value={customWindowUnit} options={CUSTOM_WINDOW_UNITS.map((unit) => ({ value: unit.value, label: unit.label }))} placeholder="Minutes" label="Custom time window unit" onChange={(value) => { setCustomWindowUnit(value as CustomWindowUnit); setCustomWindowError(''); }} /></div>
            <div className="bt-analysis-custom-window-actions"><button className="sd-primary-button" type="submit">Apply window</button><button className="sd-secondary-button" type="button" onClick={() => { setCustomWindowOpen(false); setCustomWindowError(''); }}>Cancel</button></div>
          </form>
          {customWindowError ? <p className="bt-analysis-custom-window-error" id="custom-window-error" role="alert">{customWindowError}</p> : null}
        </section> : null}

        {watchOpen ? <section className="bt-analysis-watch" id="signal-watch-panel" aria-labelledby="signal-watch-heading">
          <div className="bt-analysis-watch-setup">
            <header><div><h3 id="signal-watch-heading">Signal watch</h3><p>Alert when a live value crosses its boundary. Armed watches keep running while you use other pages. Set a recovery margin or sustained duration to filter boundary chatter. History stays on this computer across restarts.</p></div><span>{watchRules.length ? `${watchRules.length} armed` : 'No watches armed'}</span></header>
            <div className="bt-analysis-watch-form">
              <div className="bt-analysis-watch-field"><span>Live signal</span><ThemedSelect value={watchFieldId} options={watchableFields.map((field) => ({ value: field.id, label: `${field.sourceName} · ${field.field.key}${field.latest?.unit ?? field.field.unit ? ` (${field.latest?.unit ?? field.field.unit})` : ''}` }))} placeholder="Choose a signal" label="Live signal to watch" onChange={(value) => { setWatchFieldId(value); setWatchFormError(''); }} /></div>
              <div className="bt-analysis-watch-field bt-analysis-watch-condition"><span>Boundary</span><ThemedSelect value={watchCondition} options={[{ value: 'above', label: 'Above limit' }, { value: 'below', label: 'Below limit' }, { value: 'outsideRange', label: 'Outside range' }]} placeholder="Above limit" label="Watch boundary" onChange={(value) => { setWatchCondition(value as TelemetryAlertCondition); setWatchFormError(''); }} /></div>
              {watchCondition === 'outsideRange' ? <div className="bt-analysis-watch-range"><label className="bt-analysis-watch-field"><span>Lower value</span><input inputMode="decimal" type="number" value={watchMinimum} onChange={(event) => { setWatchMinimum(event.target.value); setWatchFormError(''); }} aria-invalid={watchFormError ? true : undefined} /></label><label className="bt-analysis-watch-field"><span>Upper value</span><input inputMode="decimal" type="number" value={watchMaximum} onChange={(event) => { setWatchMaximum(event.target.value); setWatchFormError(''); }} aria-invalid={watchFormError ? true : undefined} /></label></div> : <label className="bt-analysis-watch-field bt-analysis-watch-limit"><span>Limit</span><input inputMode="decimal" type="number" value={watchThreshold} onChange={(event) => { setWatchThreshold(event.target.value); setWatchFormError(''); }} aria-invalid={watchFormError ? true : undefined} /></label>}
              <button className="sd-primary-button bt-analysis-add-watch" type="button" onClick={addWatch} disabled={!watchFieldId}><BellRing size={15} /> Add watch</button>
            </div>
            <details className="bt-analysis-watch-options"><summary>Timing and recovery</summary><div>
              <label className="bt-analysis-watch-field"><span>Sustained breach (seconds)</span><input aria-label="Sustained breach in seconds" type="number" min="0" max="86400" step="0.001" value={watchSustain} onChange={(event) => { setWatchSustain(event.target.value); setWatchFormError(''); }} /><small>0 alerts immediately; longer durations need continuing readings.</small></label>
              <label className="bt-analysis-watch-field"><span>Recovery margin (signal unit)</span><input aria-label="Watch recovery margin" type="number" min="0" step="any" value={watchHysteresis} onChange={(event) => { setWatchHysteresis(event.target.value); setWatchFormError(''); }} /><small>Move this far back inside the boundary before re-arming.</small></label>
              <label className="bt-analysis-watch-field"><span>Stale after (seconds)</span><input aria-label="Watch stale timeout in seconds" type="number" min="1" max="86400" step="0.001" value={watchStale} onChange={(event) => { setWatchStale(event.target.value); setWatchFormError(''); }} /><small>Default: 10 seconds without a matching reading.</small></label>
            </div></details>
            {watchFormError ? <p className="bt-analysis-watch-error" role="alert">{watchFormError}</p> : null}
          </div>
          <div className="bt-analysis-watch-ledger">
            <section aria-label="Armed signal watches"><header><h3>Armed watches</h3><span>{currentBreachCount ? `${currentBreachCount} breached` : waitingWatchCount ? `${waitingWatchCount} waiting, pending, or stale` : watchRules.length ? 'Monitoring' : 'Waiting for setup'}</span></header>
              {watchRules.length ? <div className="bt-analysis-watch-rule-list">{watchRules.map((rule) => {
                const breachCount = watchBreachCounts[rule.id] ?? 0;
                return <div className={`bt-analysis-watch-rule ${watchStatus(rule) === 'BREACH' ? 'is-breached' : ''}`} key={rule.id}><BellRing size={14} aria-hidden="true" /><span><strong>{formatWatchRule(rule)}</strong><small>{liveSourceNames.get(rule.sessionKey) ?? 'Source removed'} · after {(rule.sustainMs ?? 0) / 1000}s · recovery {rule.hysteresis ?? 0} · stale {(rule.staleAfterMs ?? 10_000) / 1000}s · {breachCount ? `${breachCount} breach${breachCount === 1 ? '' : 'es'} logged` : 'No breaches logged'}</small></span><em>{watchStatus(rule)}</em><button type="button" onClick={() => removeWatch(rule)} aria-label={`Remove watch for ${rule.fieldKey}`} title={`Remove watch for ${rule.fieldKey}`}><Trash2 size={14} /></button></div>;
              })}</div> : <p className="bt-analysis-watch-empty">Choose a live signal and set one clear boundary.</p>}
            </section>
            <section className="bt-analysis-watch-events" aria-label="Breach history"><header><h3>Breach history</h3><span>{historyLoading ? 'Opening saved history…' : `${watchEvents.length} shown · ${historyCount.toLocaleString()} saved · ${watchBreachTotal} this run`}</span></header>
              <div className="bt-analysis-history-actions"><ThemedSelect compact menuPlacement="top" value={exportFormat} options={[{ value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON' }]} placeholder="CSV" label="Breach history export format" onChange={(value) => setExportFormat(value as ExportFormat)} /><button type="button" className="sd-secondary-button" disabled={historyLoading || historyExporting || !historyCount} onClick={() => void exportWatchHistory()}><Download size={14} /> {historyExporting ? 'Exporting…' : 'Export saved history'}</button>{historyExporting && <button type="button" className="sd-secondary-button" onClick={() => historyExportAbort.current?.abort()}>Cancel history export</button>}</div>
              {historyWriteError && <p className="bt-analysis-watch-error" role="alert">{historyWriteError} Some breaches from this run are only in the displayed history.</p>}
              {historyError && <p className="bt-analysis-watch-error" role="alert">{historyError} <button type="button" className="sd-secondary-button" disabled={historyLoading} onClick={() => void refreshWatchHistory()}>Retry history</button></p>}
              {watchEvents.length ? <div>{watchEvents.map((event) => <article key={event.id}><AlertTriangle size={14} aria-hidden="true" /><span><strong>{event.sourceName} · {event.fieldKey}</strong><small>{formatWatchEvent(event)} · Breach {event.occurrence}</small><time dateTime={event.timestamp}>{formatWatchTimestamp(event.timestamp)}</time></span></article>)}</div> : <p className="bt-analysis-watch-empty">Every future re-armed breach will be recorded here.</p>}
            </section>
          </div>
        </section> : null}

        {hasRecordedSource ? <section className="bt-analysis-replay" aria-label="Capture replay controls">
          <button type="button" className="bt-analysis-replay-button" disabled={!recordedDuration || querying || exporting || Boolean(loadingPath)} onClick={() => {
            if (replayProgress >= 1) setReplayProgress(0);
            setReplayPlaying((current) => !current);
          }}>{replayPlaying ? <CirclePause size={16} /> : <CirclePlay size={16} />}<span>{replayPlaying ? 'Pause replay' : 'Replay captures'}</span></button>
          <div className="bt-analysis-scrubber"><input type="range" min="0" max="1000" value={Math.round(replayProgress * 1000)} aria-label="Replay position" aria-valuetext={`${formatDuration(recordedDuration * replayProgress)} of ${formatDuration(recordedDuration)}`} onChange={(event) => { setReplayPlaying(false); setReplayProgress(Number(event.target.value) / 1000); }} /><div><span>Start</span><strong>{formatDuration(recordedDuration * replayProgress)} / {formatDuration(recordedDuration)} · {replayTimingLabel}</strong><span>End</span></div></div>
          <div className="bt-analysis-rate"><span>Rate</span><ThemedSelect compact value={String(replayRate)} options={[1, 2, 4, 16].map((rate) => ({ value: String(rate), label: `${rate}×` }))} placeholder="1×" label="Replay rate" onChange={(value) => setReplayRate(Number(value))} /></div>
        </section> : null}

        <TelemetryCharts visible={displayVisible} key={chartResetRevision} samples={combined.samples} fields={combined.fields} gaps={combined.gaps} selectedFieldKeys={combined.selectedChartKeys} windowMs={windowMs} paused={displayPaused || replayPlaying} mode={chartMode} timeline={chartTimeline} />

        <footer className="bt-analysis-footer">
          <div><span><strong>{visibleSources.length}</strong> viewed source{visibleSources.length === 1 ? '' : 's'}</span><span><strong>{combined.samples.length.toLocaleString()}</strong> overview records</span><span><strong>{combined.selectedChartKeys.length}</strong> selected</span></div>
          <div className="bt-analysis-export"><ThemedSelect compact menuPlacement="top" value={exportFormat} options={[{ value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON' }]} placeholder="CSV" label="Export format" onChange={(value) => setExportFormat(value as ExportFormat)} /><button className="sd-primary-button" type="button" disabled={exporting || querying || Boolean(loadingPath) || !combined.selectedChartKeys.length || !combined.samples.length} onClick={() => void exportData()}>{exporting ? <LoaderCircle className="sd-spin" size={15} /> : <Download size={15} />} Export selected</button>{exporting ? <button className="sd-secondary-button" type="button" onClick={() => exportAbort.current?.abort()}>Cancel export</button> : null}</div>
        </footer>
      </main>
    </div>
    <p className="bt-visualize-notice" role="status" aria-live="polite">{notice}</p>
  </section>;
}
