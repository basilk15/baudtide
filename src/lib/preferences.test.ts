import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPreferences, loadPreferences, normalizePreferences, savePreferences } from './preferences';

describe('theme preferences', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps Sage selected and restores it when a running older desktop backend normalizes it to dark', async () => {
    const storage = new Map<string, string>();
    let nativeSettings = defaultPreferences();
    vi.stubGlobal('window', {
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
      baudtideDesktop: {
        listen: () => () => undefined,
        invoke: async (command: string, args?: { settings: ReturnType<typeof defaultPreferences> }) => {
          if (command === 'save_preferences' && args) nativeSettings = { ...args.settings, appearance: { theme: args.settings.appearance.theme === 'sage' ? 'dark' : args.settings.appearance.theme } };
          return nativeSettings;
        },
      },
    });
    const requested = defaultPreferences();
    requested.appearance.theme = 'sage';
    expect((await savePreferences(requested)).appearance.theme).toBe('sage');
    expect((await loadPreferences()).appearance.theme).toBe('sage');
    requested.appearance.theme = 'light';
    expect((await savePreferences(requested)).appearance.theme).toBe('light');
    expect((await loadPreferences()).appearance.theme).toBe('light');
  });
  it.each(['dark', 'light', 'sage'] as const)('retains %s through a settings JSON round trip', (theme) => {
    const settings = defaultPreferences();
    settings.appearance.theme = theme;
    expect(normalizePreferences(JSON.parse(JSON.stringify(settings))).appearance.theme).toBe(theme);
  });

  it('repairs an unknown theme without losing serial settings', () => {
    const settings = defaultPreferences();
    settings.serial.baudRate = 57600;
    expect(normalizePreferences({ ...settings, appearance: { theme: 'unknown' } })).toMatchObject({
      appearance: { theme: 'dark' }, serial: { baudRate: 57600 },
    });
  });
});
