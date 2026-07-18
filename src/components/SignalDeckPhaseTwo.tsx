import { useMemo, useState } from 'react';
import {
  Archive, Check, ChevronDown, CirclePause, CirclePlay, Copy, Download, Edit3,
  FileText, Filter, FolderOpen, MoreHorizontal, PanelTop, Plus, Radio, Search,
  Send, TerminalSquare, Trash2, X,
} from 'lucide-react';
import './SignalDeckPhaseTwo.css';

export type SignalDeckPage = 'dashboard' | 'sessions' | 'logs';

export interface SignalDeckPhaseTwoProps {
  /** Used by the host app to open its existing connection dialog. */
  onRequestConnection?: () => void;
  /** Lets the existing sidebar keep ownership of the selected page. */
  page?: SignalDeckPage;
  onPageChange?: (page: SignalDeckPage) => void;
}

type Session = {
  id: string;
  name: string;
  port: string;
  baud: string;
  state: 'live' | 'reconnecting' | 'disconnected';
  paused: boolean;
  filter: string;
  encoding: 'UTF-8' | 'ASCII' | 'HEX';
  draft: string;
  sent: string[];
};

type Log = {
  id: string;
  name: string;
  device: string;
  port: string;
  date: string;
  size: string;
  lines: number;
  content: string;
};

type Workspace = { id: string; name: string; panels: number; updated: string };
type MenuTarget = { kind: 'session' | 'log' | 'workspace' | 'recent'; id: string } | null;

const initialSessions: Session[] = [
  { id: 'esp32', name: 'ESP32 DevKitC', port: '/dev/ttyUSB0', baud: '115200', state: 'live', paused: false, filter: '', encoding: 'UTF-8', draft: '', sent: [] },
  { id: 'sensor', name: 'Environmental Sensor', port: '/dev/ttyACM0', baud: '9600', state: 'live', paused: true, filter: '', encoding: 'UTF-8', draft: '', sent: [] },
  { id: 'bridge', name: 'BLE bridge', port: 'rfcomm0', baud: '57600', state: 'reconnecting', paused: false, filter: '', encoding: 'HEX', draft: '', sent: [] },
];

const initialLogs: Log[] = [
  { id: 'boot', name: 'esp32-boot-capture', device: 'ESP32 DevKitC', port: '/dev/ttyUSB0', date: 'Today, 14:32', size: '842 KB', lines: 18420, content: '14:32:01.002  boot: ESP-IDF v5.2\n14:32:01.204  wifi: connected\n14:32:02.412  api: listening on :3000' },
  { id: 'climate', name: 'greenhouse-validation', device: 'Environmental Sensor', port: '/dev/ttyACM0', date: 'Yesterday', size: '1.3 MB', lines: 32789, content: '09:18:04.122  temp=24.1 humidity=58\n09:18:05.122  temp=24.2 humidity=58' },
  { id: 'bridge-log', name: 'bridge-packet-sample', device: 'BLE bridge', port: 'rfcomm0', date: '14 Jul 2026', size: '204 KB', lines: 4910, content: '7E 01 0A 7C 33\n7E 01 0A 7C 34\n7E 01 0A 7C 35' },
];

const initialWorkspaces: Workspace[] = [
  { id: 'debug', name: 'ESP32 debug desk', panels: 2, updated: 'Updated 12 min ago' },
  { id: 'validation', name: 'Sensor validation', panels: 3, updated: 'Updated yesterday' },
];

const output = [
  '14:32:01.002  boot: ESP-IDF v5.2.1 2nd stage bootloader',
  '14:32:01.204  wifi: station connected, ip=192.168.1.32',
  '14:32:02.412  api: listening on port 3000',
  '14:32:05.008  sensor: temperature=24.1 humidity=58',
  '14:32:08.221  app: heartbeat ok',
];

function stateLabel(state: Session['state']) {
  return state === 'live' ? 'Live' : state === 'reconnecting' ? 'Reconnecting' : 'Disconnected';
}

