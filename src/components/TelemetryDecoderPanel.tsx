import { useEffect, useId, useMemo, useState } from 'react';
import { AlertTriangle, Check, Code2, Plus, Save, Trash2, X } from 'lucide-react';
import {
  createTelemetryDecoderProfile,
  decoderSeparatorLabel,
  defaultTelemetryDecoderDraft,
  loadTelemetryDecoderProfiles,
  MAX_TELEMETRY_DECODER_FIELDS,
  parseCustomTelemetryLine,
  profileToDraft,
  saveTelemetryDecoderProfiles,
  validateTelemetryDecoderDraft,
  type TelemetryDecoderProfile,
  type TelemetryDecoderProfileDraft,
  type TelemetryDecoderSeparator,
} from '../lib/telemetryDecoders';
import { ThemedSelect } from './ThemedSelect';
import './telemetry-decoder-panel.css';

const AUTOMATIC_PROFILE = '__baudtide-automatic__';
const NEW_PROFILE = '__baudtide-new__';

type DecoderMode = 'automatic' | 'custom';

const decoderModeOptions = [
  { value: 'automatic', label: 'Automatic detection' },
  { value: 'custom', label: 'Custom decoder' },
];

export type TelemetryDecoderSource = {
  id: string;
  name: string;
  detail: string;
  kind: 'live' | 'recorded';
  receivedCompleteLineCount: number;
  detectedFieldCount: number;
  appliedProfile?: TelemetryDecoderProfile;
};

type TelemetryDecoderPanelProps = {
  sources: readonly TelemetryDecoderSource[];
  onApply: (sourceId: string, profile?: TelemetryDecoderProfile) => void;
  /** Reset every loaded source still using a profile that is being deleted. */
  onProfileDeleted: (profile: TelemetryDecoderProfile) => void;
};

type DecoderStorageError = 'storage-unavailable' | 'storage-write-failed' | 'storage-quota-exceeded';

const separatorOptions = (['whitespace', 'comma', 'tab', 'pipe', 'semicolon'] as TelemetryDecoderSeparator[])
  .map((value) => ({ value, label: decoderSeparatorLabel(value) }));

function profileStorageError(error: DecoderStorageError) {
  switch (error) {
    case 'storage-unavailable': return 'Decoder profiles are unavailable because local storage is blocked.';
    case 'storage-quota-exceeded': return 'Decoder profiles could not be saved because local storage is full.';
    default: return 'Decoder profiles could not be saved locally.';
  }
}

function previewValue(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 5 }).format(value);
}

