import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { CommandRepeater, commandBytes, loadCommandPresets, saveCommandPresets, MAX_COMMAND_PRESETS, type SerialCommand } from '../lib/serialCommands';
import { ThemedSelect } from './ThemedSelect';
import './bench-tools.css';

type Props = {
  identity: string;
  stopRef: RefObject<(() => void) | null>;
  sessionId?: string;
  enabled: boolean;
  draft: Pick<SerialCommand, 'payload' | 'mode' | 'lineEnding'>;
  onLoad: (command: SerialCommand) => void;
  onSend: (command: SerialCommand) => Promise<void>;
  onRepeatingChange: (active: boolean) => void;
};

export function CommandPresetsPanel({ stopRef, identity, sessionId, enabled, draft, onLoad, onSend, onRepeatingChange }: Props) {
  const [presets, setPresets] = useState<SerialCommand[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [interval, setInterval] = useState('1');
  const [repeating, setRepeating] = useState(false);
  const [status, setStatus] = useState('');
  const [readable, setReadable] = useState(true);
  const repeater = useRef(new CommandRepeater());
  const onRepeatingChangeRef = useRef(onRepeatingChange);
  onRepeatingChangeRef.current = onRepeatingChange;
  const stop = () => { repeater.current.stop(); setRepeating(false); onRepeatingChangeRef.current(false); };
  stopRef.current = stop;
  useLayoutEffect(() => {
    stop();
    return () => { repeater.current.stop(); onRepeatingChangeRef.current(false); };
  }, [identity, sessionId, enabled]);
  useEffect(() => {
    const reload = () => {
      try { setPresets(loadCommandPresets(identity)); setReadable(true); }
      catch { setReadable(false); setStatus('Command storage is unavailable or damaged. Existing presets have been preserved.'); }
    };
    setSelectedId(''); setName(''); setStatus(''); reload();
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === identity) reload(); };
    window.addEventListener('baudtide:command-presets', changed);
    return () => window.removeEventListener('baudtide:command-presets', changed);
  }, [identity]);

  const save = () => {
    try {
      if (!name.trim()) throw new Error('Give this command a name.');
      commandBytes(draft);
      const command: SerialCommand = { ...draft, id: crypto.randomUUID(), name: name.trim() };
      saveCommandPresets(identity, [...loadCommandPresets(identity), command]);
      setSelectedId(command.id); setName(''); setStatus(`Saved ${command.name}.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not save the command.'); }
  };
  const remove = () => {
    const selected = presets.find((p) => p.id === selectedId);
    if (!selected || !window.confirm(`Delete command preset “${selected.name}”?`)) return;
    try { saveCommandPresets(identity, loadCommandPresets(identity).filter((p) => p.id !== selectedId)); setSelectedId(''); setStatus(`Deleted ${selected.name}.`); }
    catch { setStatus('Could not delete the preset. Existing presets have been preserved.'); }
  };
  const start = () => {
    try {
      commandBytes(draft);
      const command: SerialCommand = { ...draft, id: 'repeat', name: 'Repeated command' };
      const intervalMs = Number(interval) * 1000;
      setStatus(''); setRepeating(true); onRepeatingChangeRef.current(true);
      repeater.current.start(() => onSend(command), intervalMs, (error) => {
        setRepeating(false); onRepeatingChangeRef.current(false);
        setStatus(`Repeat stopped: ${error instanceof Error ? error.message : 'send failed'}`);
      });
    } catch (error) { stop(); setStatus(error instanceof Error ? error.message : 'Could not start repeating.'); }
  };
  return <div className="bt-command-tools" aria-label="Command presets and repeat sending">
    <details>
      <summary>Command presets {presets.length > 0 && <span>({presets.length})</span>}</summary>
      <div className="bt-command-controls">
        <ThemedSelect compact label="Saved command" value={selectedId} placeholder="Choose a saved command" options={presets.map((p) => ({ value: p.id, label: `${p.name} · ${p.mode}` }))} onChange={(id) => { stop(); setSelectedId(id); const command = presets.find((p) => p.id === id); if (command) { onLoad(command); setStatus(`Loaded ${command.name}; press Send to transmit.`); } }} />
        <button type="button" onClick={remove} disabled={!readable || !selectedId || repeating}>Delete preset…</button>
        <label>Preset name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="e.g. Read calibration" /></label>
        <button type="button" onClick={save} disabled={!readable || !draft.payload.trim() || !name.trim() || presets.length >= MAX_COMMAND_PRESETS || repeating}>Save current command</button>
      </div>
      {!presets.length && <p>Save text or hex commands with their line ending. Presets are included when saving a bench setup.</p>}
    </details>
    <div className={`bt-command-repeat${repeating ? ' is-running' : ''}`}>
      <label>Repeat every<input type="number" min="0.1" max="3600" step="0.1" value={interval} onChange={(event) => setInterval(event.target.value)} disabled={repeating} /> seconds</label>
      {repeating ? <button type="button" className="bt-repeat-stop" onClick={() => { stop(); setStatus('Repeat stopped.'); }}>Stop repeating</button>
        : <button type="button" onClick={start} disabled={!enabled || !draft.payload.trim()}>Start repeating</button>}
      <span>{repeating ? 'Sending the fixed command. Stop remains available during a write.' : 'Stops on disconnect, send error, or hiding this terminal. Never starts automatically.'}</span>
    </div>
    {status && <p role="status">{status}</p>}
  </div>;
}
