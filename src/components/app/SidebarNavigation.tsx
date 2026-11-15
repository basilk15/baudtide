import { useEffect, useId, useRef, useState } from 'react';
import {
  CircleHelp,
  FileText,
  LayoutDashboard,
  LineChart,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Smartphone,
  TerminalSquare,
  X,
} from 'lucide-react';
import type { NavigationItem, SignalDeckPage } from './navigation';
import baudTideMark from '../../assets/signaldeck-mark.png';
import './command-controls.css';
import './sidebar-recovery.css';

const defaultItems: NavigationItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'sessions', label: 'Live terminal', icon: TerminalSquare },
  { id: 'visualize', label: 'Visualize', icon: LineChart },
  { id: 'logs', label: 'Saved logs', icon: FileText },
  { id: 'mobile', label: 'Mobile share', icon: Smartphone },
];

type SidebarNavigationProps = {
  activePage?: SignalDeckPage;
  items?: NavigationItem[];
  onNavigate?: (page: SignalDeckPage) => void;
  onHome?: () => void;
  onPreferences?: () => void;
  onHelp?: () => void;
};

/** Local-only navigation state for desktop compact mode and the mobile drawer. */
export function SidebarNavigation({
  activePage = 'dashboard',
  items = defaultItems,
  onNavigate,
  onHome,
  onPreferences,
  onHelp,
}: SidebarNavigationProps) {
  const [isCompact, setCompact] = useState(false);
  const [isDrawerOpen, setDrawerOpen] = useState(false);
  const [isDrawerMounted, setDrawerMounted] = useState(false);
  const drawerId = useId();
  const drawer = useRef<HTMLElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isDrawerOpen) {
      setDrawerMounted(true);
      return undefined;
    }

    const timer = window.setTimeout(() => setDrawerMounted(false), 240);
    return () => window.clearTimeout(timer);
  }, [isDrawerOpen]);

  useEffect(() => {
    if (!isDrawerOpen || !isDrawerMounted || !drawer.current || !backdrop.current) return;
    const panel = drawer.current;
    const background = [...(backdrop.current.parentElement?.children ?? [])]
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop.current)
      .map((element) => ({ element, inert: element.hasAttribute('inert') }));
    background.forEach(({ element }) => { element.toggleAttribute('inert', true); });
    panel.querySelector<HTMLButtonElement>('[aria-label="Close navigation"]')?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      // Keep window-level app shortcuts from opening a second surface behind the drawer.
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault(); setDrawerOpen(false);
      } else if (event.key === 'Tab') {
        const controls = [...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const first = controls[0], last = controls[controls.length - 1];
        if (!panel.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault(); (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    const desktop = window.matchMedia?.('(min-width: 761px)');
    const onDesktop = () => { if (desktop?.matches) setDrawerOpen(false); };
    document.addEventListener('keydown', onKey);
    desktop?.addEventListener('change', onDesktop);
    onDesktop();
    return () => {
      document.removeEventListener('keydown', onKey);
      desktop?.removeEventListener('change', onDesktop);
      background.forEach(({ element, inert }) => { element.toggleAttribute('inert', inert); });
      const desktopTarget = background.find(({ element }) => element.matches('.sd-sidebar'))?.element
        .querySelector<HTMLButtonElement>('[aria-current="page"]');
      (desktop?.matches ? desktopTarget ?? menuTrigger.current : menuTrigger.current)?.focus({ preventScroll: true });
    };
  }, [isDrawerOpen, isDrawerMounted]);

  const visit = (page: SignalDeckPage) => {
    onNavigate?.(page);
    setDrawerOpen(false);
  };

  const goHome = () => {
    onHome?.();
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
      <button className={`sd-nav-item ${activePage === 'preferences' ? 'is-active' : ''}`} aria-current={activePage === 'preferences' ? 'page' : undefined} onClick={() => { onPreferences?.(); visit('preferences'); }}>
        <Settings2 size={18} aria-hidden="true" /><span>Preferences</span>
      </button>
      <button className={`sd-nav-item ${activePage === 'help' ? 'is-active' : ''}`} aria-current={activePage === 'help' ? 'page' : undefined} onClick={() => { onHelp?.(); visit('help'); }}>
        <CircleHelp size={18} aria-hidden="true" /><span>Help &amp; feedback</span>
      </button>
    </nav>
  );

  return (
    <>
      <aside className={`sd-sidebar ${isCompact ? 'is-compact' : ''}`} aria-label="BaudTide sidebar">
        <div className="sd-sidebar-brand">
          <button className="sd-sidebar-home" type="button" onClick={goHome} aria-label="Go to BaudTide home" title="BaudTide home">
            <img className="sd-brand-mark" src={baudTideMark} alt="" /><span>baud<span>tide</span></span>
          </button>
          <button className="sd-icon-control" onClick={() => setCompact(true)} aria-label="Collapse sidebar" title="Collapse sidebar">
            <PanelLeftClose size={18} />
          </button>
        </div>
        {menu()}
        <p className="sd-sidebar-status">Local workspace</p>
      </aside>
      <button
        className={`sd-sidebar-expand-tab ${isCompact ? 'is-visible' : ''}`}
        type="button"
        onClick={() => setCompact(false)}
        aria-label="Expand sidebar"
        aria-hidden={!isCompact}
        tabIndex={isCompact ? 0 : -1}
        title={isCompact ? 'Expand sidebar' : undefined}
      >
        <PanelLeftOpen size={18} aria-hidden="true" />
      </button>

      <button ref={menuTrigger} className="sd-mobile-menu-button" onClick={() => setDrawerOpen(true)} aria-label="Open navigation" aria-expanded={isDrawerOpen} aria-controls={isDrawerMounted ? drawerId : undefined} aria-haspopup="dialog">
        <Menu size={20} />
      </button>
      {isDrawerMounted && (
        <div ref={backdrop} className={`sd-drawer-backdrop ${isDrawerOpen ? 'is-open' : 'is-closing'}`} aria-hidden={!isDrawerOpen} inert={!isDrawerOpen} onMouseDown={() => setDrawerOpen(false)}>
          <aside ref={drawer} id={drawerId} role="dialog" aria-modal="true" className={`sd-mobile-drawer ${isDrawerOpen ? 'is-open' : 'is-closing'}`} aria-label="Mobile navigation" onMouseDown={(event) => event.stopPropagation()}>
            <div className="sd-drawer-heading"><button className="sd-sidebar-home" type="button" onClick={goHome} aria-label="Go to BaudTide home"><img className="sd-brand-mark" src={baudTideMark} alt="" /><span>baud<span>tide</span></span></button><button className="sd-icon-control" onClick={() => setDrawerOpen(false)} aria-label="Close navigation"><X size={19} /></button></div>
            {menu(true)}
            <p className="sd-sidebar-status">Local workspace</p>
          </aside>
        </div>
      )}
    </>
  );
}
