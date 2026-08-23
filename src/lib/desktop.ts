export type DesktopEventName = 'serial-data' | 'serial-status';
export type DesktopUnlisten = () => void;

/** Return the narrow API exposed by Electron's context-isolated preload. */
export function getDesktopBridge(): BaudTideDesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = window.baudtideDesktop;
  if (!bridge || typeof bridge.invoke !== 'function' || typeof bridge.listen !== 'function') return undefined;
  return bridge;
}

export function isDesktopRuntime(): boolean {
  return getDesktopBridge() !== undefined;
}

export function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = getDesktopBridge();
  if (!bridge) return Promise.reject(new Error('This feature is available only in the BaudTide desktop app.'));
  return bridge.invoke<T>(command, args);
}

export function listenDesktop<T>(eventName: DesktopEventName, callback: (payload: T) => void): DesktopUnlisten {
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error('This feature is available only in the BaudTide desktop app.');
  return bridge.listen<T>(eventName, callback);
}
