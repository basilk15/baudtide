import { useState } from 'react';
import { Bell } from 'lucide-react';
import './phase3-controls.css';

export function NotificationsPanel() {
  const [open, setOpen] = useState(false);
  return <div className="sd-notifications"><button className="sd-icon-control sd-notification-trigger" onClick={() => setOpen((value) => !value)} aria-label="Notifications" aria-expanded={open}><Bell size={18} /></button>
    {open && <section className="sd-notification-panel" aria-label="Notifications"><header><div><strong>Notifications</strong><small>No activity yet</small></div></header><div className="sd-notice-list sd-notice-empty">Connection and logging events will appear here.</div></section>}
  </div>;
}
