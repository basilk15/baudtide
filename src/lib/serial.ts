import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type NativeSerialPort = {
  path: string;
  label: string;
  manufacturer?: string;
  product?: string;
  serialNumber?: string;
  transport: 'usb' | 'bluetooth' | 'pci' | 'unknown';
};

export type SerialConnectionSettings = {
  dataBits: 5 | 6 | 7 | 8;
  parity: 'none' | 'odd' | 'even';
  stopBits: 'one' | 'two';
  flowControl: 'none' | 'software' | 'hardware';
};

export const defaultSerialConnectionSettings: SerialConnectionSettings = {
  dataBits: 8,
  parity: 'none',
  stopBits: 'one',
  flowControl: 'none',
};

export type StartedSerialSession = {
  id: string;
  port: string;
  baudRate: number;
  sessionName: string;
  logPath: string;
  state: 'connected';
  settings: SerialConnectionSettings;
};

/**
 * A session-scoped, read-only LAN link for the mobile companion. The pairing
 * token is deliberately contained only in `url`; do not display or persist it
 * separately.
 */
export type MobileShareInfo = {
  sessionId: string;
  url: string;
  host: string;
  port: number;
  clientCount: number;
  enabled: boolean;
};

export type SerialDataEvent = {
  sessionId: string;
  port: string;
  /** Monotonic per native session; used to merge startup replay with live data. */
  sequence: number;
  timestamp: string;
  text: string;
  bytes: number[];
};

export type PendingSerialData = {
  events: SerialDataEvent[];
  droppedEventCount: number;
  nextSequence: number;
};

export type SerialStatusEvent = {
  sessionId: string;
  port: string;
  status: 'connected' | 'disconnected' | 'error' | 'storage-limit';
  message: string;
};

export type SavedLog = {
  path: string;
  fileName: string;
  sessionName: string;
  port?: string;
  baudRate?: number;
  /** Present only when the capture sidecar retained complete serial framing. */
  settings?: SerialConnectionSettings;
  sizeBytes: number;
  modifiedAt: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  metadataAvailable: boolean;
  state: 'capturing' | 'disconnected' | 'error' | 'quota-reached' | 'interrupted' | 'saved' | 'unknown';
};

export type SavedLogContent = {
  path: string;
  text: string;
  truncated: boolean;
};

export type SavedLogSearchMatch = {
  source: 'content' | 'metadata';
  byteOffset?: number;
  snippet?: string;
};

export type SavedLogSearchResult = {
  log: SavedLog;
  metadataMatch: boolean;
  contentMatchCount: number;
  contentMatches: SavedLogSearchMatch[];
  contentSearchTruncated: boolean;
};

export type SavedLogSearchResponse = {
  results: SavedLogSearchResult[];
  scannedLogCount: number;
  scannedBytes: number;
  fullSearch: boolean;
  truncated: boolean;
  resultLimitReached: boolean;
  perLogByteLimit: number | null;
  totalByteLimit: number | null;
  resultLimit: number;
  /** Complete-capture search statistics for the persistent local text index. */
  indexedLogCount: number;
  indexRebuiltLogCount: number;
  indexFallbackLogCount: number;
  indexUpdateLimited: boolean;
};

export function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function ensureNativeRuntime() {
  if (!isTauriRuntime()) throw new Error('Serial ports are available only in the BaudTide desktop app.');
}

export async function listNativeSerialPorts() {
  ensureNativeRuntime();
  return invoke<NativeSerialPort[]>('list_serial_ports');
}

export type StartNativeSerialSessionRequest = {
  port: string;
  baudRate: number;
  sessionName: string;
  settings: SerialConnectionSettings;
};

export async function startNativeSerialSession(request: StartNativeSerialSessionRequest) {
  ensureNativeRuntime();
  return invoke<StartedSerialSession>('start_serial_session', { request });
}

export async function listActiveNativeSerialSessions() {
  ensureNativeRuntime();
  return invoke<StartedSerialSession[]>('list_active_sessions');
}

export async function takePendingNativeSerialData(sessionId: string) {
  ensureNativeRuntime();
  return invoke<PendingSerialData>('take_pending_serial_data', { sessionId });
}

export async function chooseNativeLogDirectory() {
  ensureNativeRuntime();
  return invoke<string | null>('select_log_directory');
}

export async function sendNativeSerialText(sessionId: string, text: string) {
  ensureNativeRuntime();
  return invoke<number>('send_serial_text', { sessionId, text });
}

/** Send an exact byte payload without text encoding or a line ending. */
export async function sendNativeSerialBytes(sessionId: string, bytes: number[]) {
  ensureNativeRuntime();
  return invoke<number>('send_serial_bytes', { sessionId, bytes });
}

export async function disconnectNativeSerialSession(sessionId: string) {
  ensureNativeRuntime();
  return invoke<StartedSerialSession>('disconnect_serial_session', { sessionId });
}

export async function startMobileShare(sessionId: string) {
  ensureNativeRuntime();
  return invoke<MobileShareInfo>('start_mobile_share', { sessionId });
}

export async function getMobileShareStatus(sessionId: string) {
  ensureNativeRuntime();
  return invoke<MobileShareInfo>('get_mobile_share_status', { sessionId });
}

export async function stopMobileShare(sessionId: string) {
  ensureNativeRuntime();
  return invoke<MobileShareInfo>('stop_mobile_share', { sessionId });
}

export async function listNativeSavedLogs() {
  ensureNativeRuntime();
  return invoke<SavedLog[]>('list_saved_logs');
}

export async function searchNativeSavedLogs(query: string, fullSearch = false, searchId?: string) {
  ensureNativeRuntime();
  return invoke<SavedLogSearchResponse>('search_saved_logs', { query, options: { fullSearch, searchId } });
}

export async function cancelNativeSavedLogSearch(searchId: string) {
  ensureNativeRuntime();
  return invoke<void>('cancel_saved_log_search', { searchId });
}

export async function readNativeSavedLog(path: string) {
  ensureNativeRuntime();
  return invoke<SavedLogContent>('read_saved_log', { path });
}

export async function deleteNativeSavedLog(path: string) {
  ensureNativeRuntime();
  return invoke<void>('delete_saved_log', { path });
}

export async function saveNativeSavedLog(sourcePath: string) {
  ensureNativeRuntime();
  const savedPath = await invoke<string | null>('save_saved_log', { sourcePath });
  if (!savedPath) return null;
  window.dispatchEvent(new CustomEvent<{ sourcePath: string; savedPath: string }>('baudtide:log-exported', {
    detail: { sourcePath, savedPath },
  }));
  return savedPath;
}

export async function listenForSerialData(sessionId: string, handler: (event: SerialDataEvent) => void): Promise<UnlistenFn> {
  ensureNativeRuntime();
  return listen<SerialDataEvent>('serial-data', (event) => {
    if (event.payload.sessionId === sessionId) handler(event.payload);
  });
}

export async function listenForSerialStatus(sessionId: string, handler: (event: SerialStatusEvent) => void): Promise<UnlistenFn> {
  ensureNativeRuntime();
  return listen<SerialStatusEvent>('serial-status', (event) => {
    if (event.payload.sessionId === sessionId) handler(event.payload);
  });
}
