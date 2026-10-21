import { describe, expect, it } from 'vitest';
import { PortScanGuard } from './portScan';

describe('port scan lifetime', () => {
  it('keeps manual entries and recent/explicit choices during and before rescans', () => {
    const guard = new PortScanGuard();
    const scan = guard.begin();
    guard.choose();
    expect(guard.isCurrent(scan)).toBe(true);
    expect(guard.canSelect(scan)).toBe(false);
    expect(guard.canSelect(guard.begin())).toBe(false);
  });
  it('rejects stale successes and failures after closing, reopening or a newer scan', () => {
    const guard = new PortScanGuard();
    const old = guard.begin();
    guard.reset();
    const next = guard.begin();
    expect(guard.isCurrent(old)).toBe(false);
    expect(guard.canSelect(next)).toBe(true);
    guard.begin();
    expect(guard.isCurrent(next)).toBe(false);
  });
});
