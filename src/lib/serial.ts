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

export type StartedSerialSession = {
  id: string;
  port: string;
  baudRate: number;
  sessionName: string;
  logPath: string;
  state: 'connected';
};

export type SerialDataEvent = {
  sessionId: string;
  port: string;
  timestamp: string;
  text: string;
  bytes: number[];
};

export type SerialStatusEvent = {
  sessionId: string;
  port: string;
  status: 'connected' | 'disconnected' | 'error';
  message: string;
};

export type SavedLog = {
  path: string;
  fileName: string;
  sessionName: string;
  port?: string;
  baudRate?: number;
  sizeBytes: number;
  modifiedAt: string;
  state: 'capturing' | 'saved';
};

export type SavedLogContent = {
  path: string;
  text: string;
  truncated: boolean;
};

export function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function ensureNativeRuntime() {
  if (!isTauriRuntime()) throw new Error('Serial ports are available only in the SignalDeck desktop app.');
}

export async function listNativeSerialPorts() {
  ensureNativeRuntime();
  return invoke<NativeSerialPort[]>('list_serial_ports');
}

export async function startNativeSerialSession(request: { port: string; baudRate: number; sessionName: string; logPath?: string }) {
  ensureNativeRuntime();
  return invoke<StartedSerialSession>('start_serial_session', { request });
}

export async function sendNativeSerialText(sessionId: string, text: string) {
  ensureNativeRuntime();
  return invoke<number>('send_serial_text', { sessionId, text });
}

export async function disconnectNativeSerialSession(sessionId: string) {
  ensureNativeRuntime();
  return invoke<StartedSerialSession>('disconnect_serial_session', { sessionId });
}

export async function listNativeSavedLogs() {
  ensureNativeRuntime();
  return invoke<SavedLog[]>('list_saved_logs');
}

export async function readNativeSavedLog(path: string) {
  ensureNativeRuntime();
  return invoke<SavedLogContent>('read_saved_log', { path });
}

export async function saveNativeSavedLog(sourcePath: string, destinationPath: string) {
  ensureNativeRuntime();
  return invoke<string>('save_saved_log', { sourcePath, destinationPath });
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
