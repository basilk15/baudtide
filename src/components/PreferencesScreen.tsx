import { useState } from 'react';
import { Check, FolderOpen, RotateCcw, Settings2 } from 'lucide-react';
import './phase3-controls.css';

type PreferenceValues = {
  baud: string;
  lineEnding: string;
  encoding: string;
  timestamps: boolean;
  theme: string;
  reconnect: boolean;
  storagePath: string;
  storageLimit: string;
};

const defaults: PreferenceValues = {
  baud: '115200', lineEnding: 'LF (\\n)', encoding: 'UTF-8', timestamps: true,
  theme: 'System', reconnect: true, storagePath: '~/Documents/SignalDeck', storageLimit: '10 GB',
};

/** A settings form with intentionally local, non-persisted preview state. */
export function PreferencesScreen() {
  const [values, setValues] = useState(defaults);
  const [saved, setSaved] = useState(false);
  const update = <K extends keyof PreferenceValues>(key: K, value: PreferenceValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  const save = () => { setSaved(true); window.setTimeout(() => setSaved(false), 2600); };

  return (
    <section className="sd-preferences" aria-labelledby="preferences-heading">
      <div className="sd-screen-heading"><span className="sd-section-icon"><Settings2 size={19} /></span><div><p>LOCAL UI PREVIEW</p><h1 id="preferences-heading">Preferences</h1><small>Changes are held only in this screen until the settings backend is added.</small></div></div>
      <div className="sd-settings-grid">
        <fieldset className="sd-settings-card"><legend>Serial defaults</legend>
          <label>Default baud rate<select value={values.baud} onChange={(e) => update('baud', e.target.value)}><option>9600</option><option>57600</option><option>115200</option><option>230400</option></select></label>
          <label>Line ending<select value={values.lineEnding} onChange={(e) => update('lineEnding', e.target.value)}><option>LF (\n)</option><option>CRLF (\r\n)</option><option>CR (\r)</option><option>None</option></select></label>
          <label>Encoding<select value={values.encoding} onChange={(e) => update('encoding', e.target.value)}><option>UTF-8</option><option>ASCII</option><option>Hexadecimal</option></select></label>
          <Toggle label="Show timestamps by default" checked={values.timestamps} onChange={(value) => update('timestamps', value)} />
        </fieldset>
        <fieldset className="sd-settings-card"><legend>Appearance & reconnect</legend>
          <label>Theme<select value={values.theme} onChange={(e) => update('theme', e.target.value)}><option>System</option><option>Dark</option><option>Light</option></select></label>
          <Toggle label="Reconnect when a device returns" checked={values.reconnect} onChange={(value) => update('reconnect', value)} />
          <p className="sd-field-hint">A future serial backend will control reconnect attempts.</p>
        </fieldset>
        <fieldset className="sd-settings-card sd-storage-settings"><legend>Local storage</legend>
          <label>Log folder<div className="sd-path-control"><input value={values.storagePath} onChange={(e) => update('storagePath', e.target.value)} /><button type="button" aria-label="Choose mock log folder" title="Folder picker will be connected later"><FolderOpen size={17} /></button></div></label>
          <label>Storage limit<select value={values.storageLimit} onChange={(e) => update('storageLimit', e.target.value)}><option>2 GB</option><option>5 GB</option><option>10 GB</option><option>25 GB</option></select></label>
          <p className="sd-field-hint">No files will be created, moved, or removed by this UI.</p>
        </fieldset>
      </div>
      <div className="sd-settings-actions"><button className="sd-secondary-button" onClick={() => { setValues(defaults); setSaved(false); }}><RotateCcw size={16} /> Reset preview</button><button className="sd-primary-button" onClick={save}>{saved ? <><Check size={16} /> Saved locally for preview</> : 'Save mock preferences'}</button></div>
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="sd-toggle-row"><span>{label}</span><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><i aria-hidden="true" /></label>;
}
