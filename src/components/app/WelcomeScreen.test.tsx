// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { WelcomeScreen } from './WelcomeScreen';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

it('pauses decorative samples when hidden and for reduced motion, then resumes', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let visible='visible'; vi.spyOn(document,'visibilityState','get').mockImplementation(() => visible as DocumentVisibilityState);
  const media=new EventTarget() as EventTarget & { matches:boolean }; media.matches=false; vi.stubGlobal('matchMedia', () => media);
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  await act(async () => root.render(<WelcomeScreen nativeEnabled={false} onConnect={() => {}} onExplore={() => {}} />));
  const path=()=>host.querySelector('.bt-home-trace-primary')!.getAttribute('d');
  const initial=path();await act(async () => vi.advanceTimersByTime(650));expect(path()).not.toBe(initial);
  await act(async () => {visible='hidden';document.dispatchEvent(new Event('visibilitychange'));});
  const hidden=path();await act(async () => vi.advanceTimersByTime(6500));expect(path()).toBe(hidden);
  await act(async () => {visible='visible';document.dispatchEvent(new Event('visibilitychange'));media.matches=true;media.dispatchEvent(new Event('change'));});
  await act(async () => vi.advanceTimersByTime(6500));expect(path()).toBe(hidden);
  await act(async () => {media.matches=false;media.dispatchEvent(new Event('change'));});
  await act(async () => vi.advanceTimersByTime(650));expect(path()).not.toBe(hidden);
  await act(async () => root.unmount());
});
