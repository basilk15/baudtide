import { describe, expect, it, vi } from 'vitest';
import { normalizeBenchConnection, planBenchRestore, type BenchConnectionPreset } from './benchSetup';
import { defaultSerialConnectionSettings, type NativeSerialPort } from './serial';
import { normalizeSessionWorkspaces, saveSessionWorkspace, stableTerminalSessionIdentity, updateSessionWorkspace, loadSessionWorkspaces } from './sessionWorkspaces';

const device = { vendorId: 4292, productId: 60000, serialNumber: 'board-A', stablePath: null };
const connection = { port: '/dev/ttyUSB0', baudRate: 115200, sessionName: 'Sensor', settings: defaultSerialConnectionSettings, deviceIdentity: device };
const preset: BenchConnectionPreset = { ...connection, identity: stableTerminalSessionIdentity(connection), lineEnding: 'crlf', displayEncoding: 'hex', showTimestamps: false, reconnectWhenDeviceReturns: false };
function port(path: string, serialNumber: string | null = 'board-A'): NativeSerialPort { return { path, label: 'USB', transport: 'usb', deviceIdentity: { ...device, serialNumber } }; }
const open = { id: 'native', identity: preset.identity, port: '/dev/ttyUSB4', connected: true };

describe('bench setup restoration', () => {
  it('follows uniquely identified devices and refuses a reused tty name', () => {
    const [row] = planBenchRestore([preset], [port('/dev/ttyUSB0', 'board-B'), port('/dev/ttyUSB4')], []);
    expect(row.status).toBe('ready'); expect(row.suggestedPort).toBe('/dev/ttyUSB4');
    expect(planBenchRestore([preset], [port('/dev/ttyUSB0', 'board-B')], [])[0].status).toBe('missing');
  });
  it('requires deliberate review for duplicate identities and unnamed USB adapters', () => {
    const [duplicate] = planBenchRestore([preset], [port('/dev/ttyUSB0'), port('/dev/ttyUSB1')], []);
    expect(duplicate.status).toBe('review'); expect(duplicate.suggestedPort).toBe('');
    const unknown = { ...preset, deviceIdentity: { ...device, serialNumber: null } };
    expect(planBenchRestore([unknown], [port('/dev/ttyUSB0', null)], [])[0].status).toBe('review');
    expect(planBenchRestore([{ ...preset, deviceIdentity: undefined }], [port('/dev/ttyUSB0')], [])[0].status).toBe('review');
  });
  it('preserves an open terminal and detects reserved ports and conflicting saved settings', () => {
    expect(planBenchRestore([preset], [], [open])[0]).toMatchObject({ status: 'open', existingId: 'native' });
    expect(planBenchRestore([preset], [port('/dev/ttyUSB4')], [{ ...open, identity: 'other' }])[0].status).toBe('conflict');
    const another = { ...preset, identity: 'serial:other', baudRate: 9600 };
    expect(planBenchRestore([preset, another], [port('/dev/ttyUSB4')], []).map((r) => r.status)).toEqual(['conflict', 'conflict']);
    expect(planBenchRestore([preset], [], [open, { ...open, id: 'second' }])[0].status).toBe('conflict');
  });
  it('requires review for a serialless adapter even when its by-id alias matches', () => {
    const identity = { ...device, serialNumber: null, stablePath: '/dev/serial/by-id/usb-model-if00' };
    const unknown = { ...preset, deviceIdentity: identity };
    const replacement = { ...port('/dev/ttyUSB1', null), deviceIdentity: identity };
    expect(planBenchRestore([unknown], [replacement], [])[0]).toMatchObject({
      status: 'review', suggestedPort: '', candidates: [replacement],
    });
  });
  it('keeps multi-interface aliases distinct and treats missing interfaces as missing', () => {
    const selected = { ...preset, deviceIdentity: { ...device, stablePath: '/dev/serial/by-id/board-if00' } };
    const wrong = { ...port('/dev/ttyUSB1'), deviceIdentity: { ...device, stablePath: '/dev/serial/by-id/board-if01' } };
    expect(planBenchRestore([selected], [wrong], [])[0].status).toBe('missing');
  });
  it('requires confirmation for a manually entered PTY and retains its framing', () => {
    const pty = { ...preset, port: '/dev/pts/11', deviceIdentity: undefined };
    expect(planBenchRestore([pty], [], [])[0]).toMatchObject({ status: 'review', suggestedPort: '' });
    expect(normalizeBenchConnection(preset)).toEqual(preset);
    for (const invalid of [{ ...preset, baudRate: 0 }, { ...preset, settings: { ...preset.settings, dataBits: 9 } }, { ...preset, lineEnding: 'bad' }, { ...preset, deviceIdentity: { ...device, stablePath: '/etc/passwd' } }]) expect(normalizeBenchConnection(invalid)).toBeNull();
  });
  it('reads legacy layouts and round-trips complete setups without native session IDs', () => {
    const legacy = { id: 'old', name: 'Old', layout: 'tabs', sessionIdentities: [preset.identity], selectedSessionIdentity: preset.identity, createdAt: 1000, updatedAt: 1000 };
    expect(normalizeSessionWorkspaces({ version: 1, workspaces: [legacy] })).toEqual([legacy]);
    const setup = { ...legacy, connections: [preset], analysisWorkspaceId: 'analysis' };
    expect(normalizeSessionWorkspaces({ version: 1, workspaces: [setup] })).toEqual([setup]);
    expect(normalizeSessionWorkspaces({ version: 1, workspaces: [{ ...setup, connections: [] }] })).toEqual([]);
    expect(normalizeSessionWorkspaces({ version: 1, workspaces: [{ ...setup, connections: [{ ...preset, identity: 'other' }] }] })).toEqual([]);
  });
  it('upgrades a saved layout in place and preserves the creation time', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
    try {
      const snapshot = { name: 'Bench', layout: 'tiled' as const, sessionIdentities: [preset.identity], selectedSessionIdentity: preset.identity };
      const saved = saveSessionWorkspace(snapshot); expect(saved.ok).toBe(true); if (!saved.ok) return;
      const updated = updateSessionWorkspace(saved.workspace.id, { ...snapshot, connections: [preset], analysisWorkspaceId: 'analysis' });
      expect(updated.ok).toBe(true); if (!updated.ok) return;
      expect(updated.workspace.id).toBe(saved.workspace.id); expect(updated.workspace.createdAt).toBe(saved.workspace.createdAt);
      expect(loadSessionWorkspaces().workspaces).toEqual([updated.workspace]);
    } finally { vi.unstubAllGlobals(); }
  });
});
