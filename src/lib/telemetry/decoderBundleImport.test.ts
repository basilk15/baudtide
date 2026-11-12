import { afterEach, describe, expect, it, vi } from 'vitest';
import { importTelemetryDecoderProfile, saveTelemetryDecoderProfiles, type TelemetryDecoderProfile } from './telemetryDecoders';

const key = 'baudtide.telemetry-decoder-profiles.v1';
const profile: TelemetryDecoderProfile = {
  version: 1, id: 'original', name: 'Sensor', prefix: '', separator: 'comma',
  fields: [{ column: 1, name: 'temperature', unit: 'C' }], createdAt: 1, updatedAt: 1,
};
function memory(initial?: string) {
  const entries = new Map<string, string>();
  if (initial !== undefined) entries.set(key, initial);
  return { getItem: (name: string) => entries.get(name) ?? null, setItem: (name: string, value: string) => { entries.set(name, value); } };
}
describe('importing decoder profiles', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('preserves existing profiles and retries the same import without duplicates', () => {
    const storage = memory(JSON.stringify([profile]));
    const first = importTelemetryDecoderProfile(profile, 'import-123', storage);
    const second = importTelemetryDecoderProfile(profile, 'import-123', storage);
    expect(first.id).not.toBe(profile.id);
    expect(second).toEqual(first);
    expect(JSON.parse(storage.getItem(key)!)).toHaveLength(2);
    expect(JSON.parse(storage.getItem(key)!)[0]).toEqual(profile);
  });
  it('does not overwrite an unreadable existing profile library', () => {
    const storage = memory('{broken');
    expect(() => importTelemetryDecoderProfile(profile, 'import-123', storage)).toThrow();
    expect(storage.getItem(key)).toBe('{broken');
  });
  it('does not rewrite an existing malformed profile', () => {
    const original = JSON.stringify([{ ...profile, separator: 'broken' }]);
    const storage = memory(original);
    expect(() => importTelemetryDecoderProfile(profile, 'import-123', storage)).toThrow();
    expect(storage.getItem(key)).toBe(original);
  });
  it('does not silently truncate a full library', () => {
    const full = Array.from({ length: 24 }, (_, i) => ({ ...profile, id: `other-${i}` }));
    const storage = memory(JSON.stringify(full));
    expect(() => importTelemetryDecoderProfile(profile, 'import-123', storage)).toThrow();
    expect(JSON.parse(storage.getItem(key)!)).toEqual(full);
  });
  it('rejects a decoder with an unsupported separator instead of changing its meaning', () => {
    const storage = memory();
    expect(() => importTelemetryDecoderProfile({ ...profile, separator: 'unsupported' }, 'import-123', storage)).toThrow();
    expect(storage.getItem(key)).toBeNull();
  });
  it('does not drop an imported profile when saving beyond the profile limit', () => {
    const existing = Array.from({ length: 24 }, (_, i) => ({ ...profile, id: `profile-${i}` }));
    const storage = memory(JSON.stringify(existing)); vi.stubGlobal('window', { localStorage: storage });
    const result = saveTelemetryDecoderProfiles([{ ...profile, id: 'new' }, ...existing]);
    expect(result.ok).toBe(false);
    expect(JSON.parse(storage.getItem(key)!)).toEqual(existing);
  });
});
