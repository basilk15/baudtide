import { useState } from 'react';
import { Check, ChevronDown, LogOut, Plus, Settings2, UserRound } from 'lucide-react';
import type { MockWorkspace } from './phase3Types';
import './phase3-controls.css';

const defaultWorkspaces: MockWorkspace[] = [
  { id: 'basil', name: "Basil's lab", description: 'Personal workspace', initial: 'B' },
  { id: 'embedded', name: 'Embedded experiments', description: 'Local mock workspace', initial: 'E' },
];

type WorkspaceProfileMenuProps = { workspaces?: MockWorkspace[]; onWorkspaceChange?: (workspace: MockWorkspace) => void; onPreferences?: () => void };

/** Profile/workspace affordance for future local workspace support, intentionally not account-backed. */
export function WorkspaceProfileMenu({ workspaces = defaultWorkspaces, onWorkspaceChange, onPreferences }: WorkspaceProfileMenuProps) {
  const [open, setOpen] = useState(false); const [current, setCurrent] = useState(workspaces[0]); const [notice, setNotice] = useState('');
  const switchWorkspace = (workspace: MockWorkspace) => { setCurrent(workspace); onWorkspaceChange?.(workspace); setNotice(`${workspace.name} selected locally`); window.setTimeout(() => setNotice(''), 2200); setOpen(false); };
  return <div className="sd-profile-menu"><button className="sd-profile-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="menu"><i>{current.initial}</i><span><strong>{current.name}</strong><small>Local workspace</small></span><ChevronDown size={15} /></button>
    {open && <section className="sd-workspace-popover" role="menu"><p>LOCAL WORKSPACES</p>{workspaces.map((workspace) => <button role="menuitem" className={workspace.id === current.id ? 'is-selected' : ''} onClick={() => switchWorkspace(workspace)} key={workspace.id}><i>{workspace.initial}</i><span><strong>{workspace.name}</strong><small>{workspace.description}</small></span>{workspace.id === current.id && <Check size={16} />}</button>)}<div /><button role="menuitem" onClick={() => { setNotice('Creating workspaces will be available with local storage.'); setOpen(false); }}><Plus size={17} /><span>Create local workspace</span></button><button role="menuitem" onClick={() => { onPreferences?.(); setOpen(false); }}><Settings2 size={17} /><span>Workspace preferences</span></button><button role="menuitem" onClick={() => { setNotice('There is no account to sign out of in this local preview.'); setOpen(false); }}><LogOut size={17} /><span>Sign out (unavailable)</span></button></section>}{notice && <p className="sd-local-notice" role="status"><UserRound size={14} />{notice}</p>}
  </div>;
}
