/// <reference types="vite/client" />

interface BaudTideDesktopBridge {
  readonly platform: string;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    eventName: 'serial-data' | 'serial-status',
    callback: (payload: T) => void,
  ): () => void;
}

interface Window {
  readonly baudtideDesktop?: BaudTideDesktopBridge;
}
