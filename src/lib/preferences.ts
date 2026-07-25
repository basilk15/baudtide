import { invoke } from '@tauri-apps/api/core';

export const SETTINGS_VERSION = 1 as const;

export type LineEnding = 'lf' | 'crlf' | 'cr' | 'none';
export type DisplayEncoding = 'utf8' | 'ascii' | 'hex';
export type AppTheme = 'dark' | 'light';

export type BaudTidePreferences = {
  version: typeof SETTINGS_VERSION;
  serial: {
    baudRate: number;
    lineEnding: LineEnding;
    displayEncoding: DisplayEncoding;
    showTimestamps: boolean;
    reconnectWhenDeviceReturns: boolean;
  };
  storage: {
    /** Empty means BaudTide's app-data log folder. */
    logDirectory: string;
    /** Hard cap for the managed raw-capture library. */
    storageLimitBytes: number;
  };
  appearance: { theme: AppTheme };
};

export const DEFAULT_PREFERENCES: BaudTidePreferences = {
  version: SETTINGS_VERSION,
  serial: {
    baudRate: 115200,
    lineEnding: 'lf',
    displayEncoding: 'utf8',
    showTimestamps: true,
    reconnectWhenDeviceReturns: true,
  },
  storage: { logDirectory: '', storageLimitBytes: 10 * 1024 ** 3 },
  appearance: { theme: 'dark' },
};

const browserStorageKey = 'baudtide.preferences.v1';
const baudRates = new Set([9600, 57600, 115200, 230400]);
const lineEndings = new Set<LineEnding>(['lf', 'crlf', 'cr', 'none']);
const encodings = new Set<DisplayEncoding>(['utf8', 'ascii', 'hex']);
const themes = new Set<AppTheme>(['dark', 'light']);
const storageLimits = new Set([2, 5, 10, 25].map((gigabytes) => gigabytes * 1024 ** 3));

/**
 * Keep this check in the shared preferences layer as well as the Preferences
 * screen. That way programmatic callers cannot save a path which the desktop
 * backend would reject when the next serial session starts.
 */
export function logDirectoryValidationError(directory: string): string | null {
  if (!directory) return null;
  // Support native absolute paths on the platforms BaudTide targets. The
  // backend repeats the platform-specific validation before writing settings.
  const isAbsolute = directory.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(directory)
    || /^\\\\[^\\]+\\[^\\]+/.test(directory);
  return isAbsolute ? null : 'Log folder must be an absolute path. Choose a folder or enter a full path.';
}

function cloneDefaults(): BaudTidePreferences {
  return {
    ...DEFAULT_PREFERENCES,
    serial: { ...DEFAULT_PREFERENCES.serial },
    storage: { ...DEFAULT_PREFERENCES.storage },
    appearance: { ...DEFAULT_PREFERENCES.appearance },
  };
}

export function defaultPreferences(): BaudTidePreferences {
  return cloneDefaults();
}

/** Accept only the current settings schema and independently repair invalid fields. */
export function normalizePreferences(candidate: unknown): BaudTidePreferences {
  const defaults = cloneDefaults();
  if (!candidate || typeof candidate !== 'object') return defaults;
  const value = candidate as Partial<BaudTidePreferences>;
  if (value.version !== SETTINGS_VERSION) return defaults;
  const serial = value.serial;
  const storage = value.storage;
  const appearance = value.appearance;
  return {
    version: SETTINGS_VERSION,
    serial: {
      baudRate: serial && baudRates.has(serial.baudRate as number) ? serial.baudRate : defaults.serial.baudRate,
      lineEnding: serial && lineEndings.has(serial.lineEnding as LineEnding) ? serial.lineEnding : defaults.serial.lineEnding,
      displayEncoding: serial && encodings.has(serial.displayEncoding as DisplayEncoding) ? serial.displayEncoding : defaults.serial.displayEncoding,
      showTimestamps: typeof serial?.showTimestamps === 'boolean' ? serial.showTimestamps : defaults.serial.showTimestamps,
      reconnectWhenDeviceReturns: typeof serial?.reconnectWhenDeviceReturns === 'boolean' ? serial.reconnectWhenDeviceReturns : defaults.serial.reconnectWhenDeviceReturns,
    },
    storage: {
      logDirectory: typeof storage?.logDirectory === 'string' ? storage.logDirectory.trim() : defaults.storage.logDirectory,
      storageLimitBytes: storage && storageLimits.has(storage.storageLimitBytes as number) ? storage.storageLimitBytes : defaults.storage.storageLimitBytes,
    },
    appearance: { theme: appearance && themes.has(appearance.theme as AppTheme) ? appearance.theme : defaults.appearance.theme },
  };
}

function readBrowserPreferences() {
  try {
    return normalizePreferences(JSON.parse(window.localStorage.getItem(browserStorageKey) ?? 'null'));
  } catch {
    return cloneDefaults();
  }
}

function writeBrowserPreferences(settings: BaudTidePreferences) {
  try {
    window.localStorage.setItem(browserStorageKey, JSON.stringify(settings));
  } catch {
    // Preview storage can be unavailable (private browsing, disabled storage). The caller
    // still receives a valid in-memory value rather than breaking the settings screen.
  }
}

export function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function loadPreferences(): Promise<BaudTidePreferences> {
  if (isTauriRuntime()) {
    try {
      return normalizePreferences(await invoke<unknown>('load_preferences'));
    } catch {
      // Keep the UI usable if the desktop settings file cannot be read.
    }
  }
  return readBrowserPreferences();
}

export async function savePreferences(settings: BaudTidePreferences): Promise<BaudTidePreferences> {
  const normalized = normalizePreferences(settings);
  const logDirectoryError = logDirectoryValidationError(normalized.storage.logDirectory);
  if (logDirectoryError) throw new Error(logDirectoryError);
  if (isTauriRuntime()) {
    // Do not fall back to browser storage here: native validation or write failures
    // must remain visible so the displayed destination cannot diverge from the one
    // desktop sessions will actually use.
    return normalizePreferences(await invoke<unknown>('save_preferences', { settings: normalized }));
  }
  writeBrowserPreferences(normalized);
  return normalized;
}

export function lineEndingText(value: LineEnding) {
  return { lf: '\n', crlf: '\r\n', cr: '\r', none: '' }[value];
}
