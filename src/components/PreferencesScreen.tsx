import { useState } from 'react';
import { Check, FolderOpen, Moon, RotateCcw, Settings2, Sun } from 'lucide-react';
import { ThemedSelect } from './ThemedSelect';
import './phase3-controls.css';

type PreferenceValues = {
  baud: string;
  lineEnding: string;
  encoding: string;
  timestamps: boolean;
  reconnect: boolean;
  storagePath: string;
  storageLimit: string;
};

const defaults: PreferenceValues = {
  baud: '115200', lineEnding: 'LF (\\n)', encoding: 'UTF-8', timestamps: true,
  reconnect: true, storagePath: '', storageLimit: '10 GB',
};

export function PreferencesScreen({ theme, onThemeChange }: { theme: 'dark' | 'light'; onThemeChange: (theme: 'dark' | 'light') => void }) {
  const [values, setValues] = useState(defaults);
  const [saved, setSaved] = useState(false);
  const update = <K extends keyof PreferenceValues>(key: K, value: PreferenceValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  const save = () => { setSaved(true); window.setTimeout(() => setSaved(false), 2600); };

  return (
    <section className="sd-preferences" aria-labelledby="preferences-heading">
      <div className="sd-screen-heading"><span className="sd-section-icon"><Settings2 size={19} /></span><div><p>APPLICATION SETTINGS</p><h1 id="preferences-heading">Preferences</h1><small>Settings persistence will be added with the local workspace store.</small></div></div>
      <div className="sd-settings-grid">
        <fieldset className="sd-settings-card"><legend>Serial defaults</legend>
          <label>Default baud rate<ThemedSelect label="Default baud rate" value={values.baud} onChange={(value) => update('baud', value)} placeholder="Select a baud rate" options={['9600', '57600', '115200', '230400'].map((value) => ({ value, label: `${Number(value).toLocaleString()} baud` }))} /></label>
          <label>Line ending<ThemedSelect label="Line ending" value={values.lineEnding} onChange={(value) => update('lineEnding', value)} placeholder="Select line ending" options={[{ value: 'LF (\\n)', label: 'LF (\\n)' }, { value: 'CRLF (\\r\\n)', label: 'CRLF (\\r\\n)' }, { value: 'CR (\\r)', label: 'CR (\\r)' }, { value: 'None', label: 'None' }]} /></label>
          <label>Encoding<ThemedSelect label="Encoding" value={values.encoding} onChange={(value) => update('encoding', value)} placeholder="Select encoding" options={['UTF-8', 'ASCII', 'Hexadecimal'].map((value) => ({ value, label: value }))} /></label>
          <Toggle label="Show timestamps by default" checked={values.timestamps} onChange={(value) => update('timestamps', value)} />
        </fieldset>
        <fieldset className="sd-settings-card"><legend>Appearance & reconnect</legend>
          <div className="sd-theme-setting"><div><strong>Theme</strong><span>Choose the workspace appearance.</span></div><div className="sd-theme-switcher" role="group" aria-label="Application theme"><button type="button" className={theme === 'dark' ? 'is-active' : ''} aria-pressed={theme === 'dark'} onClick={() => { onThemeChange('dark'); setSaved(false); }}><Moon size={14} /> Dark</button><button type="button" className={theme === 'light' ? 'is-active' : ''} aria-pressed={theme === 'light'} onClick={() => { onThemeChange('light'); setSaved(false); }}><Sun size={14} /> Light</button></div></div>
          <Toggle label="Reconnect when a device returns" checked={values.reconnect} onChange={(value) => update('reconnect', value)} />
          <p className="sd-field-hint">Reconnect behavior will be controlled by the session manager.</p>
        </fieldset>
        <fieldset className="sd-settings-card sd-storage-settings"><legend>Local storage</legend>
          <label>Log folder<div className="sd-path-control"><input value={values.storagePath} onChange={(e) => update('storagePath', e.target.value)} placeholder="Use SignalDeck's default log location" /><button type="button" aria-label="Choose log folder" title="Folder picker will be connected later"><FolderOpen size={17} /></button></div></label>
          <label>Storage limit<ThemedSelect label="Storage limit" value={values.storageLimit} onChange={(value) => update('storageLimit', value)} placeholder="Select a storage limit" options={['2 GB', '5 GB', '10 GB', '25 GB'].map((value) => ({ value, label: value }))} /></label>
          <p className="sd-field-hint">No files will be created, moved, or removed by this UI.</p>
        </fieldset>
      </div>
      <div className="sd-settings-actions"><button className="sd-secondary-button" onClick={() => { setValues(defaults); onThemeChange('dark'); setSaved(false); }}><RotateCcw size={16} /> Reset settings</button><button className="sd-primary-button" onClick={save}>{saved ? <><Check size={16} /> Saved for this session</> : 'Save preferences'}</button></div>
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="sd-toggle-row"><span>{label}</span><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><i aria-hidden="true" /></label>;
}
