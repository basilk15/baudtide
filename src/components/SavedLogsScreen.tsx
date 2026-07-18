import { useEffect, useMemo, useState } from 'react';
import { save as chooseSavePath } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, Check, Clock3, Copy, FileText, FolderOpen, HardDrive, LoaderCircle, Radio, RefreshCw, Save, Search, X } from 'lucide-react';
import { listNativeSavedLogs, readNativeSavedLog, saveNativeSavedLog, type SavedLog, type SavedLogContent } from '../lib/serial';
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
  const [isLoading, setLoading] = useState(nativeEnabled);
  const [isRefreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<(SavedLog & SavedLogContent) | null>(null);
  const [isOpening, setOpening] = useState<string | null>(null);
  const [isSaving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const refresh = async (showSpinner = true) => {
    if (!nativeEnabled) return;
    if (showSpinner) setRefreshing(true);
    try {
      const nextLogs = await listNativeSavedLogs();
      setLogs(nextLogs);
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

  const filteredLogs = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return logs;
    return logs.filter((log) => `${log.sessionName} ${log.fileName} ${log.port ?? ''}`.toLowerCase().includes(normalized));
  }, [logs, query]);
  const activeCount = logs.filter((log) => log.state === 'capturing').length;

  const openLog = async (log: SavedLog) => {
    setOpening(log.path);
    try {
      const content = await readNativeSavedLog(log.path);
      setSelected({ ...log, ...content });
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open that saved log.');
    } finally {
      setOpening(null);
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
    setSaving(log.path);
    try {
      const destination = await chooseSavePath({
        defaultPath: log.fileName,
        filters: [{ name: 'Serial log', extensions: ['log', 'txt'] }],
      });
      if (!destination) return;
      const savedPath = await saveNativeSavedLog(log.path, destination);
      setNotice(`Saved a copy to ${savedPath}.`);
      window.setTimeout(() => setNotice(''), 3_600);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save a copy of that log.');
    } finally {
      setSaving(null);
    }
  };

  if (!nativeEnabled) {
    return <section className="sd-empty-workspace"><div className="sd-empty-workspace-icon"><FileText size={28} /></div><p>SAVED LOGS</p><h1>Open BaudTide desktop to browse captures.</h1><span>Saved logs live on the local machine and are available in the desktop app, where the serial backend can access them.</span></section>;
  }

  return <section className="sd-saved-logs" aria-label="Saved serial logs">
    <header className="sd-saved-logs-header">
      <div><p className="sd-saved-logs-eyebrow">LOCAL CAPTURE LIBRARY</p><h1>Saved logs</h1><p>Every live terminal is written as a raw local file from the moment monitoring begins.</p></div>
      <button className="sd-secondary-button" type="button" onClick={() => void refresh()} disabled={isRefreshing}><RefreshCw className={isRefreshing ? 'sd-spin' : ''} size={16} /> Refresh</button>
    </header>

    {error && <div className="sd-saved-logs-alert" role="alert"><AlertTriangle size={16} /> {error}</div>}

    {activeCount > 0 && <section className="sd-active-capture-summary"><span><Radio size={17} /></span><div><strong>{activeCount === 1 ? '1 capture is active' : `${activeCount} captures are active`}</strong><p>Its raw log is already listed below and grows while monitoring continues.</p></div><button type="button" onClick={() => void refresh(false)}>Update size</button></section>}

    <section className="sd-saved-logs-toolbar">
      <label className="sd-saved-logs-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by session, port, or file name" /></label>
      <span>{filteredLogs.length} {filteredLogs.length === 1 ? 'log' : 'logs'}</span>
    </section>

    {isLoading ? <div className="sd-saved-logs-loading"><LoaderCircle className="sd-spin" size={21} /> Loading local captures…</div>
      : filteredLogs.length ? <div className="sd-saved-log-list" role="list">
        {filteredLogs.map((log) => <article className="sd-saved-log-row" role="listitem" key={log.path}>
          <div className={`sd-saved-log-icon ${log.state}`}><FileText size={20} /></div>
          <div className="sd-saved-log-primary"><div className="sd-saved-log-name"><strong>{log.sessionName}</strong>{log.state === 'capturing' && <span><i /> Capturing now</span>}</div><p>{log.port ? `${log.port} · ${log.baudRate?.toLocaleString()} baud` : log.fileName}</p><small>{log.fileName}</small></div>
          <div className="sd-saved-log-meta"><span><Clock3 size={14} /> {formatCapturedAt(log.modifiedAt)}</span><span><HardDrive size={14} /> {formatBytes(log.sizeBytes)}</span></div>
          <div className="sd-saved-log-actions"><button className="sd-secondary-button" type="button" onClick={() => void openLog(log)} disabled={isOpening === log.path}>{isOpening === log.path ? <LoaderCircle className="sd-spin" size={15} /> : <FileText size={15} />} Preview</button><button className="sd-secondary-button" type="button" onClick={() => void saveCopy(log)} disabled={isSaving === log.path}>{isSaving === log.path ? <LoaderCircle className="sd-spin" size={15} /> : <Save size={15} />} Save copy</button><button className="sd-saved-log-copy" type="button" onClick={() => void copy(log.path, 'Log file path copied.')} title="Copy log file path" aria-label={`Copy path for ${log.fileName}`}><Copy size={16} /></button></div>
        </article>)}
      </div> : <section className="sd-saved-logs-empty"><div><FolderOpen size={26} /></div><h2>{logs.length ? 'No logs match that search.' : 'No saved captures yet.'}</h2><p>{logs.length ? 'Clear or adjust the search to see your local capture library.' : 'Start a serial session and its raw log will appear here immediately—even while it is still recording.'}</p>{logs.length ? <button className="sd-secondary-button" type="button" onClick={() => setQuery('')}>Clear search</button> : <button className="sd-primary-button" type="button" onClick={onRequestConnection}><Radio size={16} /> Start monitoring</button>}</section>}

    {selected && <div className="sd-log-preview-backdrop" role="presentation" onMouseDown={() => setSelected(null)}><section className="sd-log-preview" role="dialog" aria-modal="true" aria-label={`${selected.sessionName} log preview`} onMouseDown={(event) => event.stopPropagation()}><header><div><p>RAW LOG PREVIEW</p><h2>{selected.sessionName}</h2><span>{selected.port ?? selected.fileName} · {formatBytes(selected.sizeBytes)}</span></div><button type="button" className="sd-saved-log-copy" aria-label="Close preview" onClick={() => setSelected(null)}><X size={18} /></button></header>{selected.truncated && <div className="sd-log-preview-note"><AlertTriangle size={15} /> Showing the first 1 MB for a responsive preview. The full raw capture remains at the file path below.</div>}<pre>{selected.text || 'The capture has not received any bytes yet.'}</pre><footer><code>{selected.path}</code><div><button className="sd-secondary-button" type="button" onClick={() => void copy(selected.path, 'Log file path copied.')}><FolderOpen size={15} /> Copy path</button><button className="sd-primary-button" type="button" onClick={() => void copy(selected.text, 'Preview text copied.')}><Copy size={15} /> Copy preview</button></div></footer></section></div>}
    {notice && <div className="sd-saved-logs-notice"><Check size={15} /> {notice}</div>}
  </section>;
}
