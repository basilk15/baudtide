import { useEffect, useMemo, useState } from 'react';
import { Bell, CheckCircle2, CircleAlert, FileDown, PlugZap } from 'lucide-react';
import type { AppNotification } from './notifications';
import './phase3-controls.css';

type NotificationsPanelProps = {
  notifications: AppNotification[];
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
};

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Just now' : new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(date);
}

function NoticeIcon({ kind }: { kind: AppNotification['kind'] }) {
  const Icon = kind === 'error' ? CircleAlert : kind === 'export' ? FileDown : kind === 'connection' ? PlugZap : CheckCircle2;
  return <i className={`sd-notice-icon ${kind}`}><Icon size={15} /></i>;
}

export function NotificationsPanel({ notifications, onMarkRead, onMarkAllRead }: NotificationsPanelProps) {
  const [open, setOpen] = useState(false);
  const unread = useMemo(() => notifications.filter((notification) => !notification.read).length, [notifications]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  return <div className="sd-notifications"><button className="sd-icon-control sd-notification-trigger" type="button" onClick={() => setOpen((value) => !value)} aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} aria-expanded={open} aria-haspopup="dialog"><Bell size={18} />{unread > 0 && <b aria-hidden="true">{unread > 9 ? '9+' : unread}</b>}</button>
    {open && <section className="sd-notification-panel" role="dialog" aria-label="Notifications"><header><div><strong>Notifications</strong><small>{unread ? `${unread} unread` : notifications.length ? 'All caught up' : 'No activity yet'}</small></div>{unread > 0 && <button type="button" onClick={onMarkAllRead}>Mark all read</button>}</header>{notifications.length ? <div className="sd-notice-list">{notifications.map((notification) => <button type="button" className={notification.read ? '' : 'is-unread'} key={notification.id} onClick={() => onMarkRead(notification.id)}><NoticeIcon kind={notification.kind} /><span><strong>{notification.title}</strong><small>{notification.detail}</small><time>{formatTime(notification.createdAt)}</time></span>{!notification.read && <i aria-label="Unread" />}</button>)}</div> : <div className="sd-notice-list sd-notice-empty">Connection, logging, and export events will appear here.</div>}</section>}
  </div>;
}