function MenuButton({ target, menu, setMenu, children }: { target: MenuTarget; menu: MenuTarget; setMenu: (next: MenuTarget) => void; children: React.ReactNode }) {
  const isOpen = menu?.kind === target?.kind && menu?.id === target?.id;
  return <div className="sd-menu-wrap"><button className="sd-icon" aria-label="More options" aria-expanded={isOpen} onClick={() => setMenu(isOpen ? null : target)}><MoreHorizontal size={17} /></button>{isOpen && children}</div>;
}

function ConfirmDialog({ title, detail, onCancel, onConfirm }: { title: string; detail: string; onCancel: () => void; onConfirm: () => void }) {
  return <div className="sd-confirm-backdrop" role="presentation"><section className="sd-confirm" role="dialog" aria-modal="true" aria-labelledby="sd-confirm-title"><button className="sd-icon sd-confirm-close" onClick={onCancel} aria-label="Close"><X size={18} /></button><div className="sd-confirm-symbol"><Trash2 size={18} /></div><h2 id="sd-confirm-title">{title}</h2><p>{detail}</p><div><button className="sd-secondary" onClick={onCancel}>Cancel</button><button className="sd-danger" onClick={onConfirm}>Delete</button></div></section></div>;
}

function RenameDialog({ initial, noun, onCancel, onSave }: { initial: string; noun: string; onCancel: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(initial);
  return <div className="sd-confirm-backdrop" role="presentation"><section className="sd-confirm" role="dialog" aria-modal="true" aria-labelledby="sd-rename-title"><button className="sd-icon sd-confirm-close" onClick={onCancel} aria-label="Close"><X size={18} /></button><div className="sd-confirm-symbol"><Edit3 size={18} /></div><h2 id="sd-rename-title">Rename {noun}</h2><label className="sd-field">Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && name.trim()) onSave(name.trim()); }} /></label><div><button className="sd-secondary" onClick={onCancel}>Cancel</button><button className="sd-primary" disabled={!name.trim()} onClick={() => onSave(name.trim())}>Save name</button></div></section></div>;
}

