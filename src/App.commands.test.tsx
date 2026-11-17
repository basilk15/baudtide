// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultPreferences } from './lib/preferences/preferences';
import { saveCommandSequences } from './lib/serial/commandSequences';
import App from './App';

const desktop = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, Set<(event: unknown) => void>>() }));
vi.mock('./lib/desktop', () => ({
  isDesktopRuntime: () => true,
  invokeDesktop: desktop.invoke,
  listenDesktop: (name: string, callback: (event: unknown) => void) => {
    const listeners = desktop.listeners.get(name) ?? new Set<(event: unknown) => void>();
    listeners.add(callback);
    desktop.listeners.set(name, listeners);
    return () => { listeners.delete(callback); };
  },
}));

let host: HTMLDivElement;
let root: Root;
let writes: string[];
let rejectDisconnect: (error: Error) => void;
let resolveDisconnect: () => void;
let visibility: DocumentVisibilityState;
const identity = 'serial:%2Fdev%2FttyUSB0:115200:8:none:one:none';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  localStorage.clear();
  writes = [];
  const disconnect = new Promise<void>((resolve, reject) => { resolveDisconnect = resolve; rejectDisconnect = reject; });
  desktop.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'load_preferences') return defaultPreferences();
    if (command === 'list_active_sessions') return [{ id: 'native-1', port: '/dev/ttyUSB0', baudRate: 115200,
      sessionName: 'Board', logPath: '/logs/board.log', settings: { dataBits: 8, parity: 'none', stopBits: 'one', flowControl: 'none' } }];
    if (command === 'take_pending_serial_data') return { events: [], nextSequence: 1, droppedEventCount: 0 };
    if (command === 'watch_snapshot') return { watches: [] };
    if (command === 'log_rules_snapshot') return { rules: [], error: '', interruption: '' };
    if (command === 'list_saved_logs' || command === 'list_serial_ports') return [];
    if (command === 'bench_event_append') return args?.event;
    if (command === 'disconnect_serial_session') return disconnect;
    if (command === 'send_serial_text') { writes.push(args?.text as string); return 1; }
    throw new Error(`Unhandled test desktop command: ${command}`);
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

function button(text: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}

function emitStatus(event: Record<string, unknown>) {
  desktop.listeners.get('serial-status')?.forEach((callback) => callback(event));
}

it('stops a delayed command sequence immediately when its tab closes while native disconnect is pending', async () => {
  saveCommandSequences(identity, [{ id: 'test', name: 'Procedure', steps: [
    { id: 'first', name: 'First', command: { payload: 'FIRST', mode: 'text', lineEnding: 'lf' }, expect: '', timeoutMs: 1000, delayMs: 1000 },
    { id: 'second', name: 'Second', command: { payload: 'SECOND', mode: 'text', lineEnding: 'lf' }, expect: '', timeoutMs: 1000, delayMs: 0 },
  ] }]);
  await act(async () => root.render(<App />));
  await act(async () => vi.advanceTimersByTimeAsync(140));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Saved command sequence"]')!.click());
  await act(async () => button('Procedure · 2 steps').click());
  await act(async () => button('Run sequence').click());
  expect(writes).toEqual(['FIRST\n']);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close Board"]')!.click());
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(writes).toEqual(['FIRST\n']);
  await act(async () => rejectDisconnect(new Error('Backend unavailable')));
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(writes).toEqual(['FIRST\n']);
});

it('stops command repeats when the document becomes hidden and does not restart on return', async () => {
  await act(async () => root.render(<App />));
  await act(async () => vi.advanceTimersByTimeAsync(140));
  const input = host.querySelector<HTMLInputElement>('.sd-send-row input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'PING');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Start repeating').click());
  expect(writes).toEqual(['PING\n']);
  await act(async () => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(writes).toEqual(['PING\n']);
  await act(async () => { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(writes).toEqual(['PING\n']);
});

it.each([
  'Disconnected by user. Warning: the saved capture may be incomplete: Could not finalize the raw log: disk full',
  'Disconnected by user. The saved raw log was kept.',
])('keeps the native disconnect outcome visible after the command resolves: %s', async (message) => {
  await act(async () => root.render(<App />));
  await act(async () => vi.advanceTimersByTimeAsync(140));
  await act(async () => button('Disconnect').click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Confirm disconnect"] .sd-monitor-danger-button')!.click());
  // Native status is emitted before the disconnect RPC completes.
  await act(async () => emitStatus({ sessionId: 'native-1', port: '/dev/ttyUSB0', status: 'disconnected', message }));
  await act(async () => resolveDisconnect());
  await act(async () => vi.advanceTimersByTimeAsync(32));
  expect(host.textContent).toContain(message);
  expect(host.textContent).not.toContain('Local log remains available.');
  expect(host.querySelector('[aria-label="Confirm disconnect"]')).toBeNull();
  expect(button('Disconnect').disabled).toBe(true);
});

it.each(['close', 'disconnect'])('stops repeat writes immediately on %s intent while the native request is pending', async (action) => {
  await act(async () => root.render(<App />));
  await act(async () => vi.advanceTimersByTimeAsync(140));
  const input = host.querySelector<HTMLInputElement>('.sd-send-row input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'PING');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Start repeating').click());
  expect(writes).toEqual(['PING\n']);
  if (action === 'close') {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close Board"]')!.click());
  } else {
    await act(async () => button('Disconnect').click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Confirm disconnect"] .sd-monitor-danger-button')!.click());
  }
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(writes).toEqual(['PING\n']);
  await act(async () => rejectDisconnect(new Error('Backend unavailable')));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(writes).toEqual(['PING\n']);
});

it.each([true, false])('retains a capture error notification after tab close only when native reports a capture error (%s)', async (failed) => {
  await act(async () => root.render(<App />));
  await act(async () => vi.advanceTimersByTimeAsync(140));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close Board"]')!.click());
  const message = failed
    ? 'Disconnected by user. Warning: the saved capture may be incomplete: disk full'
    : 'Disconnected by user. The saved raw log was kept.';
  await act(async () => emitStatus({ sessionId: 'native-1', port: '/dev/ttyUSB0', status: 'disconnected', message,
    ...(failed ? { captureError: 'disk full' } : {}) }));
  await act(async () => resolveDisconnect());
  expect(host.querySelector('[aria-label="Close Board"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('.sd-notification-trigger')!.click());
  const notifications = host.querySelector('[aria-label="Notifications"][role="dialog"]')!;
  if (failed) {
    expect(notifications.textContent).toContain('Capture may be incomplete');
    expect(notifications.textContent).toContain(message);
    expect(notifications.querySelector('.sd-notice-icon.error')).not.toBeNull();
  } else {
    expect(notifications.textContent).not.toContain('Capture may be incomplete');
  }
});
