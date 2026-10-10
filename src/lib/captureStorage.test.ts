import { expect, it } from 'vitest';
import { captureStoragePressure } from './captureStorage';
it('warns before exhaustion and clears pressure after freeing space or raising the cap', () => {
  expect(captureStoragePressure(79, 100)).toBe('normal');
  expect(captureStoragePressure(80, 100)).toBe('warning');
  expect(captureStoragePressure(95, 100)).toBe('critical');
  expect(captureStoragePressure(100, 100)).toBe('full');
  expect(captureStoragePressure(110, 100)).toBe('full');
  expect(captureStoragePressure(100, 200)).toBe('normal');
});
