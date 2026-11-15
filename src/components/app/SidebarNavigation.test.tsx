// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SidebarNavigation } from './SidebarNavigation';

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

it('keeps navigation focus in the drawer and restores the trigger on Escape', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<><SidebarNavigation /><main><button>Background action</button></main></>));
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')!;
  await act(async () => trigger.click());
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(host.querySelector('main')!.hasAttribute('inert')).toBe(true);
  const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
  buttons[buttons.length - 1].focus();
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(buttons[0]);
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('main')!.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(trigger);
  await act(async () => root.unmount());
});

it('closes after navigation and restores background state on unmount', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const navigate = vi.fn();
  await act(async () => root.render(<><SidebarNavigation onNavigate={navigate} /><main inert><button>Background action</button></main></>));
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')!;
  await act(async () => trigger.click());
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  await act(async () => [...dialog.querySelectorAll('button')].find(e => e.textContent === 'Saved logs')!.click());
  expect(navigate).toHaveBeenCalledWith('logs');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('main')!.hasAttribute('inert')).toBe(true);
  await act(async () => trigger.click());
  await act(async () => root.unmount());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('keeps application shortcuts behind the modal inactive until it closes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const shortcut = vi.fn();
  window.addEventListener('keydown', shortcut);
  try {
    await act(async () => root.render(<SidebarNavigation />));
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')!;
    await act(async () => trigger.click());
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    });
    expect(shortcut).not.toHaveBeenCalled();
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    expect(shortcut).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener('keydown', shortcut);
    await act(async () => root.unmount());
  }
});

it.each(['logs', 'preferences', 'help'] as const)('releases the drawer and moves focus to desktop navigation on %s when the window grows', async (activePage) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const media = new EventTarget() as EventTarget & { matches: boolean }; media.matches = false;
  vi.stubGlobal('matchMedia', () => media);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<><SidebarNavigation activePage={activePage} /><main /></>));
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Open navigation"]')!;
  await act(async () => trigger.click());
  await act(async () => { media.matches = true; media.dispatchEvent(new Event('change')); });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('main')!.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(host.querySelector('.sd-sidebar [aria-current="page"]'));
  await act(async () => root.unmount());
});
