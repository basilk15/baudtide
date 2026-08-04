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

/** Read local-only, validated connection presets without ever blocking the dialog. */
export function loadRecentConnections(): RecentConnection[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseRecentConnection).filter((entry): entry is RecentConnection => entry !== null).slice(0, MAX_RECENT_CONNECTIONS);
  } catch {
    return [];
  }
}

/** Store only successful settings. Storage errors (including private mode) are non-fatal. */
export function saveRecentConnection(connection: RecentConnection) {
  if (typeof window === 'undefined') return;
  const normalized = parseRecentConnection(connection);
  if (!normalized) return;
  try {
    const recent = loadRecentConnections().filter((entry) => !sameConnection(entry, normalized));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([normalized, ...recent].slice(0, MAX_RECENT_CONNECTIONS)));
  } catch {
    // Keep connection setup usable if localStorage is unavailable.
  }
}
