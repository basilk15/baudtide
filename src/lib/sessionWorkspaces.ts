import type { SerialConnectionSettings, SerialDeviceIdentity } from './serial';
import { normalizeBenchConnection, type BenchConnectionPreset } from './benchSetup';

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
  connections?: BenchConnectionPreset[];
  analysisWorkspaceId?: string;
  createdAt: number;
  updatedAt: number;
};

export type SessionWorkspaceSnapshot = {
  name: string;
  layout: TerminalLayout;
  sessionIdentities: string[];
  selectedSessionIdentity: string | null;
  connections?: BenchConnectionPreset[];
  analysisWorkspaceId?: string;
};

export type SessionWorkspaceLoadResult = {
  workspaces: SavedSessionWorkspace[];
  error: 'storage-unavailable' | 'storage-read-failed' | null;
};

export type SessionWorkspaceSaveResult =
  | { ok: true; workspace: SavedSessionWorkspace }
  | {
      ok: false;
      error:
        | 'invalid-snapshot'
        | 'storage-unavailable'
        | 'storage-read-failed'
        | 'storage-write-failed'
        | 'storage-quota-exceeded';
    };

export type SessionWorkspaceUpdateResult =
  | { ok: true; workspaces: SavedSessionWorkspace[]; workspace: SavedSessionWorkspace }
  | {
      ok: false;
      error:
        | 'invalid-id'
        | 'invalid-name'
        | 'missing-workspace'
        | 'storage-unavailable'
        | 'storage-read-failed'
        | 'storage-write-failed'
        | 'storage-quota-exceeded';
    };

export type SessionWorkspaceDeleteResult =
  | { ok: true; workspaces: SavedSessionWorkspace[] }
  | {
      ok: false;
      error:
        | 'invalid-id'
        | 'missing-workspace'
        | 'storage-unavailable'
        | 'storage-read-failed'
        | 'storage-write-failed'
        | 'storage-quota-exceeded';
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
  const connections = parseConnections(value.connections, sessionIdentities);
  if (connections === null || (value.analysisWorkspaceId !== undefined && !validString(value.analysisWorkspaceId, 160))) return null;
  return {
    ...(connections ? { connections } : {}),
    ...(typeof value.analysisWorkspaceId === 'string' ? { analysisWorkspaceId: value.analysisWorkspaceId } : {}),
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
> & { deviceIdentity?: SerialDeviceIdentity | null }): string {
  const { port, baudRate, settings } = connection;
  const device = connection.deviceIdentity;
  const target = device?.stablePath
    ? `usb-path=${device.vendorId},${device.productId},${device.stablePath}`
    : device?.serialNumber ? `usb-serial=${device.vendorId},${device.productId},${device.serialNumber}` : port.trim();
  return [
    'serial',
    encodeURIComponent(target),
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

function getStorage(): { ok: true; storage: Storage } | { ok: false; error: 'storage-unavailable' } {
  if (typeof window === 'undefined') return { ok: false, error: 'storage-unavailable' };
  try {
    return { ok: true, storage: window.localStorage };
  } catch {
    return { ok: false, error: 'storage-unavailable' };
  }
}

function readWorkspaces(storage: Storage): SessionWorkspaceLoadResult {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return { workspaces: normalizeSessionWorkspaces(JSON.parse(raw ?? '{}')), error: null };
  } catch {
    return { workspaces: [], error: 'storage-read-failed' };
  }
}

function classifyWriteError(error: unknown): 'storage-write-failed' | 'storage-quota-exceeded' {
  const hasDomException = typeof DOMException !== 'undefined';
  return hasDomException && error instanceof DOMException && error.name === 'QuotaExceededError'
    ? 'storage-quota-exceeded'
    : 'storage-write-failed';
}

function writeWorkspaces(
  storage: Storage,
  workspaces: SavedSessionWorkspace[],
): { ok: true } | { ok: false; error: 'storage-write-failed' | 'storage-quota-exceeded' } {
  try {
    if (workspaces.length) storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, workspaces }));
    else storage.removeItem(STORAGE_KEY);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: classifyWriteError(error) };
  }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseConnections(value: unknown, identities: string[]): BenchConnectionPreset[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== identities.length) return null;
  const connections = value.map(normalizeBenchConnection);
  if (connections.some((p) => !p) || new Set(connections.map((p) => p?.identity)).size !== identities.length
    || connections.some((p) => !identities.includes(p!.identity) || stableTerminalSessionIdentity(p!) !== p!.identity)) return null;
  return connections as BenchConnectionPreset[];
}

