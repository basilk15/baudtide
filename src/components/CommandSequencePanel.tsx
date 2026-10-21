import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { ArrowDown, ArrowUp, Check, CirclePlay, ListChecks, Plus, Square, Trash2, X } from 'lucide-react';
import { CommandSequenceRunner, loadCommandSequences, saveCommandSequences, MAX_COMMAND_SEQUENCES, MAX_SEQUENCE_STEPS,
  type CommandSequence, type CommandStep, type SequenceRunState } from '../lib/commandSequences';
import { recordCommandEvent } from '../lib/benchEvents';
import type { SerialCommand } from '../lib/serialCommands';
import type { SerialDataEvent } from '../lib/serial';
import { ThemedSelect } from './ThemedSelect';
import './bench-workflows.css';

function newStep(draft?: Pick<SerialCommand, 'payload' | 'mode' | 'lineEnding'>): CommandStep {
  return { id: crypto.randomUUID(), name: '', command: draft ? { ...draft } : { payload: '', mode: 'text', lineEnding: 'lf' }, expect: '', timeoutMs: 5000, delayMs: 0 };
}
const emptyRun: SequenceRunState = { running: false, name: '', status: '', steps: [] };
export function CommandSequencePanel({ identity, sessionId, capturePath, sourceName, enabled, blocked, draft, observerRef, stopRef, onSend, onRunningChange }: {
  identity: string; sessionId?: string; capturePath?: string; sourceName: string; enabled: boolean; blocked: boolean;
  draft: Pick<SerialCommand, 'payload' | 'mode' | 'lineEnding'>;
  observerRef: MutableRefObject<((event: SerialDataEvent) => void) | null>; stopRef: MutableRefObject<(() => void) | null>;
  onSend: (command: Pick<SerialCommand, 'payload' | 'mode' | 'lineEnding'>) => Promise<void>; onRunningChange: (running: boolean) => void;
}) {
  const [sequences, setSequences] = useState<CommandSequence[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [editing, setEditing] = useState<CommandSequence | null>(null);
  const [readable, setReadable] = useState(false);
  const [error, setError] = useState('');
  const [run, setRun] = useState<SequenceRunState>(emptyRun);
  const [open, setOpen] = useState(false);
  const runningChange = useRef(onRunningChange); runningChange.current = onRunningChange;
  const mounted = useRef(true);
  const [runner] = useState(() => new CommandSequenceRunner((next) => {
    if (mounted.current) setRun(next);
    runningChange.current(next.running);
  }));
  observerRef.current = (event) => runner.observe(event);
  stopRef.current = () => runner.stop();
  useLayoutEffect(() => {
    if (!enabled) runner.stop('Sequence stopped because this terminal was hidden or disconnected.');
    return () => runner.stop('Sequence stopped because this terminal was hidden, disconnected, or closed.');
  }, [enabled, identity, sessionId, runner]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; observerRef.current = null; stopRef.current = null; runner.stop('Sequence stopped because its terminal closed.'); };
  }, [runner]);
  useEffect(() => {
    const reload = () => {
      try { setSequences(loadCommandSequences(identity)); setReadable(true); }
      catch (e) { setReadable(false); setError(e instanceof Error ? e.message : 'Could not load command sequences.'); }
    };
    setSelectedId(''); setEditing(null); setRun(emptyRun); setError(''); reload();
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === identity) reload(); };
    window.addEventListener('baudtide:command-sequences', changed);
    return () => window.removeEventListener('baudtide:command-sequences', changed);
  }, [identity]);
  const selected = sequences.find((seq) => seq.id === selectedId);
  const locked = run.running;
  const patchStep = (id: string, patch: Partial<CommandStep>) => setEditing((seq) => seq ? { ...seq, steps: seq.steps.map((s) => s.id === id ? { ...s, ...patch } : s) } : null);
  const moveStep = (index: number, direction: number) => setEditing((seq) => {
    if (!seq) return null;
    const steps = [...seq.steps]; [steps[index], steps[index + direction]] = [steps[index + direction], steps[index]];
    return { ...seq, steps };
  });
  const save = () => {
    if (!editing || !readable || locked) return;
    try {
      const next = [...loadCommandSequences(identity).filter((seq) => seq.id !== editing.id), editing];
      saveCommandSequences(identity, next); setSequences(next); setSelectedId(editing.id); setEditing(null); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the sequence.'); }
  };
  const start = () => {
    if (!selected || !sessionId || !capturePath || !enabled || !readable || blocked || runner.running) return;
    setError(''); setOpen(true);
    void runner.run(selected, { sessionId, capturePath, sourceName }, onSend, recordCommandEvent)
      .catch((e: Error) => setError(e.message));
  };
  return <details className="bt-bench-tool bt-command-sequences" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary><ListChecks size={16} /><span>Command sequences</span><small>{run.running ? 'Running' : `${sequences.length} saved`}</small></summary>
    <div className="bt-tool-body">
      <div className="bt-tool-heading"><p>Run a repeatable bench procedure. Each step sends a command, checks its response, then waits before continuing.</p>
        <button type="button" className="sd-secondary-button" disabled={locked || !readable || sequences.length >= MAX_COMMAND_SEQUENCES} onClick={() => { setEditing({ id: crypto.randomUUID(), name: '', steps: [newStep(draft)] }); setError(''); }}><Plus size={14} /> New sequence</button></div>
      <div className="bt-sequence-launcher"><ThemedSelect compact label="Saved command sequence" value={selectedId} placeholder="Choose a saved sequence" disabled={locked || !readable || !!editing} options={sequences.map((seq) => ({ value: seq.id, label: `${seq.name} · ${seq.steps.length} steps` }))} onChange={setSelectedId} />
        {selected && <button type="button" className="sd-secondary-button" disabled={locked || !readable || !!editing} onClick={() => { setEditing(structuredClone(selected)); setError(''); }}>Edit sequence</button>}
        {locked ? <button type="button" className="sd-secondary-button bt-sequence-stop" onClick={() => runner.stop()}><Square size={14} /> Stop sequence</button>
          : <button type="button" className="sd-primary-button" disabled={!selected || !enabled || !readable || blocked || !!editing || !capturePath} onClick={start}><CirclePlay size={15} /> Run sequence</button>}
      </div>
      {!sequences.length && !editing && <p className="bt-tool-empty">Start with the command in your composer, then add the rest of your test procedure.</p>}
      {error && <p className="bt-tool-error" role="alert">{error}</p>}
      {editing && <form className="bt-tool-form bt-sequence-editor" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label>Sequence name<input autoFocus required maxLength={80} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. Sensor calibration check" /></label>
        <ol className="bt-sequence-steps">{editing.steps.map((step, index) => <li key={step.id}>
          <div className="bt-sequence-step-heading"><span className="bt-sequence-number">{index + 1}</span><label>Step name<input required maxLength={80} value={step.name} onChange={(e) => patchStep(step.id, { name: e.target.value })} placeholder="e.g. Read calibration" /></label>
            <div className="bt-sequence-order"><button type="button" className="sd-secondary-button" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => moveStep(index, -1)}><ArrowUp size={14} /></button>
              <button type="button" className="sd-secondary-button" aria-label={`Move step ${index + 1} down`} disabled={index === editing.steps.length - 1} onClick={() => moveStep(index, 1)}><ArrowDown size={14} /></button>
              <button type="button" className="sd-secondary-button" aria-label={`Remove step ${index + 1}`} disabled={editing.steps.length === 1} onClick={() => { if (window.confirm(`Remove step ${index + 1}${step.name ? ` “${step.name}”` : ''} from this draft?`)) setEditing({ ...editing, steps: editing.steps.filter((s) => s.id !== step.id) }); }}><Trash2 size={14} /></button></div>
          </div>
          <div className="bt-sequence-command"><label>Command<input required maxLength={65536} value={step.command.payload} onChange={(e) => patchStep(step.id, { command: { ...step.command, payload: e.target.value } })} placeholder={step.command.mode === 'hex' ? 'e.g. AA 01 FF' : 'e.g. read_calibration'} /></label>
            <label>Mode<ThemedSelect compact label={`Step ${index + 1} send mode`} value={step.command.mode} options={[{ value: 'text', label: 'Text' }, { value: 'hex', label: 'Hex' }]} placeholder="Text" onChange={(mode) => patchStep(step.id, { command: { ...step.command, mode: mode as 'text' | 'hex' } })} /></label>
            <label>Line ending<ThemedSelect compact label={`Step ${index + 1} line ending`} value={step.command.lineEnding} disabled={step.command.mode === 'hex'} options={[{ value: 'lf', label: 'LF' }, { value: 'crlf', label: 'CRLF' }, { value: 'cr', label: 'CR' }, { value: 'none', label: 'None' }]} placeholder="LF" onChange={(lineEnding) => patchStep(step.id, { command: { ...step.command, lineEnding: lineEnding as SerialCommand['lineEnding'] } })} /></label></div>
          <div className="bt-tool-fields"><label>Response contains <span className="bt-tool-inline-hint">optional · case sensitive</span><input maxLength={256} value={step.expect} onChange={(e) => patchStep(step.id, { expect: e.target.value })} placeholder="e.g. calibration_ok" /></label>
            <label>Response timeout (seconds)<input type="number" min="0.1" max="3600" step="0.1" required value={Number.isFinite(step.timeoutMs) ? step.timeoutMs / 1000 : ''} onChange={(e) => patchStep(step.id, { timeoutMs: e.target.value === '' ? NaN : Math.round(Number(e.target.value) * 1000) })} /></label>
            <label>Wait after step (seconds)<input type="number" min="0" max="3600" step="0.1" required value={Number.isFinite(step.delayMs) ? step.delayMs / 1000 : ''} onChange={(e) => patchStep(step.id, { delayMs: e.target.value === '' ? NaN : Math.round(Number(e.target.value) * 1000) })} /></label></div>
        </li>)}</ol>
        <div className="bt-tool-actions"><button type="button" className="sd-secondary-button" disabled={editing.steps.length >= MAX_SEQUENCE_STEPS} onClick={() => setEditing({ ...editing, steps: [...editing.steps, newStep()] })}><Plus size={14} /> Add step</button>
          <button type="submit" className="sd-primary-button"><Check size={14} /> Save sequence</button><button type="button" className="sd-secondary-button" onClick={() => setEditing(null)}><X size={14} /> Cancel</button></div>
      </form>}
      {run.steps.length > 0 && <section className="bt-sequence-results" aria-label="Sequence results"><header><strong>{run.name}</strong><span role="status">{run.status}</span></header>
        <ol>{run.steps.map((step, index) => <li key={step.stepId} data-state={step.state}><span className="bt-sequence-number">{step.state === 'passed' ? <Check size={14} /> : index + 1}</span>
          <span><strong>{step.name}</strong><small>{step.detail || 'Waiting for previous step'}</small></span><span className="bt-sequence-state">{step.state}</span>{step.timestamp && <time dateTime={step.timestamp}>{new Date(step.timestamp).toLocaleTimeString()}</time>}</li>)}</ol>
      </section>}
      <p className="bt-tool-footnote">Run starts only when you press Run sequence. Stops on a failed response, disconnect, or hiding this terminal. Step results are saved with the capture. Text matching also works across serial chunks.</p>
    </div>
  </details>;
}