export function TelemetryDecoderPanel({ sources, onApply, onProfileDeleted }: TelemetryDecoderPanelProps) {
  const [profiles, setProfiles] = useState<TelemetryDecoderProfile[]>(loadTelemetryDecoderProfiles);
  const [targetId, setTargetId] = useState(sources[0]?.id ?? '');
  const [profileChoice, setProfileChoice] = useState(AUTOMATIC_PROFILE);
  const [draft, setDraft] = useState<TelemetryDecoderProfileDraft>(defaultTelemetryDecoderDraft);
  const [sampleLine, setSampleLine] = useState('23.8, 51.2, 3.31');
  const [isOpen, setOpen] = useState(false);
  const [isEditing, setEditing] = useState(false);
  const [status, setStatus] = useState('');

  const targetSource = sources.find((source) => source.id === targetId) ?? sources[0];
  const selectedProfile = profiles.find((profile) => profile.id === profileChoice);
  const appliedProfile = targetSource?.appliedProfile;
  const appliedProfileUpdatedAt = appliedProfile?.updatedAt;
  const hasUnmappedNumericData = !appliedProfile
    && (targetSource?.receivedCompleteLineCount ?? 0) >= 2
    && targetSource?.detectedFieldCount === 0;
  const validationError = validateTelemetryDecoderDraft(draft);
  const previewValues = validationError ? null : parseCustomTelemetryLine(sampleLine, draft);
  const previewFieldNames = useMemo(() => new Set(draft.fields.map((field) => field.name)), [draft.fields]);

  useEffect(() => {
    if (!sources.length) {
      setTargetId('');
      return;
    }
    if (!sources.some((source) => source.id === targetId)) setTargetId(sources[0].id);
  }, [sources, targetId]);

  useEffect(() => {
    const source = sources.find((candidate) => candidate.id === targetId) ?? sources[0];
    if (!source) return;
    const nextProfile = source.appliedProfile;
    setProfileChoice(nextProfile?.id ?? AUTOMATIC_PROFILE);
    setDraft(nextProfile ? profileToDraft(nextProfile) : defaultTelemetryDecoderDraft());
    setEditing(false);
    setStatus('');
  }, [targetId, appliedProfile?.id, appliedProfileUpdatedAt]);

  const targetOptions = sources.map((source) => ({
    value: source.id,
    label: `${source.kind === 'live' ? 'Live' : 'Capture'} · ${source.name} · ${source.detail}`,
  }));
  const profileOptions = [
    { value: AUTOMATIC_PROFILE, label: 'Automatic detection' },
    ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
    { value: NEW_PROFILE, label: 'New custom profile…' },
  ];
  const decoderMode: DecoderMode = appliedProfile || (isOpen && (profileChoice !== AUTOMATIC_PROFILE || isEditing))
    ? 'custom'
    : 'automatic';

  const updateDraft = <K extends keyof TelemetryDecoderProfileDraft>(key: K, value: TelemetryDecoderProfileDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setStatus('');
  };

  const updateField = (index: number, key: 'column' | 'name' | 'unit', value: string) => {
    setDraft((current) => ({
      ...current,
      fields: current.fields.map((field, fieldIndex) => fieldIndex === index
        ? { ...field, [key]: key === 'column' ? Math.max(1, Number(value) || 1) : value }
        : field),
    }));
    setStatus('');
  };

  const addField = () => {
    if (draft.fields.length >= MAX_TELEMETRY_DECODER_FIELDS) {
      setStatus(`A decoder can map up to ${MAX_TELEMETRY_DECODER_FIELDS} fields.`);
      return;
    }
    const usedColumns = new Set(draft.fields.map((field) => field.column));
    let nextColumn = 1;
    while (usedColumns.has(nextColumn)) nextColumn += 1;
    updateDraft('fields', [...draft.fields, { column: nextColumn, name: `signal_${nextColumn}`, unit: '' }]);
  };

  const removeField = (index: number) => {
    if (draft.fields.length === 1) {
      setStatus('Keep at least one signal field in the decoder.');
      return;
    }
    updateDraft('fields', draft.fields.filter((_, fieldIndex) => fieldIndex !== index));
  };

  const changeProfile = (value: string) => {
    setProfileChoice(value);
    setStatus('');
    if (value === AUTOMATIC_PROFILE) {
      setDraft(defaultTelemetryDecoderDraft());
      setEditing(false);
      return;
    }
    if (value === NEW_PROFILE) {
      setDraft(defaultTelemetryDecoderDraft());
      setEditing(true);
      return;
    }
    const profile = profiles.find((candidate) => candidate.id === value);
    if (profile) {
      setDraft(profileToDraft(profile));
      setEditing(true);
    }
  };

  const applyAutomatic = () => {
    if (!targetSource) return;
    onApply(targetSource.id);
    setProfileChoice(AUTOMATIC_PROFILE);
    setEditing(false);
    setStatus(`Automatic detection restored for ${targetSource.name}.`);
  };

  const applySelectedProfile = () => {
    if (!targetSource || !selectedProfile) return;
    onApply(targetSource.id, selectedProfile);
    setDraft(profileToDraft(selectedProfile));
    setEditing(false);
    setStatus(`Applied “${selectedProfile.name}” to ${targetSource.name}.`);
  };

  const saveAndApply = () => {
    if (!targetSource) return;
    if (validationError) {
      setStatus(validationError);
      return;
    }
    try {
      const profile = createTelemetryDecoderProfile(draft, selectedProfile);
      const nextProfiles = selectedProfile
        ? profiles.map((candidate) => candidate.id === profile.id ? profile : candidate)
        : [profile, ...profiles];
      const saved = saveTelemetryDecoderProfiles(nextProfiles);
      if (!saved.ok) {
        setStatus(profileStorageError(saved.error));
        return;
      }
      setProfiles(saved.profiles);
      setProfileChoice(profile.id);
      setEditing(false);
      onApply(targetSource.id, profile);
      setStatus(`Saved and applied “${profile.name}” to ${targetSource.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'This decoder profile could not be saved.');
    }
  };

  const deleteSelectedProfile = () => {
    if (!selectedProfile) return;
    if (!window.confirm(`Delete the decoder profile “${selectedProfile.name}”?`)) return;
    const nextProfiles = profiles.filter((profile) => profile.id !== selectedProfile.id);
    const saved = saveTelemetryDecoderProfiles(nextProfiles);
    if (!saved.ok) {
      setStatus(profileStorageError(saved.error));
      return;
    }
    setProfiles(saved.profiles);
    onProfileDeleted(selectedProfile);
    setProfileChoice(AUTOMATIC_PROFILE);
    setDraft(defaultTelemetryDecoderDraft());
    setEditing(false);
    setStatus(`Deleted “${selectedProfile.name}” and restored automatic detection where it was in use.`);
  };

  const chooseDecoderMode = (value: string) => {
    setStatus('');
    if (value === 'automatic') {
      if (appliedProfile) applyAutomatic();
      else {
        setProfileChoice(AUTOMATIC_PROFILE);
        setDraft(defaultTelemetryDecoderDraft());
        setEditing(false);
      }
      setOpen(false);
      return;
    }

    setOpen(true);
    if (appliedProfile) {
      setProfileChoice(profiles.some((profile) => profile.id === appliedProfile.id) ? appliedProfile.id : NEW_PROFILE);
      setDraft(profileToDraft(appliedProfile));
      setEditing(true);
      return;
    }
    setProfileChoice(NEW_PROFILE);
    setDraft(defaultTelemetryDecoderDraft());
    setEditing(true);
  };

  const launcherTitle = appliedProfile
    ? `Custom decoder active: ${appliedProfile.name}`
    : hasUnmappedNumericData ? 'Incoming data is not chartable yet' : 'Custom decoder';
  const launcherDescription = appliedProfile
    ? 'Review or change how each incoming column becomes a chart signal.'
    : hasUnmappedNumericData
      ? `${targetSource?.receivedCompleteLineCount.toLocaleString()} lines arrived without chartable fields. If they contain unlabelled numeric columns, map them to chart signals.`
      : 'Map plain numeric columns into named chart signals when data has no labels or header.';
  const sampleId = useId();
  const nameId = useId();
  const prefixId = useId();
  const separatorId = useId();

  if (!sources.length) {
    return <section className="bt-decoder-panel is-empty" aria-label="Telemetry decoder">
      <div className="bt-decoder-launcher">
        <span className="bt-decoder-panel-icon" aria-hidden="true"><Code2 size={18} /></span>
        <div className="bt-decoder-launcher-copy"><h2>Custom decoder</h2><p>Add a live session or saved capture to map plain numeric columns into named signals.</p></div>
      </div>
    </section>;
  }

  return <section className={`bt-decoder-panel${isOpen ? ' is-open' : ''}${hasUnmappedNumericData ? ' is-needs-setup' : ''}`} aria-labelledby="telemetry-decoder-title">
    <div className="bt-decoder-launcher">
      <span className="bt-decoder-panel-icon" aria-hidden="true"><Code2 size={18} /></span>
      <div className="bt-decoder-launcher-copy">
        <h2 id="telemetry-decoder-title">{launcherTitle}</h2>
        <p>{launcherDescription}</p>
        <span className="bt-decoder-source"><b>{targetSource?.kind === 'live' ? 'Live source' : 'Saved capture'}</b> · {targetSource?.name} · {targetSource?.detail}</span>
      </div>
      <div className="bt-decoder-launcher-actions">
        <div className="bt-decoder-mode-control">
          <span>Decoder mode</span>
          <ThemedSelect value={decoderMode} options={decoderModeOptions} placeholder="Choose a decoder mode" label="Decoder mode" onChange={chooseDecoderMode} />
        </div>
        {isOpen && <button className="bt-decoder-collapse" type="button" aria-controls="telemetry-decoder-editor" onClick={() => setOpen(false)}>Hide setup</button>}
      </div>
    </div>

    {isOpen ? <div className="bt-decoder-panel-body" id="telemetry-decoder-editor">
      <div className="bt-decoder-panel-intro"><div><h2>Teach BaudTide this line format</h2><p>Map numeric columns from one complete device line. Raw terminal output and local captures stay unchanged.</p></div><span className="bt-decoder-panel-rule" aria-hidden="true" /></div>

      <div className="bt-decoder-panel-controls">
        <div className="bt-decoder-control"><span>Apply to</span><ThemedSelect value={targetSource?.id ?? ''} options={targetOptions} placeholder="Choose a source" label="Decoder source" onChange={setTargetId} /></div>
        <div className="bt-decoder-control"><span>Profile</span><ThemedSelect value={profileChoice} options={profileOptions} placeholder="Choose a decoder" label="Decoder profile" onChange={changeProfile} /></div>
        {selectedProfile && <button type="button" className="bt-decoder-delete" onClick={deleteSelectedProfile} aria-label={`Delete ${selectedProfile.name}`} title="Delete decoder profile"><Trash2 size={14} /></button>}
      </div>

      {profileChoice === AUTOMATIC_PROFILE && !isEditing ? <div className="bt-decoder-automatic"><div><Check size={16} /><span><strong>{appliedProfile ? 'Switch back to automatic detection.' : 'Automatic detection is active.'}</strong><small>Use this while your device sends JSON, key/value pairs, or header-based CSV/TSV.</small></span></div><div className="bt-decoder-automatic-actions">{appliedProfile && <button type="button" className="bt-decoder-secondary" onClick={applyAutomatic}>Use automatic detection</button>}<button type="button" className="bt-decoder-secondary" onClick={() => { setProfileChoice(NEW_PROFILE); setDraft(defaultTelemetryDecoderDraft()); setEditing(true); }}>Configure custom decoder</button></div></div> : <div className="bt-decoder-editor">
        <div className="bt-decoder-editor-grid">
          <label className="bt-decoder-field bt-decoder-field-name" htmlFor={nameId}><span>Profile name</span><input id={nameId} value={draft.name} maxLength={80} onChange={(event) => updateDraft('name', event.target.value)} placeholder="e.g. Weather node" /></label>
          <label className="bt-decoder-field bt-decoder-field-prefix" htmlFor={prefixId}><span>Line prefix <small>optional</small></span><input id={prefixId} value={draft.prefix} maxLength={80} onChange={(event) => updateDraft('prefix', event.target.value)} placeholder="Leave blank for raw numeric columns" /></label>
          <div className="bt-decoder-field bt-decoder-field-separator"><span id={separatorId}>Column separator</span><ThemedSelect value={draft.separator} options={separatorOptions} placeholder="Choose separator" label="Column separator" onChange={(value) => updateDraft('separator', value as TelemetryDecoderSeparator)} /></div>
        </div>

        <div className="bt-decoder-mapping">
          <div className="bt-decoder-mapping-header"><div><h3>Signal columns</h3><span>Column numbers start at 1.</span></div><button type="button" className="bt-decoder-secondary" onClick={addField}><Plus size={14} /> Add signal</button></div>
          <div className="bt-decoder-mapping-list" role="list" aria-label="Mapped signal columns">
            {draft.fields.map((field, index) => <div className="bt-decoder-mapping-row" role="listitem" key={`${index}-${field.column}`}>
              <label><span>Column</span><input type="number" min={1} max={64} value={field.column} onChange={(event) => updateField(index, 'column', event.target.value)} /></label>
              <label className="bt-decoder-mapping-name"><span>Signal name</span><input value={field.name} maxLength={64} onChange={(event) => updateField(index, 'name', event.target.value)} placeholder="temperature" /></label>
              <label><span>Unit <small>optional</small></span><input value={field.unit ?? ''} maxLength={24} onChange={(event) => updateField(index, 'unit', event.target.value)} placeholder="°C" /></label>
              <button type="button" className="bt-decoder-remove" onClick={() => removeField(index)} aria-label={`Remove ${field.name || `column ${field.column}`}`} title="Remove signal"><X size={14} /></button>
            </div>)}
          </div>
        </div>

        <div className="bt-decoder-preview">
          <div className="bt-decoder-preview-header"><div><h3>Translation preview</h3><span>Paste one line from the terminal to validate the mapping.</span></div><span className="bt-decoder-preview-state">{previewValues ? 'MATCH' : 'NO MATCH'}</span></div>
          <label className="bt-decoder-sample-line" htmlFor={sampleId}><span>Sample line</span><input id={sampleId} value={sampleLine} onChange={(event) => setSampleLine(event.target.value)} placeholder="23.8, 51.2, 3.31" /></label>
          {validationError ? <p className="bt-decoder-preview-error"><AlertTriangle size={14} /> {validationError}</p> : previewValues ? <div className="bt-decoder-preview-result"><code>{sampleLine}</code><span aria-hidden="true">→</span><div>{draft.fields.filter((field) => previewFieldNames.has(field.name)).map((field) => <span className="bt-decoder-value" key={field.name}><strong>{field.name}</strong><b>{previewValue(previewValues[field.name].value)}</b>{field.unit && <small>{field.unit}</small>}</span>)}</div></div> : <p className="bt-decoder-preview-error"><AlertTriangle size={14} /> This line does not match the prefix, separator, or numeric columns above.</p>}
        </div>

        <div className="bt-decoder-editor-actions"><span className="bt-decoder-editor-status" role="status" aria-live="polite">{status}</span><div><button type="button" className="bt-decoder-secondary" onClick={applyAutomatic}>Use automatic detection</button>{selectedProfile && <button type="button" className="bt-decoder-secondary" onClick={applySelectedProfile}>Apply profile</button>}<button type="button" className="bt-decoder-primary" onClick={saveAndApply} disabled={Boolean(validationError)}><Save size={14} /> {selectedProfile ? 'Save changes & apply' : 'Save profile & apply'}</button></div></div>
      </div>}
      {status && profileChoice === AUTOMATIC_PROFILE && <p className="bt-decoder-standalone-status" role="status" aria-live="polite">{status}</p>}
    </div> : null}
  </section>;
}
