import type { TelemetryValue } from './telemetry';

export const TELEMETRY_DECODER_PROFILE_VERSION = 1 as const;
export const MAX_TELEMETRY_DECODER_PROFILES = 24;
export const MAX_TELEMETRY_DECODER_FIELDS = 32;
export const MAX_TELEMETRY_DECODER_NAME_LENGTH = 80;
export const MAX_TELEMETRY_DECODER_PREFIX_LENGTH = 80;
export const MAX_TELEMETRY_DECODER_FIELD_NAME_LENGTH = 64;
export const MAX_TELEMETRY_DECODER_UNIT_LENGTH = 24;

export type TelemetryDecoderSeparator = 'whitespace' | 'comma' | 'tab' | 'pipe' | 'semicolon';

export type TelemetryDecoderField = {
  column: number;
  name: string;
  unit?: string;
};

export type TelemetryDecoderProfile = {
  version: typeof TELEMETRY_DECODER_PROFILE_VERSION;
  id: string;
  name: string;
  prefix: string;
  separator: TelemetryDecoderSeparator;
  fields: readonly TelemetryDecoderField[];
  createdAt: number;
  updatedAt: number;
};

export type TelemetryDecoderProfileDraft = {
  name: string;
  prefix: string;
  separator: TelemetryDecoderSeparator;
  fields: TelemetryDecoderField[];
};

export type TelemetryDecoderStorageResult =
  | { ok: true; profiles: TelemetryDecoderProfile[] }
  | { ok: false; error: 'storage-unavailable' | 'storage-write-failed' | 'storage-quota-exceeded' };

const STORAGE_KEY = 'baudtide.telemetry-decoder-profiles.v1';
const SEPARATORS = new Set<TelemetryDecoderSeparator>(['whitespace', 'comma', 'tab', 'pipe', 'semicolon']);
const NUMBER_PATTERN = /^[+-]?(?:(?:\d+\.\d*)|(?:\d*\.\d+)|\d+)(?:[eE][+-]?\d+)?$/u;

function asTrimmedString(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function asPositiveInteger(value: unknown, maximum: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : null;
}

function normalizeField(value: unknown): TelemetryDecoderField | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<TelemetryDecoderField>;
  const column = asPositiveInteger(candidate.column, 64);
  const name = asTrimmedString(candidate.name, MAX_TELEMETRY_DECODER_FIELD_NAME_LENGTH);
  const unit = asTrimmedString(candidate.unit, MAX_TELEMETRY_DECODER_UNIT_LENGTH);
  if (!column || !name || /[\r\n\u0000-\u001F]/u.test(name)) return null;
  return { column, name, ...(unit ? { unit } : {}) };
}

export function validateTelemetryDecoderDraft(draft: TelemetryDecoderProfileDraft): string | null {
  const name = draft.name.trim();
  if (!name) return 'Enter a name for this decoder profile.';
  if (name.length > MAX_TELEMETRY_DECODER_NAME_LENGTH) return `Profile names must be ${MAX_TELEMETRY_DECODER_NAME_LENGTH} characters or fewer.`;
  if (/\r|\n|\u0000/u.test(name)) return 'Profile names cannot contain line breaks.';

  const prefix = draft.prefix.trim();
  if (prefix.length > MAX_TELEMETRY_DECODER_PREFIX_LENGTH) return `Line prefixes must be ${MAX_TELEMETRY_DECODER_PREFIX_LENGTH} characters or fewer.`;
  if (/[\r\n\u0000]/u.test(prefix)) return 'Line prefixes cannot contain line breaks.';
  if (!SEPARATORS.has(draft.separator)) return 'Choose a supported column separator.';
  if (!draft.fields.length) return 'Add at least one signal field.';
  if (draft.fields.length > MAX_TELEMETRY_DECODER_FIELDS) return `A decoder can map up to ${MAX_TELEMETRY_DECODER_FIELDS} fields.`;

  const columns = new Set<number>();
  const names = new Set<string>();
  for (const field of draft.fields) {
    const normalized = normalizeField(field);
    if (!normalized) return 'Each field needs a valid column number and signal name.';
    if (columns.has(normalized.column)) return 'Each column can be mapped only once.';
    if (names.has(normalized.name.toLowerCase())) return 'Signal names must be unique within a profile.';
    columns.add(normalized.column);
    names.add(normalized.name.toLowerCase());
  }
  return null;
}

export function normalizeTelemetryDecoderProfile(value: unknown): TelemetryDecoderProfile | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<TelemetryDecoderProfile>;
  if (candidate.version !== TELEMETRY_DECODER_PROFILE_VERSION || typeof candidate.id !== 'string' || !candidate.id.trim()) return null;
  const fields = Array.isArray(candidate.fields) ? candidate.fields.map(normalizeField).filter((field): field is TelemetryDecoderField => Boolean(field)) : [];
  const draft: TelemetryDecoderProfileDraft = {
    name: asTrimmedString(candidate.name, MAX_TELEMETRY_DECODER_NAME_LENGTH),
    prefix: asTrimmedString(candidate.prefix, MAX_TELEMETRY_DECODER_PREFIX_LENGTH),
    separator: SEPARATORS.has(candidate.separator as TelemetryDecoderSeparator) ? candidate.separator as TelemetryDecoderSeparator : 'whitespace',
    fields,
  };
  if (validateTelemetryDecoderDraft(draft)) return null;
  const now = Date.now();
  const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) ? candidate.createdAt : now;
  const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : createdAt;
  return {
    version: TELEMETRY_DECODER_PROFILE_VERSION,
    id: candidate.id.trim().slice(0, 128),
    name: draft.name,
    prefix: draft.prefix,
    separator: draft.separator,
    fields: Object.freeze(fields.map((field) => Object.freeze({ ...field }))),
    createdAt,
    updatedAt,
  };
}

