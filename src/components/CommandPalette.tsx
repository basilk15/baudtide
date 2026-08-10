import { useEffect, useMemo, useRef, useState } from 'react';
import { Command, FileText, MonitorPlay, Plus, Search, Settings2, Smartphone, TerminalSquare, X } from 'lucide-react';
import './phase3-controls.css';

export type CommandPaletteAction = { id: string; label: string; description: string; shortcut?: string; icon?: 'new' | 'session' | 'log' | 'mobile' | 'preferences'; disabled?: boolean; run?: () => void };

const defaultActions: CommandPaletteAction[] = [
  { id: 'new-connection', label: 'New connection', description: 'Start a local connection setup preview', shortcut: 'N', icon: 'new' },
  { id: 'pause', label: 'Pause active display', description: 'Panel action placeholder', shortcut: 'Space', icon: 'session' },
  { id: 'clear', label: 'Clear active display', description: 'Panel action placeholder', shortcut: '⌘ Delete', icon: 'session' },
  { id: 'find', label: 'Find in output', description: 'Panel action placeholder', shortcut: '⌘ F', icon: 'log' },
  { id: 'preferences', label: 'Open preferences', description: 'Configure local defaults', icon: 'preferences' },
];

type CommandPaletteProps = { actions?: CommandPaletteAction[]; onAction?: (action: CommandPaletteAction) => void };

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
}

/** Command/Ctrl+K opens this local action launcher. */
export function CommandPalette({ actions = defaultActions, onAction }: CommandPaletteProps) {
  const [open, setOpen] = useState(false); const [query, setQuery] = useState(''); const [selectedIndex, setSelectedIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setQuery('');
    window.setTimeout(() => trigger.current?.focus(), 0);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        // Let native text editing controls retain their platform shortcut. Check
        // the active element too, because a key event can originate from a child
        // node inside a contenteditable region.
        if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return;
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (open) { setSelectedIndex(0); window.setTimeout(() => input.current?.focus(), 0); } }, [open]);
  const filtered = useMemo(() => actions.filter((action) => `${action.label} ${action.description}`.toLowerCase().includes(query.toLowerCase())), [actions, query]);
  useEffect(() => { setSelectedIndex((current) => Math.min(current, Math.max(filtered.length - 1, 0))); }, [filtered.length]);
  const execute = (action: CommandPaletteAction) => {
    if (action.disabled) return;
    action.run?.(); onAction?.(action); close();
  };
  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelectedIndex((current) => filtered.length ? (current + 1) % filtered.length : 0); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setSelectedIndex((current) => filtered.length ? (current - 1 + filtered.length) % filtered.length : 0); return; }
    if (event.key === 'Enter' && filtered[selectedIndex]) { event.preventDefault(); execute(filtered[selectedIndex]); }
  };
  return <>
    <button ref={trigger} className="sd-command-trigger" type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}><Search size={16} /><span>Search commands</span><kbd><Command size={11} />K</kbd></button>
    {open && <div className="sd-palette-backdrop" onMouseDown={close}><section className="sd-command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') close(); }}>
      <div className="sd-palette-search"><Search size={18} /><input ref={input} value={query} onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }} onKeyDown={onInputKeyDown} placeholder="Search actions, terminals, or logs…" role="combobox" aria-expanded="true" aria-controls="sd-palette-results" aria-activedescendant={filtered[selectedIndex] ? `sd-palette-action-${filtered[selectedIndex].id}` : undefined} /><button type="button" onClick={close} aria-label="Close command palette"><X size={17} /></button></div>
      <p className="sd-palette-note">Use keyboard commands to navigate BaudTide.</p>
      <div className="sd-palette-results" id="sd-palette-results" role="listbox">{filtered.length ? filtered.map((action, index) => <button id={`sd-palette-action-${action.id}`} role="option" aria-selected={index === selectedIndex} className={index === selectedIndex ? 'is-selected' : ''} key={action.id} type="button" disabled={action.disabled} onMouseMove={() => setSelectedIndex(index)} onClick={() => execute(action)}><PaletteIcon icon={action.icon} /><span><strong>{action.label}</strong><small>{action.description}</small></span>{action.shortcut && <kbd>{action.shortcut}</kbd>}</button>) : <p className="sd-empty-result">No matching local actions.</p>}</div>
      <footer><span><kbd>↑↓</kbd> navigate</span><span><kbd>↵</kbd> choose</span><span><kbd>esc</kbd> close</span></footer>
    </section></div>}
  </>;
}

function PaletteIcon({ icon }: { icon?: CommandPaletteAction['icon'] }) {
  const Icon = icon === 'new' ? Plus : icon === 'log' ? FileText : icon === 'mobile' ? Smartphone : icon === 'preferences' ? Settings2 : TerminalSquare;
  return <i><Icon size={16} /></i>;
}
