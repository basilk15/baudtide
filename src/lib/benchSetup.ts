import { normalizeCommandPresets, type SerialCommand } from './serialCommands';
import type { NativeSerialPort, SerialConnectionSettings, SerialDeviceIdentity } from './serial';
import type { DisplayEncoding, LineEnding } from './preferences';
import { normalizeTelemetryDecoderProfile, type TelemetryDecoderProfile } from './telemetryDecoders';

export type BenchConnectionPreset = {
  identity: string; port: string; baudRate: number; sessionName: string;
  settings: SerialConnectionSettings; deviceIdentity?: SerialDeviceIdentity | null;
  lineEnding: LineEnding; displayEncoding: DisplayEncoding; showTimestamps: boolean;
  reconnectWhenDeviceReturns: boolean; commands?: SerialCommand[]; decoder?: TelemetryDecoderProfile;
};

export function normalizeBenchConnection(value: unknown): BenchConnectionPreset | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as BenchConnectionPreset;
  const s = p.settings;
  if (typeof p.identity !== 'string' || !p.identity.startsWith('serial:') || p.identity.length > 8192
    || typeof p.port !== 'string' || !p.port.startsWith('/dev/') || p.port.length > 256 || /[\s\u0000]/u.test(p.port)
    || !Number.isSafeInteger(p.baudRate) || p.baudRate < 300 || p.baudRate > 4_000_000
    || typeof p.sessionName !== 'string' || !p.sessionName.trim() || new TextEncoder().encode(p.sessionName).length > 120
    || !s || ![5, 6, 7, 8].includes(s.dataBits) || !['none', 'odd', 'even'].includes(s.parity)
    || !['one', 'two'].includes(s.stopBits) || !['none', 'software', 'hardware'].includes(s.flowControl)
    || !['lf', 'crlf', 'cr', 'none'].includes(p.lineEnding) || !['utf8', 'ascii', 'hex'].includes(p.displayEncoding)
    || typeof p.showTimestamps !== 'boolean' || typeof p.reconnectWhenDeviceReturns !== 'boolean') return null;
  const d = p.deviceIdentity;
  if (d && (!Number.isInteger(d.vendorId) || d.vendorId < 0 || d.vendorId > 65535
    || !Number.isInteger(d.productId) || d.productId < 0 || d.productId > 65535
    || (d.serialNumber !== null && (typeof d.serialNumber !== 'string' || !d.serialNumber || d.serialNumber.length > 256))
    || (d.stablePath !== null && (typeof d.stablePath !== 'string' || !/^\/dev\/serial\/by-id\/[^/]+$/u.test(d.stablePath) || d.stablePath.length > 256)))) return null;
  const commands = p.commands === undefined ? undefined : normalizeCommandPresets(p.commands);
  if (commands === null) return null;
  const decoder = p.decoder === undefined ? undefined : normalizeTelemetryDecoderProfile(p.decoder);
  if (p.decoder !== undefined && !decoder) return null;
  return { identity: p.identity, port: p.port, baudRate: p.baudRate, sessionName: p.sessionName.trim(), settings: { ...s },
    ...(d ? { deviceIdentity: { ...d } } : {}), lineEnding: p.lineEnding, displayEncoding: p.displayEncoding,
    showTimestamps: p.showTimestamps, reconnectWhenDeviceReturns: p.reconnectWhenDeviceReturns, ...(decoder ? { decoder } : {}), ...(commands ? { commands } : {}) };
}

export type BenchOpenSession = { id: string; identity: string; legacyIdentity?: string; port: string; connected: boolean };
export type BenchRestoreRow = { preset: BenchConnectionPreset; existingId?: string; candidates: NativeSerialPort[];
  suggestedPort: string; status: 'open' | 'ready' | 'missing' | 'review' | 'conflict'; detail: string };

/** A reused tty name never substitutes for a saved USB identity. */
export function planBenchRestore(presets: readonly BenchConnectionPreset[], ports: readonly NativeSerialPort[], sessions: readonly BenchOpenSession[]): BenchRestoreRow[] {
  const rows = presets.map<BenchRestoreRow>((preset) => {
    const existing = sessions.filter((s) => s.identity === preset.identity || s.legacyIdentity === preset.identity);
    const base = { preset, candidates: [] as NativeSerialPort[], suggestedPort: '' };
    if (existing.length > 1) return { ...base, status: 'conflict', detail: 'Several terminal tabs match this target. Resolve them before restoring.' };
    if (existing[0]?.connected) return { ...base, existingId: existing[0].id, status: 'open', detail: `Keep the open terminal on ${existing[0].port}.` };
    const d = preset.deviceIdentity;
    // A model-only by-id alias can move between serialless identical adapters.
    const unique = Boolean(d?.serialNumber);
    const usbPath = /^\/dev\/(?:ttyUSB|ttyACM|serial\/)/u.test(preset.port);
    const candidates = ports.filter((port) => {
      const c = port.deviceIdentity;
      if (d) return Boolean(c && c.vendorId === d.vendorId && c.productId === d.productId
        && (!d.serialNumber || c.serialNumber === d.serialNumber)
        && (!d.stablePath || c.stablePath === d.stablePath));
      return port.path === preset.port;
    });
    const reserved = new Set(sessions.filter((s) => s.connected).map((s) => s.port));
    const available = candidates.filter((p) => !reserved.has(p.path));
    const row = { ...base, existingId: existing[0]?.id, candidates: available };
    if (candidates.length && !available.length) return { ...row, status: 'conflict', detail: 'The matching port is already open with other settings.' };
    if (!available.length && !d && !usbPath && preset.port.startsWith('/dev/pts/')) {
      // PTYs are manually entered and are not enumerated by serialport.
      return { ...row, status: 'review', detail: 'Confirm this manually entered PTY still belongs to your test process.' };
    }
    if (!available.length) return { ...row, status: 'missing', detail: 'The saved device is absent. Rescan after connecting it.' };
    if (candidates.length !== 1 || (usbPath && !unique) || (d && !unique)) return { ...row, status: 'review', detail: 'Select the intended port after checking the device.' };
    return { ...row, suggestedPort: available[0].path, status: 'ready', detail: `Restore on ${available[0].path}.` };
  });
  const duplicate = new Set(rows.filter((r) => r.suggestedPort && rows.filter((other) => other.suggestedPort === r.suggestedPort).length > 1).map((r) => r.suggestedPort));
  return rows.map((r) => duplicate.has(r.suggestedPort) ? { ...r, suggestedPort: '', status: 'conflict', detail: 'Several saved terminals target this port. Restore one at a time.' } : r);
}
