// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AppStartupScreen } from './AppStartupScreen';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('waits for real setup, then exits promptly without replaying the introduction', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host=document.createElement('div'); document.body.append(host); const root=createRoot(host); const done=vi.fn();
  await act(async () => root.render(<AppStartupScreen ready={false} onComplete={done} />));
  await act(async () => vi.advanceTimersByTime(900));
  expect(done).not.toHaveBeenCalled();
  expect(host.querySelector('.is-leaving')).toBeNull();
  await act(async () => root.render(<AppStartupScreen ready onComplete={done} />));
  expect(host.querySelector('.is-leaving')).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(140));
  expect(done).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it('lets the workspace show if setup stalls instead of trapping the user on the splash', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const done=vi.fn();
  await act(async () => root.render(<AppStartupScreen ready={false} onComplete={done} />));
  await act(async () => vi.advanceTimersByTime(1000));
  expect(done).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it('skips the exit wait for reduced motion and cancels completion on unmount', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches:true, addEventListener:vi.fn(), removeEventListener:vi.fn() }));
  const host=document.createElement('div'); document.body.append(host); const root=createRoot(host); const done=vi.fn();
  await act(async () => root.render(<AppStartupScreen ready onComplete={done} />));
  expect(done).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  const second=createRoot(host); vi.stubGlobal('matchMedia', () => ({ matches:false, addEventListener:vi.fn(), removeEventListener:vi.fn() }));
  await act(async () => second.render(<AppStartupScreen ready onComplete={done} />));
  await act(async () => second.unmount());
  await act(async () => vi.runAllTimers());
  expect(done).toHaveBeenCalledTimes(1);
});
