import { useEffect, useMemo, useRef, useState } from 'react';
import { Command, FileText, MonitorPlay, Plus, Search, Settings2, TerminalSquare, X } from 'lucide-react';
import './phase3-controls.css';

export type CommandPaletteAction = { id: string; label: string; description: string; shortcut?: string; icon?: 'new' | 'session' | 'log' | 'preferences'; run?: () => void };

const defaultActions: CommandPaletteAction[] = [
  { id: 'new-connection', label: 'New connection', description: 'Start a local connection setup preview', shortcut: 'N', icon: 'new' },
  { id: 'pause', label: 'Pause active display', description: 'Panel action placeholder', shortcut: 'Space', icon: 'session' },
  { id: 'clear', label: 'Clear active display', description: 'Panel action placeholder', shortcut: '⌘ Delete', icon: 'session' },
  { id: 'find', label: 'Find in output', description: 'Panel action placeholder', shortcut: '⌘ F', icon: 'log' },
  { id: 'preferences', label: 'Open preferences', description: 'Configure local defaults', icon: 'preferences' },
];

type CommandPaletteProps = { actions?: CommandPaletteAction[]; onAction?: (action: CommandPaletteAction) => void };

/** Command/Ctrl+K opens this local action launcher; commands do not invoke backend work. */
export function CommandPalette({ actions = defaultActions, onAction }: CommandPaletteProps) {
  const [open, setOpen] = useState(false); const [query, setQuery] = useState(''); const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setOpen(true); }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (open) window.setTimeout(() => input.current?.focus(), 0); }, [open]);
  const filtered = useMemo(() => actions.filter((action) => `${action.label} ${action.description}`.toLowerCase().includes(query.toLowerCase())), [actions, query]);
  const execute = (action: CommandPaletteAction) => { action.run?.(); onAction?.(action); setOpen(false); setQuery(''); };
  return <>
    <button className="sd-command-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog"><Search size={16} /><span>Search commands</span><kbd><Command size={11} />K</kbd></button>
    {open && <div className="sd-palette-backdrop" onMouseDown={() => setOpen(false)}><section className="sd-command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
      <div className="sd-palette-search"><Search size={18} /><input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search actions, terminals, or logs…" /><button onClick={() => setOpen(false)} aria-label="Close command palette"><X size={17} /></button></div>
      <p className="sd-palette-note">Use keyboard commands to navigate BaudTide.</p>
      <div className="sd-palette-results">{filtered.length ? filtered.map((action) => <button key={action.id} onClick={() => execute(action)}><PaletteIcon icon={action.icon} /><span><strong>{action.label}</strong><small>{action.description}</small></span>{action.shortcut && <kbd>{action.shortcut}</kbd>}</button>) : <p className="sd-empty-result">No matching local actions.</p>}</div>
      <footer><span><kbd>↑↓</kbd> navigate</span><span><kbd>↵</kbd> choose</span><span><kbd>esc</kbd> close</span></footer>
    </section></div>}
  </>;
}

function PaletteIcon({ icon }: { icon?: CommandPaletteAction['icon'] }) {
  const Icon = icon === 'new' ? Plus : icon === 'log' ? FileText : icon === 'preferences' ? Settings2 : TerminalSquare;
  return <i><Icon size={16} /></i>;
}
