import {
  invokeDesktop,
  isDesktopRuntime,
  listenDesktop,
  type DesktopUnlisten,
} from './desktop';

type UnlistenFn = DesktopUnlisten;

export type SerialDeviceIdentity = {
  vendorId: number;
  productId: number;
  serialNumber: string | null;
  stablePath: string | null;
};

export type NativeSerialPort = {
  path: string;
  label: string;
  manufacturer?: string;
  product?: string;
  serialNumber?: string;
  transport: 'usb' | 'bluetooth' | 'pci' | 'unknown';
  deviceIdentity?: SerialDeviceIdentity | null;
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
  deviceIdentity?: SerialDeviceIdentity | null;
};

/**
 * A session-scoped LAN link for the mobile companion. The pairing token is
 * deliberately contained only in `url`; do not display or persist it
 * separately. Remote control is always disabled until the desktop explicitly
 * enables it for this link.
 */
export type MobileShareInfo = {
  sessionId: string;
  url: string;
  host: string;
  port: number;
  clientCount: number;
  enabled: boolean;
  controlEnabled: boolean;
};

export type MobileWorkspaceShareInfo = {
  url: string;
  host: string;
  port: number;
  clientCount: number;
  sessionCount: number;
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

type SerialDataHandler = (event: SerialDataEvent) => void;
type SerialStatusHandler = (event: SerialStatusEvent) => void;

// Desktop events are global to the renderer. Keep one native listener per event
// type and fan out only to the matching session. A listener per mounted
// terminal makes every incoming chunk visit every hidden tab as well.
const serialDataHandlers = new Map<string, Set<SerialDataHandler>>();
const serialStatusHandlers = new Map<string, Set<SerialStatusHandler>>();
let serialDataListenerPromise: Promise<UnlistenFn> | null = null;
let serialStatusListenerPromise: Promise<UnlistenFn> | null = null;

function ensureSerialDataListener() {
  if (!serialDataListenerPromise) {
    serialDataListenerPromise = Promise.resolve().then(() => listenDesktop<SerialDataEvent>('serial-data', (payload) => {
      const handlers = serialDataHandlers.get(payload.sessionId);
      if (!handlers) return;
      handlers.forEach((handler) => handler(payload));
    })).catch((error) => {
      serialDataListenerPromise = null;
      throw error;
    });
  }
  return serialDataListenerPromise;
}

function ensureSerialStatusListener() {
  if (!serialStatusListenerPromise) {
    serialStatusListenerPromise = Promise.resolve().then(() => listenDesktop<SerialStatusEvent>('serial-status', (payload) => {
      const handlers = serialStatusHandlers.get(payload.sessionId);
      if (!handlers) return;
      handlers.forEach((handler) => handler(payload));
    })).catch((error) => {
      serialStatusListenerPromise = null;
      throw error;
    });
  }
  return serialStatusListenerPromise;
}

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

export type CaptureReceiveTiming = Readonly<{ endOffset: number; timestampMs: number }>;
export type SavedTelemetryLogContent = SavedLogContent & {
  timing?: readonly CaptureReceiveTiming[] | null;
  /** Original bytes keep timing offsets correct even for split/invalid UTF-8. */
  rawBase64?: string | null;
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

function ensureNativeRuntime() {
  if (!isDesktopRuntime()) throw new Error('Serial ports are available only in the BaudTide desktop app.');
}

export async function listNativeSerialPorts() {
  ensureNativeRuntime();
  return invokeDesktop<NativeSerialPort[]>('list_serial_ports');
}

export type StartNativeSerialSessionRequest = {
  port: string;
  baudRate: number;
  sessionName: string;
  settings: SerialConnectionSettings;
  deviceIdentity?: SerialDeviceIdentity | null;
  automaticReconnect?: boolean;
  reviewedPort?: boolean;
};

export async function startNativeSerialSession(request: StartNativeSerialSessionRequest) {
  ensureNativeRuntime();
  return invokeDesktop<StartedSerialSession>('start_serial_session', { request });
}

export async function listActiveNativeSerialSessions() {
  ensureNativeRuntime();
  return invokeDesktop<StartedSerialSession[]>('list_active_sessions');
}

export async function takePendingNativeSerialData(sessionId: string) {
  ensureNativeRuntime();
  return invokeDesktop<PendingSerialData>('take_pending_serial_data', { sessionId });
}

export async function chooseNativeLogDirectory() {
  ensureNativeRuntime();
  return invokeDesktop<string | null>('select_log_directory');
}

export async function sendNativeSerialText(sessionId: string, text: string) {
  ensureNativeRuntime();
  return invokeDesktop<number>('send_serial_text', { sessionId, text });
}

/** Send an exact byte payload without text encoding or a line ending. */
export async function sendNativeSerialBytes(sessionId: string, bytes: number[]) {
  ensureNativeRuntime();
  return invokeDesktop<number>('send_serial_bytes', { sessionId, bytes });
}

export async function disconnectNativeSerialSession(sessionId: string) {
  ensureNativeRuntime();
  return invokeDesktop<StartedSerialSession>('disconnect_serial_session', { sessionId });
}

export async function startMobileShare(sessionId: string) {
  ensureNativeRuntime();
  return invokeDesktop<MobileShareInfo>('start_mobile_share', { sessionId });
}

export async function getMobileShareStatus(sessionId: string) {
  ensureNativeRuntime();
  return invokeDesktop<MobileShareInfo>('get_mobile_share_status', { sessionId });
}

export async function stopMobileShare(sessionId: string) {
  ensureNativeRuntime();
  return invokeDesktop<MobileShareInfo>('stop_mobile_share', { sessionId });
}

export async function setMobileShareControl(sessionId: string, enabled: boolean) {
  ensureNativeRuntime();
  return invokeDesktop<MobileShareInfo>('set_mobile_share_control', { sessionId, enabled });
}

export async function startMobileWorkspaceShare() {
  ensureNativeRuntime();
  return invokeDesktop<MobileWorkspaceShareInfo>('start_mobile_workspace_share');
}

export async function getMobileWorkspaceShareStatus() {
  ensureNativeRuntime();
  return invokeDesktop<MobileWorkspaceShareInfo>('get_mobile_workspace_share_status');
}

export async function stopMobileWorkspaceShare() {
  ensureNativeRuntime();
  return invokeDesktop<MobileWorkspaceShareInfo>('stop_mobile_workspace_share');
}

export async function listNativeSavedLogs() {
  ensureNativeRuntime();
  return invokeDesktop<SavedLog[]>('list_saved_logs');
}

export async function searchNativeSavedLogs(query: string, fullSearch = false, searchId?: string) {
  ensureNativeRuntime();
  return invokeDesktop<SavedLogSearchResponse>('search_saved_logs', { query, options: { fullSearch, searchId } });
}

export async function cancelNativeSavedLogSearch(searchId: string) {
  ensureNativeRuntime();
  return invokeDesktop<void>('cancel_saved_log_search', { searchId });
}

export async function readNativeSavedLog(path: string) {
  ensureNativeRuntime();
  return invokeDesktop<SavedLogContent>('read_saved_log', { path });
}

/** Reads a larger, still bounded capture window for telemetry replay. */
export async function readNativeTelemetryLog(path: string) {
  ensureNativeRuntime();
  return invokeDesktop<SavedTelemetryLogContent>('read_saved_log_telemetry', { path });
}

export type CaptureAnalysisHandle = { id: string; totalBytes: number; timingMode: 'recorded' | 'approximate' };
export type CaptureAnalysisChunk = { offset: number; nextOffset: number; totalBytes: number; rawBase64: string; timing: CaptureReceiveTiming[] | null };
export function openNativeCaptureAnalysis(path: string) { return invokeDesktop<CaptureAnalysisHandle>('open_capture_analysis', { path }); }
export function readNativeCaptureAnalysisChunk(id: string) { return invokeDesktop<CaptureAnalysisChunk>('read_capture_analysis_chunk', { id }); }
export function closeNativeCaptureAnalysis(id: string) { return invokeDesktop<void>('close_capture_analysis', { id }); }
export function beginNativeTelemetryExport(format: 'csv' | 'json', defaultName: string) { return invokeDesktop<string | null>('begin_telemetry_export', { format, defaultName }); }
export function appendNativeTelemetryExport(id: string, contents: string) { return invokeDesktop<void>('append_telemetry_export', { id, contents }); }
export function finishNativeTelemetryExport(id: string) { return invokeDesktop<string>('finish_telemetry_export', { id }); }
export function cancelNativeTelemetryExport(id: string) { return invokeDesktop<void>('cancel_telemetry_export', { id }); }

export async function getNativeCaptureStorageUsage() {
  ensureNativeRuntime();
  return invokeDesktop<number>('get_capture_storage_usage');
}

export async function exportNativeTelemetryData(contents: string, format: 'csv' | 'json', defaultName: string) {
  ensureNativeRuntime();
  return invokeDesktop<string | null>('export_telemetry_data', { contents, format, defaultName });
}

export async function deleteNativeSavedLog(path: string) {
  ensureNativeRuntime();
  return invokeDesktop<void>('delete_saved_log', { path });
}

export async function saveNativeSavedLog(sourcePath: string) {
  ensureNativeRuntime();
  const savedPath = await invokeDesktop<string | null>('save_saved_log', { sourcePath });
  if (!savedPath) return null;
  window.dispatchEvent(new CustomEvent<{ sourcePath: string; savedPath: string }>('baudtide:log-exported', {
    detail: { sourcePath, savedPath },
  }));
  return savedPath;
}

export async function listenForSerialData(sessionId: string, handler: (event: SerialDataEvent) => void): Promise<UnlistenFn> {
  ensureNativeRuntime();
  const handlers = serialDataHandlers.get(sessionId) ?? new Set<SerialDataHandler>();
  handlers.add(handler);
  serialDataHandlers.set(sessionId, handlers);
  try {
    await ensureSerialDataListener();
  } catch (error) {
    handlers.delete(handler);
    if (!handlers.size) serialDataHandlers.delete(sessionId);
    throw error;
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    handlers.delete(handler);
    if (!handlers.size) serialDataHandlers.delete(sessionId);
  };
}

export async function listenForSerialStatus(sessionId: string, handler: (event: SerialStatusEvent) => void): Promise<UnlistenFn> {
  ensureNativeRuntime();
  const handlers = serialStatusHandlers.get(sessionId) ?? new Set<SerialStatusHandler>();
  handlers.add(handler);
  serialStatusHandlers.set(sessionId, handlers);
  try {
    await ensureSerialStatusListener();
  } catch (error) {
    handlers.delete(handler);
    if (!handlers.size) serialStatusHandlers.delete(sessionId);
    throw error;
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    handlers.delete(handler);
    if (!handlers.size) serialStatusHandlers.delete(sessionId);
  };
}
