import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRepeater, commandBytes, normalizeCommandPresets, loadCommandPresets, saveCommandPresets, type SerialCommand } from './serialCommands';
import { normalizeBenchConnection } from './benchSetup';
import { normalizeSessionWorkspaces, stableTerminalSessionIdentity } from './sessionWorkspaces';
import { defaultSerialConnectionSettings } from './serial';
const command: SerialCommand = { id: 'calibration', name: 'Read calibration', payload: 'READ', mode: 'text', lineEnding: 'crlf' };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('saved serial commands', () => {
  it('sends exact text and hex bytes including UTF-8 and line endings', () => {
    expect(commandBytes(command)).toEqual([82, 69, 65, 68, 13, 10]);
    expect(commandBytes({ ...command, mode: 'hex', payload: '0x00, FF 0d 0a' })).toEqual([0, 255, 13, 10]);
    expect(commandBytes({ ...command, payload: 'é', lineEnding: 'none' })).toEqual([195, 169]);
    expect(() => commandBytes({ ...command, mode: 'hex', payload: 'FF,,00' })).toThrow();
    expect(() => commandBytes({ ...command, payload: 'é'.repeat(32768) })).toThrow();
  });
  it('rejects malformed, duplicate and oversized presets', () => {
    expect(normalizeCommandPresets([command])).toEqual([command]);
    for (const value of [[command, command], [{ ...command, mode: 'binary' }], [{ ...command, payload: '' }], [{ ...command, lineEnding: 'invalid' }], Array(25).fill(command)]) expect(normalizeCommandPresets(value)).toBeNull();
  });
  it('round-trips presets in a bench setup while preserving legacy setups', () => {
    const connection = { port: '/dev/pts/1', baudRate: 115200, sessionName: 'Bench', settings: defaultSerialConnectionSettings };
    const preset = { ...connection, identity: stableTerminalSessionIdentity(connection), lineEnding: 'lf', displayEncoding: 'utf8', showTimestamps: true, reconnectWhenDeviceReturns: false, commands: [command] };
    expect(normalizeBenchConnection(preset)?.commands).toEqual([command]);
    expect(normalizeBenchConnection({ ...preset, commands: undefined })?.commands).toBeUndefined();
    const saved = { id: 'bench', name: 'Bench', layout: 'tabs', sessionIdentities: [preset.identity], selectedSessionIdentity: null, connections: [preset], createdAt: 100, updatedAt: 100 };
    expect(normalizeSessionWorkspaces({ version: 1, workspaces: [saved] })[0]?.connections?.[0].commands).toEqual([command]);
    expect(normalizeSessionWorkspaces({ version: 1, workspaces: [{ ...saved, connections: [{ ...preset, commands: [{}] }] }] })).toEqual([]);
  });
  it('keeps device stores separate and surfaces read/write failures', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) }, dispatchEvent: vi.fn() });
    vi.stubGlobal('CustomEvent', class { constructor(public name: string) {} });
    saveCommandPresets('board-a', [command]);
    expect(loadCommandPresets('board-a')).toEqual([command]);
    expect(loadCommandPresets('board-b')).toEqual([]);
    data.set('baudtide.command-presets.v1.board-a', '{damaged');
    expect(() => loadCommandPresets('board-a')).toThrow();
    vi.stubGlobal('window', { localStorage: { setItem: () => { throw new Error('Full'); } } });
    expect(() => saveCommandPresets('board-a', [command])).toThrow('Full');
  });
});

describe('repeat lifecycle', () => {
  it('stops immediately without overlap or restarting after a late write', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const send = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const repeat = new CommandRepeater();
    repeat.start(send, 100, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    repeat.stop(); finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('writes serially and stops on failure', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Disconnected'));
    const error = vi.fn(); const repeat = new CommandRepeater();
    repeat.start(send, 100, error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2); expect(error).toHaveBeenCalledOnce();
  });
  it('does not revive an old run after stop and restart', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const oldSend = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const newSend = vi.fn().mockResolvedValue(undefined);
    const repeat = new CommandRepeater();
    repeat.start(oldSend, 100, vi.fn()); repeat.stop(); repeat.start(newSend, 100, vi.fn());
    finish(); await vi.advanceTimersByTimeAsync(200); repeat.stop();
    expect(oldSend).toHaveBeenCalledOnce(); expect(newSend).toHaveBeenCalledTimes(3);
  });
  it('rejects invalid intervals without sending', () => {
    const repeat = new CommandRepeater(); const send = vi.fn();
    for (const interval of [0, 99, Infinity, NaN, 3600001, 100.5]) expect(() => repeat.start(send, interval, vi.fn())).toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
