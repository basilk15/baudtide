import { useEffect, useState } from 'react';
import { AlertTriangle, Check, FolderOpen, HardDrive, LoaderCircle, Moon, RefreshCw, RotateCcw, Settings2, Sun } from 'lucide-react';
import { defaultPreferences, logDirectoryValidationError, type BaudTidePreferences, type DisplayEncoding, type LineEnding } from '../lib/preferences';
import { listNativeSavedLogs } from '../lib/serial';
import { ThemedSelect } from './ThemedSelect';
import './phase3-controls.css';

const storageLimits = [2, 5, 10, 25].map((gigabytes) => ({ value: gigabytes * 1024 ** 3, label: `${gigabytes} GB` }));

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

type PreferencesScreenProps = {
  preferences: BaudTidePreferences;
  nativeEnabled: boolean;
  onSave: (settings: BaudTidePreferences) => Promise<void>;
  onThemePreview: (theme: BaudTidePreferences['appearance']['theme']) => void;
  onChooseLogDirectory: () => Promise<string | null>;
};

export function PreferencesScreen({ preferences, nativeEnabled, onSave, onThemePreview, onChooseLogDirectory }: PreferencesScreenProps) {
  const [draft, setDraft] = useState(preferences);
  const [notice, setNotice] = useState('');
  const [saveError, setSaveError] = useState('');
  const [isSaving, setSaving] = useState(false);
  const [isChoosingDirectory, setChoosingDirectory] = useState(false);
  const [storedBytes, setStoredBytes] = useState<number | null>(null);
  const [storageError, setStorageError] = useState('');
  const [isRefreshingStorage, setRefreshingStorage] = useState(false);

  useEffect(() => {
    setDraft(preferences);
  }, [preferences]);

  const refreshStorageUsage = async () => {
    if (!nativeEnabled) return;
    setRefreshingStorage(true);
    try {
      const logs = await listNativeSavedLogs();
      setStoredBytes(logs.reduce((total, log) => total + log.sizeBytes, 0));
      setStorageError('');
    } catch {
      setStorageError('Could not read local capture usage.');
    } finally {
      setRefreshingStorage(false);
    }
  };

  useEffect(() => {
    if (!nativeEnabled) {
      setStoredBytes(null);
      setStorageError('');
      return;
    }
    void refreshStorageUsage();
    const timer = window.setInterval(() => void refreshStorageUsage(), 5_000);
    return () => window.clearInterval(timer);
    // The polling keeps an active raw capture's displayed size useful without changing it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeEnabled]);

  const update = (change: Partial<BaudTidePreferences['serial']> | Partial<BaudTidePreferences['storage']>, section: 'serial' | 'storage') => {
    setDraft((current) => ({ ...current, [section]: { ...current[section], ...change } }));
    setNotice('');
    setSaveError('');
  };
  const changeTheme = (theme: BaudTidePreferences['appearance']['theme']) => {
    setDraft((current) => ({ ...current, appearance: { theme } }));
    onThemePreview(theme);
    setNotice('');
    setSaveError('');
  };
  const persist = async (next: BaudTidePreferences, message: string) => {
    const validationError = logDirectoryValidationError(next.storage.logDirectory.trim());
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
      setDraft(next);
      setNotice(message);
      setSaveError('');
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Could not save preferences. Your log folder has not changed.',
      );
    } finally {
      setSaving(false);
    }
  };
  const logDirectoryError = logDirectoryValidationError(draft.storage.logDirectory.trim());
  const chooseDirectory = async () => {
    setChoosingDirectory(true);
    try {
      const directory = await onChooseLogDirectory();
      if (directory !== null) update({ logDirectory: directory }, 'storage');
    } finally {
      setChoosingDirectory(false);
    }
  };

  const storageUsagePercent = storedBytes === null ? null : Math.min((storedBytes / draft.storage.storageLimitBytes) * 100, 100);
  const storageLimitReached = storedBytes !== null && storedBytes >= draft.storage.storageLimitBytes;
  const storageLimitNear = !storageLimitReached && storedBytes !== null && storedBytes >= draft.storage.storageLimitBytes * 0.8;

  return (
    <section className="sd-preferences" aria-labelledby="preferences-heading">
      <div className="sd-screen-heading"><span className="sd-section-icon"><Settings2 size={19} /></span><div><p>APPLICATION SETTINGS</p><h1 id="preferences-heading">Preferences</h1><small>{nativeEnabled ? 'Saved locally in BaudTide’s desktop settings file.' : 'Saved locally in this browser preview when browser storage is available.'}</small></div></div>
      <div className="sd-settings-grid">
        <fieldset className="sd-settings-card"><legend>Serial defaults</legend>
          <label>Default baud rate<ThemedSelect label="Default baud rate" value={String(draft.serial.baudRate)} onChange={(value) => update({ baudRate: Number(value) }, 'serial')} placeholder="Select a baud rate" options={['9600', '57600', '115200', '230400'].map((value) => ({ value, label: `${Number(value).toLocaleString()} baud` }))} /></label>
          <label>Line ending<ThemedSelect label="Line ending" value={draft.serial.lineEnding} onChange={(value) => update({ lineEnding: value as LineEnding }, 'serial')} placeholder="Select line ending" options={[{ value: 'lf', label: 'LF (\\n)' }, { value: 'crlf', label: 'CRLF (\\r\\n)' }, { value: 'cr', label: 'CR (\\r)' }, { value: 'none', label: 'None' }]} /></label>
          <label>Display encoding<ThemedSelect label="Display encoding" value={draft.serial.displayEncoding} onChange={(value) => update({ displayEncoding: value as DisplayEncoding }, 'serial')} placeholder="Select encoding" options={[{ value: 'utf8', label: 'UTF-8' }, { value: 'ascii', label: 'ASCII' }, { value: 'hex', label: 'Hexadecimal' }]} /></label>
          <Toggle label="Show timestamps by default" checked={draft.serial.showTimestamps} onChange={(value) => update({ showTimestamps: value }, 'serial')} />
        </fieldset>
        <fieldset className="sd-settings-card"><legend>Appearance & reconnect</legend>
          <div className="sd-theme-setting"><div><strong>Theme</strong><span>Preview now; it is saved with the rest of these preferences.</span></div><div className="sd-theme-switcher" role="group" aria-label="Application theme"><button type="button" className={draft.appearance.theme === 'dark' ? 'is-active' : ''} aria-pressed={draft.appearance.theme === 'dark'} onClick={() => changeTheme('dark')}><Moon size={14} /> Dark</button><button type="button" className={draft.appearance.theme === 'light' ? 'is-active' : ''} aria-pressed={draft.appearance.theme === 'light'} onClick={() => changeTheme('light')}><Sun size={14} /> Light</button></div></div>
          <Toggle label="Reconnect when a device returns" checked={draft.serial.reconnectWhenDeviceReturns} onChange={(value) => update({ reconnectWhenDeviceReturns: value }, 'serial')} />
          <p className="sd-field-hint">New desktop sessions retry a failed device connection until it returns. Intentional disconnects never reconnect.</p>
        </fieldset>
        <fieldset className="sd-settings-card sd-storage-settings"><legend>Local storage</legend>
          <label>Log folder<div className="sd-path-control"><input value={draft.storage.logDirectory} onChange={(event) => update({ logDirectory: event.target.value }, 'storage')} placeholder="Use BaudTide's default log location" aria-invalid={Boolean(logDirectoryError)} aria-describedby={logDirectoryError ? 'log-folder-error' : undefined} readOnly={nativeEnabled} /><button type="button" aria-label="Choose log folder" title={nativeEnabled ? 'Choose log folder' : 'Folder picker is available in the desktop app'} onClick={() => void chooseDirectory()} disabled={!nativeEnabled || isChoosingDirectory}>{isChoosingDirectory ? <LoaderCircle className="sd-spin" size={17} /> : <FolderOpen size={17} />}</button></div>{logDirectoryError && <small className="sd-preferences-field-error" id="log-folder-error">{logDirectoryError}</small>}</label>
          <label>Storage limit<ThemedSelect label="Storage limit" value={String(draft.storage.storageLimitBytes)} onChange={(value) => update({ storageLimitBytes: Number(value) }, 'storage')} placeholder="Select a storage limit" options={storageLimits.map((limit) => ({ value: String(limit.value), label: limit.label }))} /></label>
          {nativeEnabled ? <div className={`sd-storage-usage${storageLimitReached ? ' is-critical' : storageLimitNear ? ' is-warning' : ''}`} aria-live="polite">
            <div className="sd-storage-usage-heading"><span><HardDrive size={15} /> Stored captures</span><button type="button" onClick={() => void refreshStorageUsage()} disabled={isRefreshingStorage}>{isRefreshingStorage ? <LoaderCircle className="sd-spin" size={14} /> : <RefreshCw size={14} />} Refresh</button></div>
            {storageError ? <p className="sd-storage-usage-error"><AlertTriangle size={14} /> {storageError}</p> : storedBytes === null ? <p>Checking local capture usage…</p> : <><strong>{formatBytes(storedBytes)} <span>of {formatBytes(draft.storage.storageLimitBytes)} hard limit</span></strong><progress className="sd-storage-meter" value={storageUsagePercent ?? 0} max={100} aria-label={`${formatBytes(storedBytes)} of ${formatBytes(draft.storage.storageLimitBytes)} storage limit`} /><p>{storageLimitReached ? 'The hard limit has been reached. New and active captures stop before exceeding it.' : storageLimitNear ? 'Approaching the hard limit. Review saved logs or choose a larger limit before a long capture.' : 'Usage includes saved raw captures that BaudTide can list locally.'}</p></>}
          </div> : <p className="sd-field-hint">Capture usage is available in the BaudTide desktop app.</p>}
          <p className="sd-field-hint">The folder is used for new desktop-session logs. The limit is enforced without trimming or deleting existing raw logs; reducing it can stop active captures.</p>
        </fieldset>
      </div>
      {saveError && <p className="sd-preferences-save-error" role="alert">{saveError}</p>}
      <div className="sd-settings-actions"><button className="sd-secondary-button" type="button" disabled={isSaving} onClick={() => { const reset = defaultPreferences(); onThemePreview(reset.appearance.theme); void persist(reset, 'Defaults restored and saved.'); }}><RotateCcw size={16} /> Reset settings</button><button className="sd-primary-button" type="button" disabled={isSaving || Boolean(logDirectoryError)} onClick={() => void persist(draft, nativeEnabled ? 'Preferences saved locally.' : 'Preferences saved in this browser preview.')}>{isSaving ? <><LoaderCircle className="sd-spin" size={16} /> Saving…</> : notice ? <><Check size={16} /> {notice}</> : 'Save preferences'}</button></div>
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="sd-toggle-row"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i aria-hidden="true" /></label>;
}