function profileId() {
  return `decoder-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function profileToDraft(profile: TelemetryDecoderProfile): TelemetryDecoderProfileDraft {
  return {
    name: profile.name,
    prefix: profile.prefix,
    separator: profile.separator,
    fields: profile.fields.map((field) => ({ ...field })),
  };
}

export function defaultTelemetryDecoderDraft(): TelemetryDecoderProfileDraft {
  return {
    name: 'Unlabelled numeric columns',
    prefix: '',
    separator: 'comma',
    fields: [
      { column: 1, name: 'signal_1' },
      { column: 2, name: 'signal_2' },
      { column: 3, name: 'signal_3' },
    ],
  };
}

export function createTelemetryDecoderProfile(
  draft: TelemetryDecoderProfileDraft,
  existing?: TelemetryDecoderProfile,
  now = Date.now(),
): TelemetryDecoderProfile {
  const validationError = validateTelemetryDecoderDraft(draft);
  if (validationError) throw new Error(validationError);
  const fields = draft.fields
    .map((field) => normalizeField(field)!)
    .sort((left, right) => left.column - right.column);
  return {
    version: TELEMETRY_DECODER_PROFILE_VERSION,
    id: existing?.id ?? profileId(),
    name: draft.name.trim(),
    prefix: draft.prefix.trim(),
    separator: draft.separator,
    fields: Object.freeze(fields.map((field) => Object.freeze({ ...field }))),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function loadTelemetryDecoderProfiles(): TelemetryDecoderProfile[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .map(normalizeTelemetryDecoderProfile)
      .filter((profile): profile is TelemetryDecoderProfile => {
        if (!profile || seen.has(profile.id)) return false;
        seen.add(profile.id);
        return true;
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_TELEMETRY_DECODER_PROFILES);
  } catch {
    return [];
  }
}

export function saveTelemetryDecoderProfiles(profiles: readonly TelemetryDecoderProfile[]): TelemetryDecoderStorageResult {
  if (typeof window === 'undefined') return { ok: false, error: 'storage-unavailable' };
  try {
    const storage = window.localStorage;
    if (!storage) return { ok: false, error: 'storage-unavailable' };
    const normalized = profiles
      .map(normalizeTelemetryDecoderProfile)
      .filter((profile): profile is TelemetryDecoderProfile => Boolean(profile))
      .slice(0, MAX_TELEMETRY_DECODER_PROFILES);
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return { ok: true, profiles: normalized };
  } catch (error) {
    const isQuotaError = error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);
    return { ok: false, error: isQuotaError ? 'storage-quota-exceeded' : 'storage-write-failed' };
  }
}

export function decoderSeparatorLabel(separator: TelemetryDecoderSeparator) {
  return {
    whitespace: 'Whitespace',
    comma: 'Comma',
    tab: 'Tab',
    pipe: 'Pipe |',
    semicolon: 'Semicolon ;',
  }[separator];
}

function splitColumns(line: string, separator: TelemetryDecoderSeparator) {
  switch (separator) {
    case 'comma': return line.split(',').map((cell) => cell.trim());
    case 'tab': return line.split('\t').map((cell) => cell.trim());
    case 'pipe': return line.split('|').map((cell) => cell.trim());
    case 'semicolon': return line.split(';').map((cell) => cell.trim());
    default: return line.trim().split(/\s+/u);
  }
}

/** Parses one line using a user-defined, line-based decoder profile. */
export function parseCustomTelemetryLine(
  line: string,
  profile: Pick<TelemetryDecoderProfile, 'prefix' | 'separator' | 'fields'>,
): Readonly<Record<string, TelemetryValue>> | null {
  const trimmedLine = line.trim();
  const prefix = profile.prefix.trim();
  if (prefix && !trimmedLine.startsWith(prefix)) return null;
  const payload = prefix ? trimmedLine.slice(prefix.length).trim() : trimmedLine;
  if (!payload) return null;
  const columns = splitColumns(payload, profile.separator);
  const values: Record<string, TelemetryValue> = Object.create(null) as Record<string, TelemetryValue>;
  for (const field of profile.fields) {
    const cell = columns[field.column - 1]?.trim();
    if (!cell || !NUMBER_PATTERN.test(cell)) return null;
    const value = Number(cell);
    if (!Number.isFinite(value)) return null;
    values[field.name] = { value, ...(field.unit?.trim() ? { unit: field.unit.trim() } : {}) };
  }
  return Object.keys(values).length ? values : null;
}

export function cloneTelemetryDecoderProfile(profile: TelemetryDecoderProfile | undefined) {
  if (!profile) return undefined;
  return Object.freeze({
    ...profile,
    fields: Object.freeze(profile.fields.map((field) => Object.freeze({ ...field }))),
  });
}
