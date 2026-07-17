import { useMemo, useState } from 'react';
import { Bell, CheckCheck, HardDrive, PlugZap, RotateCcw } from 'lucide-react';
import './phase3-controls.css';

type Notice = { id: string; title: string; detail: string; time: string; kind: 'connection' | 'storage' | 'reconnect'; unread: boolean };
const initialNotices: Notice[] = [
  { id: 'lost', title: 'ESP32 DevKitC disconnected', detail: 'A reconnect attempt will be available once the monitor backend is added.', time: 'Just now', kind: 'connection', unread: true },
  { id: 'space', title: 'Storage check', detail: '1.4 GB of the mock 10 GB local-storage limit is in use.', time: '22 min ago', kind: 'storage', unread: true },
  { id: 'sensor', title: 'Environmental Sensor reconnected', detail: 'This sample notification is already marked as read.', time: 'Yesterday', kind: 'reconnect', unread: false },
];

/** A mock notification centre with local unread/read state. */
export function NotificationsPanel() {
  const [open, setOpen] = useState(false); const [notices, setNotices] = useState(initialNotices);
  const unread = useMemo(() => notices.filter((notice) => notice.unread).length, [notices]);
  const markAll = () => setNotices((items) => items.map((item) => ({ ...item, unread: false })));
  const markRead = (id: string) => setNotices((items) => items.map((item) => item.id === id ? { ...item, unread: false } : item));
  return <div className="sd-notifications"><button className="sd-icon-control sd-notification-trigger" onClick={() => setOpen((value) => !value)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open}><Bell size={18} />{unread > 0 && <b>{unread}</b>}</button>
    {open && <section className="sd-notification-panel" aria-label="Notifications"><header><div><strong>Notifications</strong><small>Local mock activity</small></div><button onClick={markAll}><CheckCheck size={15} /> Mark all read</button></header><div className="sd-notice-list">{notices.map((notice) => <button className={notice.unread ? 'is-unread' : ''} key={notice.id} onClick={() => markRead(notice.id)}><NoticeIcon kind={notice.kind} /><span><strong>{notice.title}</strong><small>{notice.detail}</small><time>{notice.time}</time></span>{notice.unread && <i aria-label="Unread" />}</button>)}</div></section>}
  </div>;
}
function NoticeIcon({ kind }: { kind: Notice['kind'] }) { const Icon = kind === 'storage' ? HardDrive : kind === 'reconnect' ? RotateCcw : PlugZap; return <i className="sd-notice-icon"><Icon size={15} /></i>; }
