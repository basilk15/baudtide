import { useState } from 'react';
import { Check, ChevronDown, Settings2 } from 'lucide-react';
import type { Workspace } from './phase3Types';
import './phase3-controls.css';

const defaultWorkspaces: Workspace[] = [
  { id: 'basil', name: "Basil's lab", description: 'Personal workspace', initial: 'B' },
];

type WorkspaceProfileMenuProps = { workspaces?: Workspace[]; onWorkspaceChange?: (workspace: Workspace) => void; onPreferences?: () => void };

/** Profile/workspace affordance for future local workspace support, intentionally not account-backed. */
export function WorkspaceProfileMenu({ workspaces = defaultWorkspaces, onWorkspaceChange, onPreferences }: WorkspaceProfileMenuProps) {
  const [open, setOpen] = useState(false); const [current, setCurrent] = useState(workspaces[0]);
  const switchWorkspace = (workspace: Workspace) => { setCurrent(workspace); onWorkspaceChange?.(workspace); setOpen(false); };
  return <div className="sd-profile-menu"><button className="sd-profile-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="menu"><i>{current.initial}</i><span><strong>{current.name}</strong><small>Local workspace</small></span><ChevronDown size={15} /></button>
    {open && <section className="sd-workspace-popover" role="menu"><p>LOCAL WORKSPACE</p>{workspaces.map((workspace) => <button role="menuitem" className={workspace.id === current.id ? 'is-selected' : ''} onClick={() => switchWorkspace(workspace)} key={workspace.id}><i>{workspace.initial}</i><span><strong>{workspace.name}</strong><small>{workspace.description}</small></span>{workspace.id === current.id && <Check size={16} />}</button>)}<div /><button role="menuitem" onClick={() => { onPreferences?.(); setOpen(false); }}><Settings2 size={17} /><span>Workspace preferences</span></button></section>}
  </div>;
}