function Dashboard({ sessions, workspaces, onRequestConnection, onPageChange, setMenu, menu, notify, setRename, setConfirm }: {
  sessions: Session[]; workspaces: Workspace[]; onRequestConnection: () => void; onPageChange: (p: SignalDeckPage) => void; setMenu: (x: MenuTarget) => void; menu: MenuTarget; notify: (x: string) => void; setRename: (x: { kind: 'workspace'; id: string; name: string } | null) => void; setConfirm: (x: { kind: 'workspace'; id: string; name: string } | null) => void;
}) {
  return <>
    <section className="sd-page-heading"><div><p className="sd-overline">MOCK WORKSPACE</p><h1>Your monitoring desk.</h1><p>Session and log values shown here are interface-only sample data.</p></div><button className="sd-primary" onClick={onRequestConnection}><Plus size={16} /> New connection</button></section>
    <section className="ready-card sd-dashboard-hero">
      <div className="ready-copy">
        <span className="status-pill"><i /> MONITOR READY</span>
        <h2>Bring your device online in seconds.</h2>
        <p>Open a local serial session, keep an eye on live output, and return to the same monitoring desk whenever you need it.</p>
        <div className="ready-actions">
          <button className="light-button" onClick={onRequestConnection}><Plus size={15} /> Start monitoring</button>
          <button className="text-button" onClick={() => onPageChange('sessions')}><TerminalSquare size={15} /> View active sessions</button>
        </div>
      </div>
      <div className="signal-art" aria-hidden="true">
        <span className="art-circle"><Radio size={37} /></span>
        <i className="art-ring art-ring-one" /><i className="art-ring art-ring-two" /><i className="art-ring art-ring-three" />
      </div>
    </section>
    <section className="sd-stat-grid">
      <article><span>Active sessions</span><strong>{sessions.filter((session) => session.state === 'live').length}</strong><small>of {sessions.length} sample sessions</small></article>
      <article><span>Captured today</span><strong>2.3M</strong><small>mock bytes in local-looking logs</small></article>
      <article><span>Saved logs</span><strong>24</strong><small>not persisted in this prototype</small></article>
    </section>
    <section className="sd-section-heading"><div><h2>Recent connections</h2><p>Continue with a sample device configuration.</p></div><button className="sd-text-button" onClick={() => onPageChange('sessions')}>View all <ChevronDown className="sd-arrow-right" size={15} /></button></section>
    <div className="sd-recent-grid">{sessions.map((session) => <article className="sd-card sd-recent" key={session.id}><div className="sd-row"><span className={`sd-status ${session.state}`} /> <small>{stateLabel(session.state)}</small><MenuButton target={{ kind: 'recent', id: session.id }} menu={menu} setMenu={setMenu}><div className="sd-popover"><button onClick={() => { notify(`Prepared ${session.name} for a mock connection.`); setMenu(null); }}>Connect</button><button onClick={() => { notify(`Copied ${session.port} to the clipboard style control.`); setMenu(null); }}>Copy port</button><button onClick={() => { notify('This is sample UI, so device history is not removed.'); setMenu(null); }}>Remove from recents</button></div></MenuButton></div><Radio size={22} /><h3>{session.name}</h3><p>{session.port} <i /> {session.baud} baud</p><button className="sd-inline-action" onClick={() => notify(`Prepared ${session.name} for a mock connection.`)}><CirclePlay size={15} /> Connect</button></article>)}</div>
    <section className="sd-section-heading"><div><h2>Saved workspaces</h2><p>Sample panel layouts for quick access.</p></div><button className="sd-text-button" onClick={() => notify('Workspace list expanded in this UI prototype.')}>View all</button></section>
    <div className="sd-workspace-list">{workspaces.map((workspace) => <article className="sd-workspace-row" key={workspace.id}><div className="sd-workspace-icon"><PanelTop size={18} /></div><div><h3>{workspace.name}</h3><p>{workspace.panels} panels · {workspace.updated}</p></div><button className="sd-secondary" onClick={() => { onPageChange('sessions'); notify(`Opened the ${workspace.name} mock workspace.`); }}><FolderOpen size={15} /> Open</button><MenuButton target={{ kind: 'workspace', id: workspace.id }} menu={menu} setMenu={setMenu}><div className="sd-popover"><button onClick={() => { onPageChange('sessions'); notify(`Opened the ${workspace.name} mock workspace.`); setMenu(null); }}>Open workspace</button><button onClick={() => { setRename({ kind: 'workspace', id: workspace.id, name: workspace.name }); setMenu(null); }}>Rename</button><button onClick={() => { notify(`Duplicated ${workspace.name} in the mock workspace list.`); setMenu(null); }}>Duplicate</button><button onClick={() => { notify('Reveal needs a local-storage backend.'); setMenu(null); }}>Reveal location</button><button className="sd-menu-danger" onClick={() => { setConfirm({ kind: 'workspace', id: workspace.id, name: workspace.name }); setMenu(null); }}>Remove</button></div></MenuButton></article>)}</div>
  </>;
}

