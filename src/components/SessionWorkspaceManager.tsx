import { BookmarkPlus, FolderOpen, Pencil, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import {
  deleteSessionWorkspace,
  loadSessionWorkspaces,
  renameSessionWorkspace,
  saveSessionWorkspace,
  type SavedSessionWorkspace,
  type TerminalLayout,
} from '../lib/sessionWorkspaces';
import './session-workspaces.css';

type OpenTerminal = { id: string; identity: string };

type SessionWorkspaceManagerProps = {
  layout: TerminalLayout;
  sessions: OpenTerminal[];
  selectedSessionId: string | null;
  onApply: (workspace: SavedSessionWorkspace, matchingSessionIds: string[]) => void;
};

export function SessionWorkspaceManager({ layout, sessions, selectedSessionId, onApply }: SessionWorkspaceManagerProps) {
  const [workspaces, setWorkspaces] = useState(loadSessionWorkspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('');
  const [isSaving, setSaving] = useState(false);
  const [isRenaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [status, setStatus] = useState('');
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);

  const applyWorkspace = (workspace: SavedSessionWorkspace) => {
    const matchingSessionIds = workspace.sessionIdentities.flatMap((identity) => {
      const match = sessions.find((session) => session.identity === identity);
      return match ? [match.id] : [];
    });
    onApply(workspace, matchingSessionIds);
    setActiveWorkspaceId(workspace.id);
    const missing = workspace.sessionIdentities.length - matchingSessionIds.length;
    setStatus(missing
      ? `Applied ${matchingSessionIds.length} open terminal${matchingSessionIds.length === 1 ? '' : 's'}. ${missing} saved terminal${missing === 1 ? ' is' : 's are'} not open; nothing was connected or disconnected.`
      : `Applied ${matchingSessionIds.length} open terminal${matchingSessionIds.length === 1 ? '' : 's'} without changing any connection.`);
  };

  const saveWorkspace = () => {
    const selected = sessions.find((session) => session.id === selectedSessionId);
    const saved = saveSessionWorkspace({
      name: draftName,
      layout,
      sessionIdentities: sessions.map((session) => session.identity),
      selectedSessionIdentity: selected?.identity ?? null,
    });
    if (!saved) {
      setStatus(sessions.length ? 'Enter a workspace name to save this layout.' : 'Open a terminal before saving a workspace.');
      return;
    }
    setWorkspaces((current) => [saved, ...current].slice(0, 30));
    setActiveWorkspaceId(saved.id);
    setDraftName('');
    setSaving(false);
    setStatus(`Saved “${saved.name}” locally.`);
  };

  const renameWorkspace = () => {
    if (!activeWorkspace) return;
    const updated = renameSessionWorkspace(activeWorkspace.id, draftName);
    if (!updated) {
      setStatus('Enter a new workspace name to rename it.');
      return;
    }
    setWorkspaces(updated);
    setDraftName('');
    setRenaming(false);
    setStatus(`Renamed workspace to “${updated.find((workspace) => workspace.id === activeWorkspace.id)?.name ?? activeWorkspace.name}”.`);
  };

  const removeWorkspace = () => {
    if (!activeWorkspace || !window.confirm(`Delete the saved workspace “${activeWorkspace.name}”? This does not close any terminals.`)) return;
    const updated = deleteSessionWorkspace(activeWorkspace.id);
    if (!updated) {
      setStatus('This saved workspace could not be deleted.');
      return;
    }
    setWorkspaces(updated);
    setActiveWorkspaceId('');
    setRenaming(false);
    setStatus(`Deleted “${activeWorkspace.name}”. Open terminals were left unchanged.`);
  };

  return <div className="bt-workspace-manager" aria-label="Saved terminal workspaces">
    <div className="bt-workspace-manager-controls">
      <button className="bt-workspace-save" type="button" disabled={!sessions.length} onClick={() => { setSaving((current) => !current); setRenaming(false); setDraftName(''); }}><BookmarkPlus size={14} /> Save workspace</button>
      <label className="bt-workspace-picker"><span className="sd-visually-hidden">Open saved workspace</span><select value={activeWorkspaceId} onChange={(event) => { const workspace = workspaces.find((candidate) => candidate.id === event.target.value); if (workspace) applyWorkspace(workspace); else setActiveWorkspaceId(''); }}><option value="">Saved workspaces{workspaces.length ? ` (${workspaces.length})` : ''}</option>{workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select></label>
      <button type="button" className="bt-workspace-icon" disabled={!activeWorkspace} onClick={() => { if (!activeWorkspace) return; setSaving(false); setRenaming(true); setDraftName(activeWorkspace.name); }} aria-label="Rename saved workspace" title="Rename saved workspace"><Pencil size={13} /></button>
      <button type="button" className="bt-workspace-icon bt-workspace-delete" disabled={!activeWorkspace} onClick={removeWorkspace} aria-label="Delete saved workspace" title="Delete saved workspace"><Trash2 size={13} /></button>
    </div>
    {(isSaving || isRenaming) && <form className="bt-workspace-name-form" onSubmit={(event) => { event.preventDefault(); if (isSaving) saveWorkspace(); else renameWorkspace(); }}><label htmlFor="workspace-name">{isSaving ? 'Workspace name' : 'New name'}</label><input id="workspace-name" autoFocus value={draftName} maxLength={80} placeholder={isSaving ? 'e.g. Bench bring-up' : 'Workspace name'} onChange={(event) => setDraftName(event.target.value)} /><button type="submit">{isSaving ? 'Save' : 'Rename'}</button><button type="button" className="bt-workspace-cancel" onClick={() => { setSaving(false); setRenaming(false); setDraftName(''); }} aria-label="Cancel"><X size={13} /></button></form>}
    {status && <p className="bt-workspace-status" role="status"><FolderOpen size={13} /> {status}</p>}
  </div>;
}
