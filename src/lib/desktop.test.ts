import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function installWindow(bridge?: BaudTideDesktopBridge) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { baudtideDesktop: bridge },
  });
}

describe('Electron desktop bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    installWindow();
  });

  afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('detects only a complete preload bridge and forwards commands unchanged', async () => {
    const invoke = vi.fn(async () => ['tty-test']);
    const bridge: BaudTideDesktopBridge = {
      platform: 'linux',
      invoke: invoke as unknown as BaudTideDesktopBridge['invoke'],
      listen: () => () => undefined,
    };
    installWindow(bridge);
    const { invokeDesktop, isDesktopRuntime } = await import('./desktop');

    expect(isDesktopRuntime()).toBe(true);
    await expect(invokeDesktop<string[]>('list_serial_ports')).resolves.toEqual(['tty-test']);
    expect(invoke).toHaveBeenCalledWith('list_serial_ports', undefined);

    installWindow({ ...bridge, listen: undefined } as unknown as BaudTideDesktopBridge);
    expect(isDesktopRuntime()).toBe(false);
  });

  it('uses one renderer listener and fans serial data out by session', async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const listen = vi.fn(<T,>(eventName: 'serial-data' | 'serial-status', callback: (payload: T) => void) => {
      listeners.set(eventName, callback as (payload: unknown) => void);
      return () => listeners.delete(eventName);
    });
    installWindow({
      platform: 'linux',
      invoke: async <T,>() => undefined as T,
      listen,
    });
    const { listenForSerialData } = await import('./serial');
    const firstEvents: number[] = [];
    const secondEvents: number[] = [];
    const unlistenFirst = await listenForSerialData('first', (event) => firstEvents.push(event.sequence));
    await listenForSerialData('second', (event) => secondEvents.push(event.sequence));

    expect(listen).toHaveBeenCalledTimes(1);
    listeners.get('serial-data')?.({
      sessionId: 'first', port: '/dev/first', sequence: 1, timestamp: '', text: 'one', bytes: [1],
    });
    listeners.get('serial-data')?.({
      sessionId: 'second', port: '/dev/second', sequence: 2, timestamp: '', text: 'two', bytes: [2],
    });
    expect(firstEvents).toEqual([1]);
    expect(secondEvents).toEqual([2]);

    unlistenFirst();
    listeners.get('serial-data')?.({
      sessionId: 'first', port: '/dev/first', sequence: 3, timestamp: '', text: 'three', bytes: [3],
    });
    expect(firstEvents).toEqual([1]);
  });
});
