import { useState } from 'react';
import {
  CircleHelp,
  FileText,
  LayoutDashboard,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  TerminalSquare,
  X,
} from 'lucide-react';
import type { NavigationItem, SignalDeckPage } from './phase3Types';
import signalDeckMark from '../assets/signaldeck-mark.png';
import './phase3-controls.css';
import './sidebar-recovery.css';

const defaultItems: NavigationItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'sessions', label: 'Live terminal', icon: TerminalSquare },
  { id: 'logs', label: 'Saved logs', icon: FileText },
];

type SidebarNavigationProps = {
  activePage?: SignalDeckPage;
  items?: NavigationItem[];
  onNavigate?: (page: SignalDeckPage) => void;
  onPreferences?: () => void;
  onHelp?: () => void;
};

/** Local-only navigation state for desktop compact mode and the mobile drawer. */
export function SidebarNavigation({
  activePage = 'dashboard',
  items = defaultItems,
  onNavigate,
  onPreferences,
  onHelp,
}: SidebarNavigationProps) {
  const [isCompact, setCompact] = useState(false);
  const [isDrawerOpen, setDrawerOpen] = useState(false);

  const visit = (page: SignalDeckPage) => {
    onNavigate?.(page);
    setDrawerOpen(false);
  };

  const menu = (mobile = false) => (
    <nav className="sd-side-nav" aria-label="Workspace navigation">
      <p className="sd-nav-label">Workspace</p>
      {items.map(({ id, label, icon: Icon, badge }) => (
        <button
          className={`sd-nav-item ${activePage === id ? 'is-active' : ''}`}
          key={id}
          onClick={() => visit(id)}
          title={isCompact && !mobile ? label : undefined}
          aria-current={activePage === id ? 'page' : undefined}
        >
          <Icon size={18} aria-hidden="true" />
          <span>{label}</span>
          {badge && <em>{badge}</em>}
        </button>
      ))}
      <div className="sd-nav-divider" />
      <button className="sd-nav-item" onClick={() => { onPreferences?.(); visit('preferences'); }}>
        <Settings2 size={18} aria-hidden="true" /><span>Preferences</span>
      </button>
      <button className="sd-nav-item" onClick={() => { onHelp?.(); visit('help'); }}>
        <CircleHelp size={18} aria-hidden="true" /><span>Help &amp; feedback</span>
      </button>
    </nav>
  );

  return (
    <>
      <aside className={`sd-sidebar ${isCompact ? 'is-compact' : ''}`} aria-label="SignalDeck sidebar">
        <div className="sd-sidebar-brand">
          <img className="sd-brand-mark" src={signalDeckMark} alt="SignalDeck" /><span>signal<span>deck</span></span>
          <button className="sd-icon-control" onClick={() => setCompact(true)} aria-label="Collapse sidebar" title="Collapse sidebar">
            <PanelLeftClose size={18} />
          </button>
        </div>
        {menu()}
        <p className="sd-sidebar-status">Local workspace</p>
      </aside>
      {isCompact && (
        <button
          className="sd-sidebar-expand-tab"
          type="button"
          onClick={() => setCompact(false)}
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <PanelLeftOpen size={18} aria-hidden="true" />
        </button>
      )}

      <button className="sd-mobile-menu-button" onClick={() => setDrawerOpen(true)} aria-label="Open navigation">
        <Menu size={20} />
      </button>
      {isDrawerOpen && (
        <div className="sd-drawer-backdrop" onMouseDown={() => setDrawerOpen(false)}>
          <aside className="sd-mobile-drawer" aria-label="Mobile navigation" onMouseDown={(event) => event.stopPropagation()}>
            <div className="sd-drawer-heading"><strong><img className="sd-brand-mark" src={signalDeckMark} alt="SignalDeck" />signal<span>deck</span></strong><button className="sd-icon-control" onClick={() => setDrawerOpen(false)} aria-label="Close navigation"><X size={19} /></button></div>
            {menu(true)}
            <p className="sd-sidebar-status">Local workspace</p>
          </aside>
        </div>
      )}
    </>
  );
}
