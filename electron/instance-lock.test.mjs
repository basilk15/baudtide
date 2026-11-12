import { describe, expect, it, vi } from 'vitest';
import { claimApplicationInstance } from './instance-lock.mjs';

describe('application instance ownership', () => {
  it('lets only the primary instance start and focuses it on a second launch', () => {
    let secondInstance;
    const app = { requestSingleInstanceLock: vi.fn(() => true), on: vi.fn((event, callback) => { if (event === 'second-instance') secondInstance = callback; }) };
    const focus = vi.fn();
    expect(claimApplicationInstance(app, focus)).toBe(true);
    secondInstance();
    expect(focus).toHaveBeenCalledOnce();
    expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
  });
  it('prevents a secondary instance from starting its services', () => {
    const app = { requestSingleInstanceLock: vi.fn(() => false), on: vi.fn() };
    expect(claimApplicationInstance(app, vi.fn())).toBe(false);
    expect(app.on).not.toHaveBeenCalled();
  });
});