function parseSnapshot(snapshot: SessionWorkspaceSnapshot): SessionWorkspaceSnapshot | null {
  const name = normalizeName(snapshot.name);
  const sessionIdentities = normalizeIdentities(snapshot.sessionIdentities);
  if (!name || !sessionIdentities || (snapshot.layout !== 'tabs' && snapshot.layout !== 'tiled')) return null;
  const selectedSessionIdentity = snapshot.selectedSessionIdentity === null
    ? null
    : validString(snapshot.selectedSessionIdentity, 8192) ? snapshot.selectedSessionIdentity.trim() : null;
  if (snapshot.selectedSessionIdentity !== null && !selectedSessionIdentity) return null;
  if (selectedSessionIdentity && !sessionIdentities.includes(selectedSessionIdentity)) return null;
  const connections = parseConnections(snapshot.connections, sessionIdentities);
  if (connections === null || (snapshot.analysisWorkspaceId !== undefined && !validString(snapshot.analysisWorkspaceId, 160))) return null;
  return { ...snapshot, ...(connections ? { connections } : {}), name, sessionIdentities, selectedSessionIdentity };
}

/** Load local-only saved layouts. Storage or JSON failures are intentionally non-fatal. */
export function loadSessionWorkspaces(): SessionWorkspaceLoadResult {
  const storage = getStorage();
  return storage.ok ? readWorkspaces(storage.storage) : { workspaces: [], error: storage.error };
}

/** Save a snapshot without touching any native serial session. */
export function saveSessionWorkspace(snapshot: SessionWorkspaceSnapshot): SessionWorkspaceSaveResult {
  const normalized = parseSnapshot(snapshot);
  const storage = getStorage();
  if (!normalized) return { ok: false, error: 'invalid-snapshot' };
  if (!storage.ok) return { ok: false, error: storage.error };
  const current = readWorkspaces(storage.storage);
  if (current.error) return { ok: false, error: current.error };
  const now = Date.now();
  const workspace: SavedSessionWorkspace = { id: createId(), ...normalized, createdAt: now, updatedAt: now };
  const next = [workspace, ...current.workspaces].slice(0, MAX_WORKSPACES);
  const writeResult = writeWorkspaces(storage.storage, next);
  return writeResult.ok ? { ok: true, workspace } : { ok: false, error: writeResult.error };
}

export function renameSessionWorkspace(id: string, name: string): SessionWorkspaceUpdateResult {
  const storage = getStorage();
  const normalizedName = normalizeName(name);
  if (!validString(id, 160)) return { ok: false, error: 'invalid-id' };
  if (!normalizedName) return { ok: false, error: 'invalid-name' };
  if (!storage.ok) return { ok: false, error: storage.error };
  const current = readWorkspaces(storage.storage);
  if (current.error) return { ok: false, error: current.error };
  let updatedWorkspace: SavedSessionWorkspace | null = null;
  const next = current.workspaces.map((workspace) => {
    if (workspace.id !== id) return workspace;
    updatedWorkspace = { ...workspace, name: normalizedName, updatedAt: Date.now() };
    return updatedWorkspace;
  });
  if (!updatedWorkspace) return { ok: false, error: 'missing-workspace' };
  const writeResult = writeWorkspaces(storage.storage, next);
  return writeResult.ok
    ? { ok: true, workspaces: next, workspace: updatedWorkspace }
    : { ok: false, error: writeResult.error };
}

export function deleteSessionWorkspace(id: string): SessionWorkspaceDeleteResult {
  const storage = getStorage();
  if (!validString(id, 160)) return { ok: false, error: 'invalid-id' };
  if (!storage.ok) return { ok: false, error: storage.error };
  const current = readWorkspaces(storage.storage);
  if (current.error) return { ok: false, error: current.error };
  const next = current.workspaces.filter((workspace) => workspace.id !== id);
  if (next.length === current.workspaces.length) return { ok: false, error: 'missing-workspace' };
  const writeResult = writeWorkspaces(storage.storage, next);
  return writeResult.ok ? { ok: true, workspaces: next } : { ok: false, error: writeResult.error };
}

/** Update a setup while retaining its saved ID and creation time. */
export function updateSessionWorkspace(id: string, snapshot: SessionWorkspaceSnapshot): SessionWorkspaceUpdateResult {
  const normalized = parseSnapshot(snapshot);
  const storage = getStorage();
  if (!validString(id, 160)) return { ok: false, error: 'invalid-id' };
  if (!normalized) return { ok: false, error: 'invalid-name' };
  if (!storage.ok) return { ok: false, error: storage.error };
  const current = readWorkspaces(storage.storage);
  if (current.error) return { ok: false, error: current.error };
  const original = current.workspaces.find((workspace) => workspace.id === id);
  if (!original) return { ok: false, error: 'missing-workspace' };
  const workspace = { ...normalized, id, createdAt: original.createdAt, updatedAt: Date.now() };
  const next = current.workspaces.map((candidate) => candidate.id === id ? workspace : candidate);
  const result = writeWorkspaces(storage.storage, next);
  return result.ok ? { ok: true, workspaces: next, workspace } : { ok: false, error: result.error };
}
