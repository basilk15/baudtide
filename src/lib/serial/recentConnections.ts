import type { SerialConnectionSettings } from './serial';

const STORAGE_KEY = 'baudtide.recent-connections.v1';
const MAX_RECENT_CONNECTIONS = 6;

export type RecentConnection = {
  port: string;
  baudRate: number;
  sessionName: string;
  settings: SerialConnectionSettings;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maximumLength;
}

function parseSettings(value: unknown): SerialConnectionSettings | null {
  if (!isRecord(value)) return null;
  const dataBits = value.dataBits;
  const parity = value.parity;
  const stopBits = value.stopBits;
  const flowControl = value.flowControl;
  if (![5, 6, 7, 8].includes(dataBits as number)) return null;
  if (parity !== 'none' && parity !== 'odd' && parity !== 'even') return null;
  if (stopBits !== 'one' && stopBits !== 'two') return null;
  if (flowControl !== 'none' && flowControl !== 'software' && flowControl !== 'hardware') return null;
  return { dataBits: dataBits as SerialConnectionSettings['dataBits'], parity, stopBits, flowControl };
}

function parseRecentConnection(value: unknown): RecentConnection | null {
  if (!isRecord(value)) return null;
  const port = value.port;
  const sessionName = value.sessionName;
  const baudRate = value.baudRate;
  if (!validString(port, 4096) || !validString(sessionName, 200)) return null;
  if (!Number.isInteger(baudRate) || (baudRate as number) < 300 || (baudRate as number) > 4_000_000) return null;
  const settings = parseSettings(value.settings);
  if (!settings) return null;
  return {
    port: port.trim(),
    baudRate: baudRate as number,
    sessionName: sessionName.trim(),
    settings,
  };
}

function sameConnection(first: RecentConnection, second: RecentConnection) {
  return first.port === second.port
    && first.baudRate === second.baudRate
    && first.settings.dataBits === second.settings.dataBits
    && first.settings.parity === second.settings.parity
    && first.settings.stopBits === second.settings.stopBits
    && first.settings.flowControl === second.settings.flowControl;
}

function samePreset(first: RecentConnection, second: RecentConnection) {
  return first.sessionName === second.sessionName && sameConnection(first, second);
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Returns null only when storage cannot be read; malformed values are treated as empty. */
function readRecentConnections(storage: Storage): RecentConnection[] | null {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseRecentConnection)
      .filter((entry): entry is RecentConnection => entry !== null)
      .slice(0, MAX_RECENT_CONNECTIONS);
  } catch {
    return [];
  }
}

function writeRecentConnections(storage: Storage, connections: RecentConnection[]) {
  try {
    if (connections.length) {
      storage.setItem(STORAGE_KEY, JSON.stringify(connections.slice(0, MAX_RECENT_CONNECTIONS)));
    } else {
      storage.removeItem(STORAGE_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

/** Read local-only, validated connection presets without ever blocking the dialog. */
export function loadRecentConnections(): RecentConnection[] {
  const storage = getStorage();
  return storage ? readRecentConnections(storage) ?? [] : [];
}

/** Store only successful settings. Storage errors (including private mode) are non-fatal. */
export function saveRecentConnection(connection: RecentConnection) {
  const normalized = parseRecentConnection(connection);
  const storage = getStorage();
  if (!normalized || !storage) return false;
  const recent = readRecentConnections(storage);
  if (!recent) return false;
  return writeRecentConnections(storage, [normalized, ...recent.filter((entry) => !sameConnection(entry, normalized))]);
}

/** Remove one preset. Null means storage was unavailable, so UI state should remain unchanged. */
export function removeRecentConnection(connection: RecentConnection): RecentConnection[] | null {
  const normalized = parseRecentConnection(connection);
  const storage = getStorage();
  if (!normalized || !storage) return null;
  const recent = readRecentConnections(storage);
  if (!recent) return null;
  const updated = recent.filter((entry) => !samePreset(entry, normalized));
  return writeRecentConnections(storage, updated) ? updated : null;
}

/** Clear all saved presets. Returns false if storage cannot be changed. */
export function clearRecentConnections() {
  const storage = getStorage();
  return storage ? writeRecentConnections(storage, []) : false;
}