function SessionPanel({ session, update, close, notify, setMenu, menu }: { session: Session; update: (next: Session) => void; close: () => void; notify: (x: string) => void; setMenu: (x: MenuTarget) => void; menu: MenuTarget }) {
  const visibleLines = useMemo(() => output.filter((line) => line.toLowerCase().includes(session.filter.toLowerCase())), [session.filter]);
  const send = () => { if (!session.draft.trim()) return; update({ ...session, sent: [...session.sent, session.draft], draft: '' }); notify(`Queued “${session.draft}” as mock sent data.`); };
  return <section className="sd-panel">
    <header className="sd-panel-head"><div><div className="sd-row"><span className={`sd-status ${session.state}`} /><span className="sd-panel-title">{session.name}</span>{session.paused && <span className="sd-paused">Display paused</span>}</div><p>{session.port} · {session.baud} baud · {session.encoding}</p></div><div className="sd-panel-actions"><button className="sd-icon" aria-label={session.paused ? 'Resume display' : 'Pause display'} onClick={() => update({ ...session, paused: !session.paused })}>{session.paused ? <CirclePlay size={17} /> : <CirclePause size={17} />}</button><MenuButton target={{ kind: 'session', id: session.id }} menu={menu} setMenu={setMenu}><div className="sd-popover"><button onClick={() => { notify('Reconnect is a visual-only control until the serial backend is added.'); setMenu(null); }}>Reconnect</button><button onClick={() => { update({ ...session, state: 'disconnected' }); setMenu(null); }}>Disconnect</button><button onClick={() => { update({ ...session, sent: [] }); notify('Cleared the mock sent-message history.'); setMenu(null); }}>Clear display</button><button className="sd-menu-danger" onClick={() => { close(); setMenu(null); }}>Close panel</button></div></MenuButton></div></header>
    <div className="sd-panel-tools"><label><Search size={14} /><input aria-label="Filter panel output" value={session.filter} placeholder="Filter output" onChange={(event) => update({ ...session, filter: event.target.value })} /></label><label className="sd-select-label">Encoding<select aria-label="Encoding" value={session.encoding} onChange={(event) => update({ ...session, encoding: event.target.value as Session['encoding'] })}><option>UTF-8</option><option>ASCII</option><option>HEX</option></select></label><button className="sd-clear" onClick={() => update({ ...session, filter: '' })}>Clear filter</button></div>
    <div className={`sd-terminal ${session.paused ? 'is-paused' : ''}`} aria-label={`${session.name} sample output`}>{visibleLines.length ? visibleLines.map((line) => <code key={line}><span>{line.slice(0, 12)}</span>{line.slice(12)}</code>) : <p>No sample lines match this filter.</p>}{session.sent.map((line, index) => <code className="sd-sent" key={`${line}-${index}`}><span>sent</span>{line}</code>)}{session.paused && <div className="sd-terminal-overlay">Display paused — sample capture would continue</div>}</div>
    <footer className="sd-send"><input value={session.draft} placeholder="Send text to device (mock)" onChange={(event) => update({ ...session, draft: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') send(); }} /><button className="sd-primary" onClick={send}><Send size={15} /> Send</button></footer>
  </section>;
}

function SessionsPage({ sessions, setSessions, notify, onRequestConnection, setMenu, menu }: { sessions: Session[]; setSessions: (value: Session[]) => void; notify: (x: string) => void; onRequestConnection: () => void; setMenu: (x: MenuTarget) => void; menu: MenuTarget }) {
  const [activeId, setActiveId] = useState(sessions[0]?.id ?? '');
  const active = sessions.find((session) => session.id === activeId) ?? sessions[0];
  const update = (next: Session) => setSessions(sessions.map((session) => session.id === next.id ? next : session));
  const close = () => { const left = sessions.filter((session) => session.id !== active?.id); setSessions(left); setActiveId(left[0]?.id ?? ''); notify(`${active?.name ?? 'Session'} panel closed in this UI prototype.`); };
  return <><section className="sd-page-heading"><div><p className="sd-overline">MULTI-SESSION MONITOR</p><h1>Sessions</h1><p>Each panel holds its own mock pause, filter, encoding, and send state.</p></div><button className="sd-primary" onClick={onRequestConnection}><Plus size={16} /> New session</button></section>
    {sessions.length ? <><div className="sd-tabs" role="tablist">{sessions.map((session) => <button role="tab" aria-selected={session.id === active?.id} className={session.id === active?.id ? 'active' : ''} key={session.id} onClick={() => setActiveId(session.id)}><span className={`sd-status ${session.state}`} />{session.name}{session.paused && <CirclePause size={13} />}<X size={13} onClick={(event) => { event.stopPropagation(); setActiveId(session.id); }} /></button>)}</div><SessionPanel session={active} update={update} close={close} notify={notify} setMenu={setMenu} menu={menu} /></> : <section className="sd-empty"><TerminalSquare size={25} /><h2>No open sample sessions</h2><p>Create a connection to add a panel. Actual serial connections are not included yet.</p><button className="sd-primary" onClick={onRequestConnection}>New connection</button></section>}</>;
}

function SavedLogsPage({ logs, setLogs, notify, setMenu, menu, setRename, setConfirm }: { logs: Log[]; setLogs: (logs: Log[]) => void; notify: (x: string) => void; setMenu: (x: MenuTarget) => void; menu: MenuTarget; setRename: (x: { kind: 'log'; id: string; name: string } | null) => void; setConfirm: (x: { kind: 'log'; id: string; name: string } | null) => void }) {
  const [query, setQuery] = useState(''); const [device, setDevice] = useState('All devices'); const [date, setDate] = useState('Any date'); const [preview, setPreview] = useState<Log | null>(null);
  const filtered = logs.filter((log) => {
    const matchesDevice = device === 'All devices' || log.device === device;
    const matchesQuery = query === '' || `${log.name} ${log.device} ${log.content}`.toLowerCase().includes(query.toLowerCase());
    const matchesDate = date === 'Any date' || (date === 'Today' && log.date.startsWith('Today')) || (date === 'Last 7 days' && log.date !== '14 Jul 2026') || date === 'Last 30 days';
    return matchesDevice && matchesQuery && matchesDate;
  });
  const exportLog = (log: Log, format: 'text' | 'CSV') => notify(`Prepared a mock ${format} export for ${log.name}; no file was written.`);
  return <><section className="sd-page-heading"><div><p className="sd-overline">LOCAL-LOOKING HISTORY</p><h1>Saved logs</h1><p>Search, filters, exports, and management below only modify in-memory mock data.</p></div><button className="sd-secondary" onClick={() => notify('Log import needs a storage backend.')}><Archive size={16} /> Import log</button></section>
    <section className="sd-log-controls"><label><Search size={16} /><input value={query} placeholder="Search logs and sample content" onChange={(event) => setQuery(event.target.value)} /></label><label><Filter size={15} /><select aria-label="Filter device" value={device} onChange={(event) => setDevice(event.target.value)}><option>All devices</option>{[...new Set(logs.map((log) => log.device))].map((name) => <option key={name}>{name}</option>)}</select></label><label><ChevronDown size={15} /><select aria-label="Filter date" value={date} onChange={(event) => setDate(event.target.value)}><option>Any date</option><option>Today</option><option>Last 7 days</option><option>Last 30 days</option></select></label><button className="sd-clear" onClick={() => { setQuery(''); setDevice('All devices'); setDate('Any date'); }}>Reset</button></section>
    <div className="sd-log-table" role="table"><div className="sd-log-head" role="row"><span>Log</span><span>Captured</span><span>Size</span><span>Actions</span></div>{filtered.map((log) => <div className="sd-log-row" role="row" key={log.id}><div><span className="sd-log-icon"><FileText size={17} /></span><div><strong>{log.name}</strong><p>{log.device} · {log.port} · {log.lines.toLocaleString()} lines</p></div></div><span>{log.date}</span><span>{log.size}</span><div className="sd-row"><button className="sd-text-button" onClick={() => setPreview(log)}>Preview</button><MenuButton target={{ kind: 'log', id: log.id }} menu={menu} setMenu={setMenu}><div className="sd-popover"><button onClick={() => { setPreview(log); setMenu(null); }}>Preview</button><button onClick={() => { exportLog(log, 'text'); setMenu(null); }}>Export .txt</button><button onClick={() => { exportLog(log, 'CSV'); setMenu(null); }}>Export CSV</button><button onClick={() => { setRename({ kind: 'log', id: log.id, name: log.name }); setMenu(null); }}>Rename</button><button onClick={() => { notify('Reveal needs a real local-log path.'); setMenu(null); }}>Reveal in folder</button><button className="sd-menu-danger" onClick={() => { setConfirm({ kind: 'log', id: log.id, name: log.name }); setMenu(null); }}>Delete</button></div></MenuButton></div></div>)}{!filtered.length && <div className="sd-empty sd-table-empty"><Search size={22} /><h2>No mock logs match</h2><p>Try clearing the search or filters.</p></div>}</div>
    {preview && <div className="sd-preview" role="dialog" aria-modal="true"><div><header><div><p className="sd-overline">SAMPLE LOG PREVIEW</p><h2>{preview.name}</h2></div><button className="sd-icon" onClick={() => setPreview(null)} aria-label="Close preview"><X size={18} /></button></header><p>{preview.device} · {preview.port}</p><pre>{preview.content}</pre><footer><button className="sd-secondary" onClick={() => exportLog(preview, 'text')}><Download size={15} /> Export text</button><button className="sd-primary" onClick={() => { notify('Copied mock log text.'); }}><Copy size={15} /> Copy content</button></footer></div></div>}</>;
}

/** A self-contained Phase 2 UI. It deliberately contains no Tauri, serial, or storage calls. */
export function SignalDeckPhaseTwo({ onRequestConnection = () => undefined, page: controlledPage, onPageChange }: SignalDeckPhaseTwoProps) {
  const [internalPage, setInternalPage] = useState<SignalDeckPage>('dashboard'); const [sessions, setSessions] = useState(initialSessions); const [logs, setLogs] = useState(initialLogs); const [workspaces, setWorkspaces] = useState(initialWorkspaces); const [menu, setMenu] = useState<MenuTarget>(null); const [notice, setNotice] = useState(''); const [rename, setRename] = useState<{ kind: 'log' | 'workspace'; id: string; name: string } | null>(null); const [confirm, setConfirm] = useState<{ kind: 'log' | 'workspace'; id: string; name: string } | null>(null);
  const page = controlledPage ?? internalPage; const changePage = (next: SignalDeckPage) => { setInternalPage(next); onPageChange?.(next); setMenu(null); };
  const notify = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(''), 3600); };
  const saveRename = (name: string) => { if (!rename) return; if (rename.kind === 'log') setLogs(logs.map((log) => log.id === rename.id ? { ...log, name } : log)); else setWorkspaces(workspaces.map((workspace) => workspace.id === rename.id ? { ...workspace, name } : workspace)); notify(`Renamed the mock ${rename.kind} to ${name}.`); setRename(null); };
  const deleteItem = () => { if (!confirm) return; if (confirm.kind === 'log') setLogs(logs.filter((log) => log.id !== confirm.id)); else setWorkspaces(workspaces.filter((workspace) => workspace.id !== confirm.id)); notify(`Deleted the mock ${confirm.kind} “${confirm.name}”.`); setConfirm(null); };
  return <div className="sd-phase-two" onClick={() => menu && setMenu(null)}><nav className="sd-page-tabs" aria-label="BaudTide sample pages"><button className={page === 'dashboard' ? 'active' : ''} onClick={() => changePage('dashboard')}>Dashboard</button><button className={page === 'sessions' ? 'active' : ''} onClick={() => changePage('sessions')}>Sessions <em>{sessions.length}</em></button><button className={page === 'logs' ? 'active' : ''} onClick={() => changePage('logs')}>Saved logs</button></nav><main onClick={(event) => event.stopPropagation()}>{page === 'dashboard' && <Dashboard sessions={sessions} workspaces={workspaces} onRequestConnection={onRequestConnection} onPageChange={changePage} setMenu={setMenu} menu={menu} notify={notify} setRename={setRename} setConfirm={setConfirm} />}{page === 'sessions' && <SessionsPage sessions={sessions} setSessions={setSessions} notify={notify} onRequestConnection={onRequestConnection} setMenu={setMenu} menu={menu} />}{page === 'logs' && <SavedLogsPage logs={logs} setLogs={setLogs} notify={notify} setMenu={setMenu} menu={menu} setRename={setRename} setConfirm={setConfirm} />}</main>{rename && <RenameDialog initial={rename.name} noun={rename.kind} onCancel={() => setRename(null)} onSave={saveRename} />}{confirm && <ConfirmDialog title={`Delete ${confirm.kind}?`} detail={`“${confirm.name}” will be removed from this mock UI list. This does not affect files or real workspace data.`} onCancel={() => setConfirm(null)} onConfirm={deleteItem} />}{notice && <div className="sd-notice"><Check size={15} />{notice}</div>}</div>;
}

export default SignalDeckPhaseTwo;
