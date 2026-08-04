import type { SerialConnectionSettings } from './serial';

const STORAGE_KEY = 'baudtide.session-workspaces.v1';
const STORAGE_VERSION = 1;
const MAX_WORKSPACES = 30;
const MAX_SESSIONS_PER_WORKSPACE = 24;
const TERMINAL_IDENTITY_PATTERN = /^serial:[^:\s]+:\d+:[5678]:(?:none|odd|even):(?:one|two):(?:none|software|hardware)$/;

export type TerminalLayout = 'tabs' | 'tiled';

export type SavedSessionWorkspace = {
  id: string;
  name: string;
  layout: TerminalLayout;
  sessionIdentities: string[];
  selectedSessionIdentity: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SessionWorkspaceSnapshot = {
  name: string;
  layout: TerminalLayout;
  sessionIdentities: string[];
  selectedSessionIdentity: string | null;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maximumLength;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function normalizeName(value: unknown): string | null {
  return validString(value, 80) ? value.trim() : null;
}

function normalizeIdentities(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SESSIONS_PER_WORKSPACE) return null;
  const identities = value
    .filter((identity): identity is string => validString(identity, 8192) && TERMINAL_IDENTITY_PATTERN.test(identity.trim()))
    .map((identity) => identity.trim());
  if (identities.length !== value.length || new Set(identities).size !== identities.length) return null;
  return identities;
}

function parseWorkspace(value: unknown): SavedSessionWorkspace | null {
  if (!isRecord(value)) return null;
  const id = validString(value.id, 160) ? value.id.trim() : null;
  const name = normalizeName(value.name);
  const sessionIdentities = normalizeIdentities(value.sessionIdentities);
  if (!id || !name || !sessionIdentities || (value.layout !== 'tabs' && value.layout !== 'tiled')) return null;
  const selectedSessionIdentity = value.selectedSessionIdentity === null
    ? null
    : validString(value.selectedSessionIdentity, 8192) ? value.selectedSessionIdentity.trim() : null;
  if (value.selectedSessionIdentity !== null && !selectedSessionIdentity) return null;
  if (selectedSessionIdentity && !sessionIdentities.includes(selectedSessionIdentity)) return null;
  if (!validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)) return null;
  return {
    id,
    name,
    layout: value.layout,
    sessionIdentities,
    selectedSessionIdentity,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/**
 * A durable identifier for a terminal's physical target and serial settings.
 * Native backend IDs intentionally do not appear here because they change when
 * a reader reconnects or is recovered after restarting the application.
 */
export function stableTerminalSessionIdentity(connection: Pick<
  { port: string; baudRate: number; settings: SerialConnectionSettings },
  'port' | 'baudRate' | 'settings'
>): string {
  const { port, baudRate, settings } = connection;
  return [
    'serial',
    encodeURIComponent(port.trim()),
    baudRate,
    settings.dataBits,
    settings.parity,
    settings.stopBits,
    settings.flowControl,
  ].join(':');
}

/** Parse a persisted model defensively. Anything malformed becomes an empty list. */
export function normalizeSessionWorkspaces(value: unknown): SavedSessionWorkspace[] {
  if (!isRecord(value) || value.version !== STORAGE_VERSION || !Array.isArray(value.workspaces)) return [];
  const seenIds = new Set<string>();
  const workspaces: SavedSessionWorkspace[] = [];
  for (const candidate of value.workspaces) {
    const workspace = parseWorkspace(candidate);
    if (!workspace || seenIds.has(workspace.id)) continue;
    seenIds.add(workspace.id);
    workspaces.push(workspace);
    if (workspaces.length === MAX_WORKSPACES) break;
  }
  return workspaces;
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readWorkspaces(storage: Storage): SavedSessionWorkspace[] | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return normalizeSessionWorkspaces(JSON.parse(raw ?? '{}'));
  } catch {
    return [];
  }
}

function writeWorkspaces(storage: Storage, workspaces: SavedSessionWorkspace[]): boolean {
  try {
    if (workspaces.length) storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, workspaces }));
    else storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseSnapshot(snapshot: SessionWorkspaceSnapshot): SessionWorkspaceSnapshot | null {
  const name = normalizeName(snapshot.name);
  const sessionIdentities = normalizeIdentities(snapshot.sessionIdentities);
  if (!name || !sessionIdentities || (snapshot.layout !== 'tabs' && snapshot.layout !== 'tiled')) return null;
  if (snapshot.selectedSessionIdentity !== null && !sessionIdentities.includes(snapshot.selectedSessionIdentity)) return null;
  return { ...snapshot, name, sessionIdentities };
}

/** Load local-only saved layouts. Storage or JSON failures are intentionally non-fatal. */
export function loadSessionWorkspaces(): SavedSessionWorkspace[] {
  const storage = getStorage();
  return storage ? readWorkspaces(storage) ?? [] : [];
}

/** Save a snapshot without touching any native serial session. */
export function saveSessionWorkspace(snapshot: SessionWorkspaceSnapshot): SavedSessionWorkspace | null {
  const normalized = parseSnapshot(snapshot);
  const storage = getStorage();
  if (!normalized || !storage) return null;
  const current = readWorkspaces(storage);
  if (!current) return null;
  const now = Date.now();
  const workspace: SavedSessionWorkspace = { id: createId(), ...normalized, createdAt: now, updatedAt: now };
  const next = [workspace, ...current].slice(0, MAX_WORKSPACES);
  return writeWorkspaces(storage, next) ? workspace : null;
}

export function renameSessionWorkspace(id: string, name: string): SavedSessionWorkspace[] | null {
  const storage = getStorage();
  const normalizedName = normalizeName(name);
  if (!storage || !validString(id, 160) || !normalizedName) return null;
  const current = readWorkspaces(storage);
  if (!current) return null;
  let changed = false;
  const next = current.map((workspace) => {
    if (workspace.id !== id) return workspace;
    changed = true;
    return { ...workspace, name: normalizedName, updatedAt: Date.now() };
  });
  return changed && writeWorkspaces(storage, next) ? next : null;
}

export function deleteSessionWorkspace(id: string): SavedSessionWorkspace[] | null {
  const storage = getStorage();
  if (!storage || !validString(id, 160)) return null;
  const current = readWorkspaces(storage);
  if (!current) return null;
  const next = current.filter((workspace) => workspace.id !== id);
  return next.length !== current.length && writeWorkspaces(storage, next) ? next : null;
}
