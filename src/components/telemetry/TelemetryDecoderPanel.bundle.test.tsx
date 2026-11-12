// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TelemetryDecoderPanel } from './TelemetryDecoderPanel';
import { restoreCaptureBundleMetadata } from '../../lib/captures/captureBundleRecovery';
import { loadTelemetryDecoderProfiles } from '../../lib/telemetry/telemetryDecoders';

let container: HTMLDivElement;
afterEach(() => { container?.remove(); localStorage.clear(); vi.unstubAllGlobals(); });
it('keeps an imported decoder when a mounted panel saves another profile', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(<TelemetryDecoderPanel sources={[{ id: 'source', name: 'Board', detail: 'Board', kind: 'recorded', receivedCompleteLineCount: 3, detectedFieldCount: 0 }]} onApply={() => {}} onProfileDeleted={() => {}} />));
  await act(async () => restoreCaptureBundleMetadata({ id: '1234-abcd', capturePath: '/new.log', metadata: { name: 'Board', notes: [], decoder: { version: 1, id: 'old', name: 'Imported decoder', prefix: '', separator: 'comma', fields: [{ column: 1, name: 'temperature' }], createdAt: 1, updatedAt: 1 } } }));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Decoder mode"]')!.click());
  await act(async () => [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'Custom decoder')!.click());
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Save profile & apply'))!.click());
  expect(loadTelemetryDecoderProfiles().map((profile) => profile.name)).toContain('Imported decoder');
  expect(loadTelemetryDecoderProfiles()).toHaveLength(2);
  await act(async () => root.unmount());
});
