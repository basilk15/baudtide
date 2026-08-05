import { BookmarkPlus, FolderOpen, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
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
  const [{ workspaces: initialWorkspaces, error: initialLoadError }] = useState(loadSessionWorkspaces);
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('');
  const [isSaving, setSaving] = useState(false);
  const [isRenaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [status, setStatus] = useState(() => {
    if (initialLoadError === 'storage-read-failed') return 'Saved workspaces could not be read from local storage.';
    if (initialLoadError === 'storage-unavailable') return 'Saved workspaces are unavailable because local storage is blocked.';
    return '';
  });
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);

  useEffect(() => {
    if (!activeWorkspaceId || activeWorkspace) return;
    setActiveWorkspaceId('');
    setRenaming(false);
    setStatus('The selected saved workspace is no longer available.');
  }, [activeWorkspace, activeWorkspaceId]);

  const applyWorkspace = (workspace: SavedSessionWorkspace) => {
    const matchingSessionIds = workspace.sessionIdentities.flatMap((identity) => {
      const match = sessions.find((session) => session.identity === identity);
      return match ? [match.id] : [];
    });
    const hasSelectedIdentity = workspace.selectedSessionIdentity !== null;
    const selectedStillOpen = hasSelectedIdentity
      ? sessions.some((session) => session.identity === workspace.selectedSessionIdentity)
      : true;
    onApply(workspace, matchingSessionIds);
    setActiveWorkspaceId(workspace.id);
    const missing = workspace.sessionIdentities.length - matchingSessionIds.length;
    if (missing && hasSelectedIdentity && !selectedStillOpen) {
      setStatus(`Applied ${matchingSessionIds.length} open terminal${matchingSessionIds.length === 1 ? '' : 's'}. ${missing} saved terminal${missing === 1 ? ' is' : 's are'} not open, including the saved selection; nothing was connected or disconnected.`);
      return;
    }
    setStatus(missing
      ? `Applied ${matchingSessionIds.length} open terminal${matchingSessionIds.length === 1 ? '' : 's'}. ${missing} saved terminal${missing === 1 ? ' is' : 's are'} not open; nothing was connected or disconnected.`
      : `Applied ${matchingSessionIds.length} open terminal${matchingSessionIds.length === 1 ? '' : 's'} without changing any connection.`);
  };

  const storageFailureMessage = (error: string): string => {
    switch (error) {
      case 'storage-unavailable':
        return 'Saved workspaces are unavailable because local storage is blocked.';
      case 'storage-read-failed':
        return 'Saved workspaces could not be read from local storage.';
      case 'storage-quota-exceeded':
        return 'Saved workspaces could not be updated because local storage is full.';
      case 'storage-write-failed':
        return 'Saved workspaces could not be updated in local storage.';
      default:
        return 'Saved workspaces could not be updated.';
    }
  };

  const saveWorkspace = () => {
    if (!sessions.length) {
      setStatus('Open a terminal before saving a workspace.');
      return;
    }
    const selected = sessions.find((session) => session.id === selectedSessionId);
    const saved = saveSessionWorkspace({
      name: draftName,
      layout,
      sessionIdentities: sessions.map((session) => session.identity),
      selectedSessionIdentity: selected?.identity ?? null,
    });
    if (!saved.ok) {
      if (saved.error === 'invalid-snapshot') {
        setStatus('Enter a workspace name to save this layout.');
        return;
      }
      setStatus(storageFailureMessage(saved.error));
      return;
    }
    setWorkspaces((current) => [saved.workspace, ...current].slice(0, 30));
    setActiveWorkspaceId(saved.workspace.id);
    setDraftName('');
    setSaving(false);
    setStatus(`Saved “${saved.workspace.name}” locally.`);
  };

  const renameWorkspace = () => {
    if (!activeWorkspace) return;
    const updated = renameSessionWorkspace(activeWorkspace.id, draftName);
    if (!updated.ok) {
      if (updated.error === 'invalid-name') {
        setStatus('Enter a new workspace name to rename it.');
        return;
      }
      if (updated.error === 'missing-workspace') {
        setWorkspaces((current) => current.filter((workspace) => workspace.id !== activeWorkspace.id));
        setActiveWorkspaceId('');
        setRenaming(false);
        setStatus('This saved workspace no longer exists.');
        return;
      }
      setStatus(storageFailureMessage(updated.error));
      return;
    }
    setWorkspaces(updated.workspaces);
    setDraftName('');
    setRenaming(false);
    setStatus(`Renamed workspace to “${updated.workspace.name}”.`);
  };

  const removeWorkspace = () => {
    if (!activeWorkspace || !window.confirm(`Delete the saved workspace “${activeWorkspace.name}”? This does not close any terminals.`)) return;
    const updated = deleteSessionWorkspace(activeWorkspace.id);
    if (!updated.ok) {
      if (updated.error === 'missing-workspace') {
        setWorkspaces((current) => current.filter((workspace) => workspace.id !== activeWorkspace.id));
        setActiveWorkspaceId('');
        setRenaming(false);
        setStatus('This saved workspace was already removed.');
        return;
      }
      setStatus(storageFailureMessage(updated.error));
      return;
    }
    setWorkspaces(updated.workspaces);
    setActiveWorkspaceId('');
    setRenaming(false);
    setStatus(`Deleted “${activeWorkspace.name}”. Open terminals were left unchanged.`);
  };

  return <div className="bt-workspace-manager" aria-label="Saved terminal workspaces">
    <div className="bt-workspace-manager-controls">
      <button className="bt-workspace-save" type="button" disabled={!sessions.length} onClick={() => { setSaving((current) => !current); setRenaming(false); setDraftName(''); }}><BookmarkPlus size={14} /> Save workspace</button>
      <label className="bt-workspace-picker"><span className="sd-visually-hidden">Open saved workspace</span><select value={activeWorkspaceId} onChange={(event) => { const workspace = workspaces.find((candidate) => candidate.id === event.target.value); if (workspace) applyWorkspace(workspace); else { setActiveWorkspaceId(''); if (event.target.value) setStatus('That saved workspace is no longer available.'); } }}><option value="">Saved workspaces{workspaces.length ? ` (${workspaces.length})` : ''}</option>{workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select></label>
      <button type="button" className="bt-workspace-icon" disabled={!activeWorkspace} onClick={() => { if (!activeWorkspace) return; setSaving(false); setRenaming(true); setDraftName(activeWorkspace.name); }} aria-label="Rename saved workspace" title="Rename saved workspace"><Pencil size={13} /></button>
      <button type="button" className="bt-workspace-icon bt-workspace-delete" disabled={!activeWorkspace} onClick={removeWorkspace} aria-label="Delete saved workspace" title="Delete saved workspace"><Trash2 size={13} /></button>
    </div>
    {(isSaving || isRenaming) && <form className="bt-workspace-name-form" onSubmit={(event) => { event.preventDefault(); if (isSaving) saveWorkspace(); else renameWorkspace(); }}><label htmlFor="workspace-name">{isSaving ? 'Workspace name' : 'New name'}</label><input id="workspace-name" autoFocus value={draftName} maxLength={80} placeholder={isSaving ? 'e.g. Bench bring-up' : 'Workspace name'} onChange={(event) => setDraftName(event.target.value)} /><button type="submit">{isSaving ? 'Save' : 'Rename'}</button><button type="button" className="bt-workspace-cancel" onClick={() => { setSaving(false); setRenaming(false); setDraftName(''); }} aria-label="Cancel"><X size={13} /></button></form>}
    {status && <p className="bt-workspace-status" role="status"><FolderOpen size={13} /> {status}</p>}
  </div>;
}
