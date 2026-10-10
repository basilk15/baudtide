import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, X } from 'lucide-react';
import { planBenchRestore, type BenchConnectionPreset, type BenchOpenSession } from '../lib/benchSetup';
import type { NativeSerialPort } from '../lib/serial';
import type { SavedSessionWorkspace } from '../lib/sessionWorkspaces';
import { ThemedSelect } from './ThemedSelect';
import './bench-restore.css';

export type BenchRestoreChoice = { preset: BenchConnectionPreset; port: string; existingId?: string; reviewed: boolean };
export function BenchRestoreDialog({ workspace, sessions, scan, onRestore, onClose }: {
  workspace: SavedSessionWorkspace; sessions: BenchOpenSession[]; scan: () => Promise<NativeSerialPort[]>;
  onRestore: (choices: BenchRestoreChoice[]) => Promise<string>; onClose: () => void;
}) {
  const [ports, setPorts] = useState<NativeSerialPort[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const scanGeneration = useRef(0);
  async function rescan() {
    const generation = ++scanGeneration.current;
    setScanning(true); setMessage(''); setChoices({});
    try { const found = await scan(); if (mounted.current && generation === scanGeneration.current) setPorts(found); }
    catch (error) { if (mounted.current && generation === scanGeneration.current) setMessage(error instanceof Error ? error.message : 'Could not scan devices. Try again.'); }
    finally { if (mounted.current && generation === scanGeneration.current) setScanning(false); }
  }
  useEffect(() => {
    mounted.current = true; dialog.current?.showModal(); void rescan();
    return () => { mounted.current = false; scanGeneration.current += 1; };
  }, []);
  const rows = planBenchRestore(workspace.connections ?? [], ports, sessions);
  const selected = rows.flatMap<BenchRestoreChoice>((row) => {
    if (row.status === 'open') return [{ preset: row.preset, port: '', existingId: row.existingId, reviewed: false }];
    const port = choices[row.preset.identity] ?? row.suggestedPort;
    return port && row.status !== 'conflict' && row.status !== 'missing'
      ? [{ preset: row.preset, port, existingId: row.existingId, reviewed: Boolean(choices[row.preset.identity]) }] : [];
  });
  const duplicates = selected.some((choice, index) => choice.port && selected.some((other, otherIndex) => otherIndex !== index && other.port === choice.port));
  async function restore() {
    if (inFlight.current || scanning || duplicates) return;
    inFlight.current = true; setBusy(true); setMessage('');
    try { const result = await onRestore(selected); if (mounted.current) setMessage(result); }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Could not restore this setup.'); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  return <dialog ref={dialog} className="bt-bench-dialog" aria-labelledby="bench-restore-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div><h2 id="bench-restore-title">Restore {workspace.name}</h2><p>Review the devices below. Open terminals keep their current settings; selected devices start new captures.</p></div><button type="button" className="sd-secondary-button" disabled={busy} onClick={onClose} aria-label="Close restore setup"><X size={16} /></button></header>
    <div className="bt-bench-rows" aria-busy={scanning || busy}>{rows.map((row) => <section key={row.preset.identity}>
      <div><strong>{row.preset.sessionName}</strong><small>{row.preset.port} · {row.preset.baudRate.toLocaleString()} baud · {row.preset.settings.dataBits}{row.preset.settings.parity === 'none' ? 'N' : row.preset.settings.parity === 'even' ? 'E' : 'O'}{row.preset.settings.stopBits === 'one' ? '1' : '2'}</small><p>{scanning ? 'Checking device availability…' : row.detail}</p></div>
      {row.status === 'open' ? <span>Already open</span> : row.status === 'review' || row.status === 'ready' ? <ThemedSelect label={`Port for ${row.preset.sessionName}`} value={choices[row.preset.identity] ?? row.suggestedPort} placeholder="Skip this device" disabled={busy || scanning} options={[{ value: '', label: 'Skip this device' }, ...(row.candidates.length ? row.candidates.map((p) => ({ value: p.path, label: `${p.path} · ${p.label}` })) : [{ value: row.preset.port, label: `Confirm ${row.preset.port}` }])]} onChange={(port) => setChoices((current) => ({ ...current, [row.preset.identity]: port }))} /> : <span>{row.status === 'missing' ? 'Missing' : 'Needs attention'}</span>}
    </section>)}</div>
    {workspace.analysisWorkspaceId && <p>The linked saved analysis will load with its signals, decoders, watches, and capture ranges.</p>}
    {duplicates && <p role="alert">Choose a different port for each terminal.</p>}
    <p className="bt-bench-result" role="status">{message}</p>
    <footer><button className="sd-secondary-button" type="button" disabled={busy || scanning} onClick={() => void rescan()}><RefreshCw size={14} /> Rescan</button><button className="sd-primary-button" type="button" disabled={busy || scanning || duplicates || (!selected.length && !workspace.analysisWorkspaceId)} onClick={() => void restore()}>{busy && <LoaderCircle size={14} className="sd-spin" />} {busy ? 'Restoring…' : 'Restore selected'}</button><button className="sd-secondary-button" type="button" disabled={busy} onClick={onClose}>Done</button></footer>
  </dialog>;
}
