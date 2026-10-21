import { useEffect, useId, useRef, useState } from 'react';
import { BellRing, Plus, TextSearch, X } from 'lucide-react';
import { listenDesktop } from '../lib/desktop';
import { logRuleSnapshot, putLogRule } from '../lib/benchEvents';
import type { LogRule, LogRuleSnapshot } from '../lib/logRules';
import './bench-workflows.css';

export function LogRulesPanel({ identity, sourceName, enabled }: { identity: string; sourceName: string; enabled: boolean }) {
  const id = useId();
  const [snapshot, setSnapshot] = useState<LogRuleSnapshot>({ rules: [], error: '', interruption: '' });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [cooldown, setCooldown] = useState('30');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [desktopAlert, setDesktopAlert] = useState(true);
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  useEffect(() => {
    let mounted = true;
    setLoaded(false); setEditing(null); setError('');
    const apply = (next: LogRuleSnapshot) => { if (mounted) { setSnapshot((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next); setLoaded(true); } };
    const unlisten = listenDesktop<LogRuleSnapshot>('log-state', apply);
    void logRuleSnapshot().then(apply).catch((e: Error) => { if (mounted) setError(e.message); });
    return () => { mounted = false; unlisten(); };
  }, [identity]);
  const rules = snapshot.rules.filter((rule) => rule.identity === identity);
  const save = async (rule: LogRule) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await putLogRule(rule);
      const next = await logRuleSnapshot();
      if (currentIdentity.current === rule.identity) { setSnapshot(next); setEditing(null); }
    } catch (e) { if (currentIdentity.current === rule.identity) setError(e instanceof Error ? e.message : 'Could not save the log rule.'); }
    finally { setBusy(false); }
  };
  return <details className="bt-bench-tool bt-log-rules">
    <summary><TextSearch size={16} /><span>Log event rules</span><small>{rules.filter((r) => r.enabled).length} armed</small></summary>
    <div className="bt-tool-body">
      <div className="bt-tool-heading"><p>Turn serial messages into capture markers and alerts, even while the terminal is hidden.</p>
        <button type="button" className="sd-secondary-button" disabled={!enabled || !loaded || busy || !!snapshot.error} onClick={() => {
          setEditing('new'); setName(''); setPattern(''); setCooldown('30'); setCaseSensitive(false); setDesktopAlert(true); setError('');
        }}><Plus size={14} /> Add rule</button></div>
      {(error || snapshot.error) && <div><p role="alert" className="bt-tool-error">{error || snapshot.error}</p><button type="button" className="sd-secondary-button" disabled={busy} onClick={() => {
        setBusy(true); void logRuleSnapshot().then((next) => { setSnapshot(next); setLoaded(true); setError(''); })
          .catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
      }}>Retry monitoring</button></div>}
      {snapshot.interruption && <p className="bt-tool-warning">{snapshot.interruption}</p>}
      {rules.length > 0 && <ul className="bt-rule-list">{rules.map((rule) => <li key={rule.id}>
        <label className="bt-tool-check"><input type="checkbox" aria-label={`Arm ${rule.name}`} checked={rule.enabled} disabled={!enabled || busy} onChange={(e) => void save({ ...rule, enabled: e.target.checked })} /><span><strong>{rule.name}</strong><code>{rule.pattern}</code></span></label>
        <span className="bt-rule-meta">{rule.desktopAlert && <BellRing size={13} aria-label="Desktop alert enabled" />}{rule.cooldownMs / 1000}s cooldown</span>
        <button type="button" className="sd-secondary-button" disabled={!enabled || busy} onClick={() => {
          setEditing(rule.id); setName(rule.name); setPattern(rule.pattern); setCooldown(String(rule.cooldownMs / 1000)); setCaseSensitive(rule.caseSensitive); setDesktopAlert(rule.desktopAlert);
        }}>Edit</button>
      </li>)}</ul>}
      {!rules.length && !editing && <p className="bt-tool-empty">No log rules yet. Try matching “panic”, “watchdog”, or a message from your firmware.</p>}
      {editing && <form className="bt-tool-form" id={id} onSubmit={(e) => { e.preventDefault(); void save({ id: editing === 'new' ? crypto.randomUUID() : editing,
        identity, sourceName, name, pattern, cooldownMs: cooldown.trim() ? Number(cooldown) * 1000 : NaN, caseSensitive, desktopAlert,
        enabled: snapshot.rules.find((r) => r.id === editing)?.enabled ?? true }); }}>
        <div className="bt-tool-fields"><label>Rule title<input autoFocus required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Watchdog reset" /></label>
          <label>Text to match<input required maxLength={256} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. watchdog" /></label>
          <label>Cooldown (seconds)<input type="number" required min="1" max="86400" step="1" value={cooldown} onChange={(e) => setCooldown(e.target.value)} /></label></div>
        <div className="bt-tool-actions"><label className="bt-tool-check"><input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> Match case</label>
          <label className="bt-tool-check"><input type="checkbox" checked={desktopAlert} onChange={(e) => setDesktopAlert(e.target.checked)} /> Desktop alert</label>
          <button type="submit" className="sd-primary-button" disabled={busy || !enabled}>{busy ? 'Saving…' : 'Save rule'}</button>
          <button type="button" className="sd-secondary-button" disabled={busy} onClick={() => setEditing(null)}><X size={14} /> Cancel</button></div>
        <p className="bt-tool-footnote">Matches complete lines as plain text. A match creates an event; the cooldown suppresses repeated matches. Disable a rule to pause it.</p>
      </form>}
      {!enabled && <p className="bt-tool-footnote">Open BaudTide on the desktop to configure log rules.</p>}
    </div>
  </details>;
}
