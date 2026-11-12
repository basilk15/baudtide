import { describe, expect, it } from 'vitest';
import { comparisonReloadOptions } from './comparisonReload';

describe('comparison capture reload', () => {
  it('reuses a completed capture without replacing its decoder or range', () => {
    expect(comparisonReloadOptions('saved', 'saved', { id: 'decoder' } as never, { start: 1, end: 5 })).toEqual({ replace: false });
  });
  it('reindexes a just-stopped recording with its decoder and selected range', () => {
    const decoder = { id: 'decoder' } as never; const range = { start: 1, end: 5 };
    expect(comparisonReloadOptions('capturing', 'disconnected', decoder, range)).toEqual({ replace: true, profile: decoder, requestedRange: range });
  });
});
