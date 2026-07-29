import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Clock3, Copy, FileText, FolderOpen, HardDrive, LoaderCircle, Radio, RefreshCw, Save, Search, Trash2, X } from 'lucide-react';
import { cancelNativeSavedLogSearch, deleteNativeSavedLog, listNativeSavedLogs, readNativeSavedLog, saveNativeSavedLog, searchNativeSavedLogs, type SavedLog, type SavedLogContent, type SavedLogSearchResponse } from '../lib/serial';
import './saved-logs.css';

type SavedLogsScreenProps = {
  nativeEnabled: boolean;
  activeLogPath?: string;
  onRequestConnection: () => void;
};

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatCapturedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

async function copyText(value: string) {
  if (!navigator.clipboard) throw new Error('Clipboard access is unavailable.');
  await navigator.clipboard.writeText(value);
}

export function SavedLogsScreen({ nativeEnabled, activeLogPath, onRequestConnection }: SavedLogsScreenProps) {
  const [logs, setLogs] = useState<SavedLog[]>([]);
  const [query, setQuery] = useState('');
  const [fullSearch, setFullSearch] = useState(false);
  const [searchResponse, setSearchResponse] = useState<{ query: string; response: SavedLogSearchResponse } | null>(null);
  const [isSearching, setSearching] = useState(false);
  const [isLoading, setLoading] = useState(nativeEnabled);
  const [isRefreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<(SavedLog & SavedLogContent) | null>(null);
  const [openingPaths, setOpeningPaths] = useState<Set<string>>(() => new Set());
  const [savingPaths, setSavingPaths] = useState<Set<string>>(() => new Set());
  const [pendingDeletion, setPendingDeletion] = useState<SavedLog | null>(null);
  const [isDeleting, setDeleting] = useState<string | null>(null);
  const [deletionError, setDeletionError] = useState('');
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const fullSearchSequence = useRef(0);
  const activeFullSearch = useRef<{ id: string; cancel: () => void } | null>(null);
  const deletedLogPaths = useRef(new Set<string>());
  const deleteInFlight = useRef<string | null>(null);
  const openingInFlight = useRef(new Set<string>());
  const savingInFlight = useRef(new Set<string>());
  const previewSequence = useRef(0);
  const deleteDialog = useRef<HTMLElement | null>(null);
  const deleteCancelButton = useRef<HTMLButtonElement | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const refreshButton = useRef<HTMLButtonElement | null>(null);

  const refresh = async (showSpinner = true) => {
    if (!nativeEnabled) return;
    if (showSpinner) setRefreshing(true);
    try {
      const nextLogs = await listNativeSavedLogs();
      setLogs(nextLogs.filter((log) => !deletedLogPaths.current.has(log.path)));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load saved logs.');
    } finally {
      setLoading(false);
      if (showSpinner) setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!nativeEnabled) {
      setLoading(false);
      return undefined;
    }
    void refresh(false);
    const timer = activeLogPath ? window.setInterval(() => void refresh(false), 2_000) : undefined;
    return () => { if (timer) window.clearInterval(timer); };
    // The active file path intentionally restarts the lightweight refresh only when capture changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLogPath, nativeEnabled]);

  useEffect(() => {
    const normalized = query.trim();
    if (!nativeEnabled || !normalized) {
      setSearchResponse(null);
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    let settled = false;
    let timer: number | undefined;
    const searchId = fullSearch ? `full-search-${Date.now()}-${++fullSearchSequence.current}` : undefined;
    const cancel = () => {
      if (cancelled || settled) return;
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (searchId) void cancelNativeSavedLogSearch(searchId).catch(() => undefined);
    };
    if (searchId) activeFullSearch.current = { id: searchId, cancel };
    // A response describes exactly one query. Drop the prior response before
    // debouncing so its results cannot be rendered under the new query, even
    // if the new native search subsequently fails.
    setSearchResponse(null);
    setSearching(true);
    timer = window.setTimeout(() => {
      void searchNativeSavedLogs(normalized, fullSearch, searchId)
        .then((response) => {
          if (!cancelled) {
            setSearchResponse({
              query: normalized,
              response: {
                ...response,
                results: response.results.filter((result) => !deletedLogPaths.current.has(result.log.path)),
              },
            });
            setError('');
          }
        })
        .catch((reason) => {
          if (!cancelled) {
            setSearchResponse(null);
            setError(reason instanceof Error ? reason.message : 'Could not search saved logs.');
          }
        })
        .finally(() => {
          settled = true;
          if (!cancelled) setSearching(false);
        });
    }, 220);
    return () => {
      cancel();
      if (activeFullSearch.current?.id === searchId) activeFullSearch.current = null;
    };
  }, [fullSearch, libraryRevision, nativeEnabled, query]);

  const cancelCompleteSearch = () => {
    const activeSearch = activeFullSearch.current;
    if (!activeSearch) return;
    activeSearch.cancel();
    activeFullSearch.current = null;
    setSearchResponse(null);
    setSearching(false);
  };

  const activeSearchResponse = searchResponse?.query === query.trim() ? searchResponse.response : null;
  const filteredLogs = useMemo(() => {
    if (!query.trim()) return logs.filter((log) => !deletedLogPaths.current.has(log.path));
    return activeSearchResponse?.results
      .map((result) => result.log)
      .filter((log) => !deletedLogPaths.current.has(log.path)) ?? [];
  }, [activeSearchResponse, logs, query]);
  const searchResultsByPath = useMemo(() => new Map(activeSearchResponse?.results.map((result) => [result.log.path, result]) ?? []), [activeSearchResponse]);
  const activeCount = logs.filter((log) => log.state === 'capturing').length;

  const isActiveCapture = (log: SavedLog) =>
    log.state === 'capturing' || Boolean(activeLogPath && activeLogPath === log.path);

  const openLog = async (log: SavedLog) => {
    if (deletedLogPaths.current.has(log.path) || openingInFlight.current.has(log.path)) return;
    openingInFlight.current.add(log.path);
    setOpeningPaths((current) => new Set(current).add(log.path));
    const requestSequence = ++previewSequence.current;
    try {
      const content = await readNativeSavedLog(log.path);
      if (requestSequence === previewSequence.current && !deletedLogPaths.current.has(log.path)) {
        setSelected({ ...log, ...content });
        setError('');
      }
    } catch (reason) {
      if (requestSequence === previewSequence.current && !deletedLogPaths.current.has(log.path)) {
        setError(reason instanceof Error ? reason.message : 'Could not open that saved log.');
      }
    } finally {
      openingInFlight.current.delete(log.path);
      setOpeningPaths((current) => {
        const next = new Set(current);
        next.delete(log.path);
        return next;
      });
    }
  };

  const copy = async (value: string, message: string) => {
    try {
      await copyText(value);
      setNotice(message);
      window.setTimeout(() => setNotice(''), 2_400);
    } catch {
      setError('Your system did not allow BaudTide to copy to the clipboard.');
    }
  };

  const saveCopy = async (log: SavedLog) => {
    if (deletedLogPaths.current.has(log.path) || savingInFlight.current.has(log.path)) return;
    savingInFlight.current.add(log.path);
    setSavingPaths((current) => new Set(current).add(log.path));
    try {
      const savedPath = await saveNativeSavedLog(log.path);
      if (!savedPath) return;
      setNotice(`Saved a copy to ${savedPath}.`);
      window.setTimeout(() => setNotice(''), 3_600);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save a copy of that log.');
    } finally {
      savingInFlight.current.delete(log.path);
      setSavingPaths((current) => {
        const next = new Set(current);
        next.delete(log.path);
        return next;
      });
    }
  };

  const requestDeletion = (log: SavedLog, trigger: HTMLButtonElement) => {
    if (isActiveCapture(log)) {
      setError('This capture is still recording. Disconnect its serial session before deleting it.');
      return;
    }
    if (openingInFlight.current.has(log.path) || savingInFlight.current.has(log.path)) {
      setError('Wait for the current preview or save operation to finish before deleting this log.');
      return;
    }
    deleteTrigger.current = trigger;
    setDeletionError('');
    setPendingDeletion(log);
  };

  const deleteLog = async (log: SavedLog) => {
    if (deleteInFlight.current) return;
    const latestLog = logs.find((candidate) => candidate.path === log.path) ?? log;
    if (isActiveCapture(latestLog)) {
      const message = 'This capture is still recording. Disconnect its serial session before deleting it.';
      setDeletionError(message);
      setError(message);
      void refresh(false);
      return;
    }
    deleteInFlight.current = log.path;
    setDeleting(log.path);
    setDeletionError('');
    try {
      await deleteNativeSavedLog(log.path);
      deletedLogPaths.current.add(log.path);
      previewSequence.current += 1;
      setLogs((current) => current.filter((candidate) => candidate.path !== log.path));
      setSearchResponse((current) => current && {
        ...current,
        response: { ...current.response, results: current.response.results.filter((result) => result.log.path !== log.path) },
      });
      setSelected((current) => current?.path === log.path ? null : current);
      setPendingDeletion(null);
      setLibraryRevision((current) => current + 1);
      setNotice(`Deleted ${log.fileName}.`);
      window.setTimeout(() => setNotice(''), 2_400);
      setError('');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not delete that saved log.';
      setDeletionError(message);
      setError(message);
      void refresh(false);
    } finally {
      deleteInFlight.current = null;
      setDeleting(null);
    }
  };

  const pendingDeletionIsActive = pendingDeletion
    ? isActiveCapture(logs.find((log) => log.path === pendingDeletion.path) ?? pendingDeletion)
    : false;

  useEffect(() => {
    if (!pendingDeletion) return undefined;
    const trigger = deleteTrigger.current;
    const focusTimer = window.setTimeout(() => deleteCancelButton.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleteInFlight.current) {
        event.preventDefault();
        setPendingDeletion(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        deleteDialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [],
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!deleteDialog.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      if (trigger?.isConnected) trigger.focus();
      else refreshButton.current?.focus();
    };
  }, [pendingDeletion]);

  if (!nativeEnabled) {
    return <section className="sd-empty-workspace"><div className="sd-empty-workspace-icon"><FileText size={28} /></div><p>SAVED LOGS</p><h1>Open BaudTide desktop to browse captures.</h1><span>Saved logs live on the local machine and are available in the desktop app, where the serial backend can access them.</span></section>;
  }

  return <section className="sd-saved-logs" aria-label="Saved serial logs">
    <header className="sd-saved-logs-header">
      <div><p className="sd-saved-logs-eyebrow">LOCAL CAPTURE LIBRARY</p><h1>Saved logs</h1><p>Every live terminal is written as a raw local file from the moment monitoring begins.</p></div>
      <button ref={refreshButton} className="sd-secondary-button" type="button" onClick={() => void refresh()} disabled={isRefreshing}><RefreshCw className={isRefreshing ? 'sd-spin' : ''} size={16} /> Refresh</button>
    </header>

    {error && <div className="sd-saved-logs-alert" role="alert"><AlertTriangle size={16} /> {error}</div>}

    {activeCount > 0 && <section className="sd-active-capture-summary"><span><Radio size={17} /></span><div><strong>{activeCount === 1 ? '1 capture is active' : `${activeCount} captures are active`}</strong><p>Its raw log is already listed below and grows while monitoring continues.</p></div><button type="button" onClick={() => void refresh(false)}>Update size</button></section>}

    <section className="sd-saved-logs-toolbar">
      <label className="sd-saved-logs-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search metadata and captured content" /></label>
      <label className="sd-saved-logs-search-scope"><input type="checkbox" checked={fullSearch} onChange={(event) => setFullSearch(event.target.checked)} /> Search complete captures</label>
      {isSearching && fullSearch && <button className="sd-secondary-button" type="button" onClick={cancelCompleteSearch}>Cancel search</button>}
      <span>{isSearching ? 'Searching…' : `${filteredLogs.length} ${filteredLogs.length === 1 ? 'log' : 'logs'}`}</span>
    </section>

    {activeSearchResponse && <p className="sd-saved-logs-search-note">{activeSearchResponse.fullSearch
      ? `Complete-capture search scanned ${formatBytes(activeSearchResponse.scannedBytes)} across ${activeSearchResponse.scannedLogCount} logs. Large libraries can take longer.`
      : `Quick search streams up to ${formatBytes(activeSearchResponse.perLogByteLimit ?? 0)} per log and ${formatBytes(activeSearchResponse.totalByteLimit ?? 0)} total. Turn on “Search complete captures” for an exact full-library scan.`} {activeSearchResponse.truncated ? 'Some log bytes were not scanned within the quick-search limit.' : ''}{activeSearchResponse.resultLimitReached ? ` The first ${activeSearchResponse.resultLimit} matching logs are shown.` : ''}</p>}

    {isLoading || (isSearching && !activeSearchResponse) ? <div className="sd-saved-logs-loading"><LoaderCircle className="sd-spin" size={21} /> {isLoading ? 'Loading local captures…' : 'Searching local captures…'}</div>
      : filteredLogs.length ? <div className="sd-saved-log-list" role="list">
        {filteredLogs.map((log) => {
          const searchResult = searchResultsByPath.get(log.path);
          const firstContentMatch = searchResult?.contentMatches[0];
          const isOpening = openingPaths.has(log.path);
          const isSaving = savingPaths.has(log.path);
          const isActive = isActiveCapture(log);
          const isBusy = isOpening || isSaving || isDeleting === log.path;
          return <article className="sd-saved-log-row" role="listitem" key={log.path}>
          <div className={`sd-saved-log-icon ${log.state}`}><FileText size={20} /></div>
           <div className="sd-saved-log-primary"><div className="sd-saved-log-name"><strong>{log.sessionName}</strong>{log.state === 'capturing' && <span><i /> Capturing now</span>}{log.state === 'error' && <span className="is-error">Ended with error</span>}{log.state === 'quota-reached' && <span className="is-error">Stopped at storage limit</span>}{log.state === 'interrupted' && <span className="is-muted">Capture interrupted</span>}</div><p>{log.port ? `${log.port} · ${log.baudRate?.toLocaleString()} baud` : log.metadataAvailable ? 'Connection metadata unavailable' : 'Legacy capture · metadata unavailable'}</p><small>{log.fileName}</small>{firstContentMatch?.snippet && <mark className="sd-saved-log-match">{firstContentMatch.snippet}</mark>}{searchResult && searchResult.contentMatchCount > 1 && <small className="sd-saved-log-match-count">{searchResult.contentMatchCount} content matches in searched bytes</small>}</div>
          <div className="sd-saved-log-meta"><span><Clock3 size={14} /> {formatCapturedAt(log.startedAt ?? log.modifiedAt)}</span><span><HardDrive size={14} /> {formatBytes(log.sizeBytes)}</span>{log.endedAt && <span>Ended {formatCapturedAt(log.endedAt)}</span>}</div>
          <div className="sd-saved-log-actions"><button className="sd-secondary-button" type="button" onClick={() => void openLog(log)} disabled={isOpening || isDeleting === log.path}>{isOpening ? <LoaderCircle className="sd-spin" size={15} /> : <FileText size={15} />} Preview</button><button className="sd-secondary-button" type="button" onClick={() => void saveCopy(log)} disabled={isSaving || isDeleting === log.path}>{isSaving ? <LoaderCircle className="sd-spin" size={15} /> : <Save size={15} />} Save copy</button><button className="sd-saved-log-delete" type="button" onClick={(event) => requestDeletion(log, event.currentTarget)} disabled={isActive || isBusy} title={isActive ? 'Disconnect this active session before deleting its capture' : isBusy ? 'Wait for the current log operation to finish' : 'Delete saved log'} aria-label={`Delete ${log.fileName}`}><Trash2 size={15} /> Delete</button><button className="sd-saved-log-copy" type="button" onClick={() => void copy(log.path, 'Log file path copied.')} disabled={isDeleting === log.path} title="Copy log file path" aria-label={`Copy path for ${log.fileName}`}><Copy size={16} /></button></div>
        </article>;
        })}
      </div> : <section className="sd-saved-logs-empty"><div><FolderOpen size={26} /></div><h2>{logs.length ? 'No logs match that search.' : 'No saved captures yet.'}</h2><p>{logs.length ? 'Clear or adjust the search to see your local capture library.' : 'Start a serial session and its raw log will appear here immediately—even while it is still recording.'}</p>{logs.length ? <button className="sd-secondary-button" type="button" onClick={() => setQuery('')}>Clear search</button> : <button className="sd-primary-button" type="button" onClick={onRequestConnection}><Radio size={16} /> Start monitoring</button>}</section>}

    {selected && <div className="sd-log-preview-backdrop" role="presentation" onMouseDown={() => setSelected(null)}><section className="sd-log-preview" role="dialog" aria-modal="true" aria-label={`${selected.sessionName} log preview`} onMouseDown={(event) => event.stopPropagation()}><header><div><p>RAW LOG PREVIEW</p><h2>{selected.sessionName}</h2><span>{selected.port ?? selected.fileName} · {formatBytes(selected.sizeBytes)}</span></div><button type="button" className="sd-saved-log-copy" aria-label="Close preview" onClick={() => setSelected(null)}><X size={18} /></button></header>{selected.truncated && <div className="sd-log-preview-note"><AlertTriangle size={15} /> Showing the first 1 MB for a responsive preview. The full raw capture remains at the file path below.</div>}<pre>{selected.text || 'The capture has not received any bytes yet.'}</pre><footer><code>{selected.path}</code><div><button className="sd-secondary-button" type="button" onClick={() => void copy(selected.path, 'Log file path copied.')}><FolderOpen size={15} /> Copy path</button><button className="sd-primary-button" type="button" onClick={() => void copy(selected.text, 'Preview text copied.')}><Copy size={15} /> Copy preview</button></div></footer></section></div>}
    {pendingDeletion && <div className="sd-log-preview-backdrop" role="presentation" onMouseDown={() => !deleteInFlight.current && setPendingDeletion(null)}><section ref={deleteDialog} className="sd-log-delete-confirm" role="alertdialog" aria-modal="true" aria-labelledby="delete-log-title" aria-describedby="delete-log-description" aria-busy={Boolean(isDeleting)} onMouseDown={(event) => event.stopPropagation()}><div className="sd-log-delete-icon"><AlertTriangle size={21} /></div><div><p>DELETE SAVED LOG</p><h2 id="delete-log-title">Delete {pendingDeletion.fileName}?</h2><span id="delete-log-description">This permanently removes the raw capture from BaudTide’s local log library. It cannot be undone.</span></div>{pendingDeletionIsActive && <div className="sd-log-delete-error" role="alert">This capture is recording now. Disconnect its serial session before deleting it.</div>}{deletionError && !pendingDeletionIsActive && <div className="sd-log-delete-error" role="alert">{deletionError}</div>}<div className="sd-log-delete-actions"><button ref={deleteCancelButton} className="sd-secondary-button" type="button" onClick={() => setPendingDeletion(null)} disabled={Boolean(isDeleting)}>Cancel</button><button className="sd-saved-log-delete" type="button" onClick={() => void deleteLog(pendingDeletion)} disabled={Boolean(isDeleting) || pendingDeletionIsActive}>{isDeleting ? <LoaderCircle className="sd-spin" size={15} /> : <Trash2 size={15} />} {isDeleting ? 'Deleting…' : 'Delete log'}</button></div></section></div>}
    {notice && <div className="sd-saved-logs-notice" role="status" aria-live="polite"><Check size={15} /> {notice}</div>}
  </section>;
}
