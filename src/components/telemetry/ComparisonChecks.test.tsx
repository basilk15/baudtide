// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComparisonChecks } from './ComparisonChecks';
import type { ComparisonCheckSet } from '../../lib/captures/comparisonChecks';

const binding = { baselineField: 'temperature', candidateField: 'temperature', unit: 'C' };
let container: HTMLDivElement | null = null;
afterEach(() => { container?.remove(); container = null; vi.unstubAllGlobals(); });
describe('acceptance check editor', () => {
  it('adds a rule only after a valid limit is saved and supports cancellation', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    function Example() { const [set, setSet] = useState<ComparisonCheckSet>(); return <ComparisonChecks checkSet={set} binding={binding} evaluation={null} busy={false} onChange={setSet} onDraftChange={() => {}} />; }
    await act(async () => root.render(<Example />));
    const button = (name: string) => [...container!.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
    expect(container.textContent).toContain('No checks configured');
    await act(async () => button('Add check').click());
    await act(async () => button('Save check').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('finite');
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Limit"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '25'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('Save check').click());
    expect(container.textContent).toContain('25');
    await act(async () => button('Edit').click());
    await act(async () => button('Cancel').click());
    expect(container.textContent).toContain('25');
    await act(async () => root.unmount());
  });
  it('suspends checks on a different signal and requires an explicit rebind', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const change = vi.fn();
    await act(async () => root.render(<ComparisonChecks checkSet={{ binding, checks: [{ id: 'x', metric: 'mean', measure: 'candidate', operator: 'lte', limit: 25 }] }} binding={{ ...binding, unit: 'F' }} evaluation={null} busy={false} onChange={change} onDraftChange={() => {}} />));
    expect(container.textContent).toContain('suspended');
    await act(async () => [...container!.querySelectorAll('button')].find((b) => b.textContent?.includes('Rebind'))!.click());
    expect(container.textContent).toContain('not converted');
    expect(change).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
  it('does not save a draft against a signal that changed while editing', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); const root = createRoot(container); const change = vi.fn();
    const render = (current: typeof binding) => <ComparisonChecks binding={current} evaluation={null} busy={false} onChange={change} onDraftChange={() => {}} />;
    await act(async () => root.render(render(binding)));
    await act(async () => [...container!.querySelectorAll('button')].find((b) => b.textContent?.includes('Add check'))!.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Limit"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '25'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => root.render(render({ ...binding, unit: 'F' })));
    await act(async () => [...container!.querySelectorAll('button')].find((b) => b.textContent?.includes('Save check'))!.click());
    expect(change).not.toHaveBeenCalled();
    expect(container.textContent).toContain('changed');
    await act(async () => root.unmount());
  });

  it('distinguishes same-metric actions and lets a user cancel removal', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); const root = createRoot(container); const change = vi.fn();
    const checks = [1, 2].map((n) => ({ id: String(n), metric: 'mean' as const, measure: 'candidate' as const, operator: 'lte' as const, limit: n }));
    await act(async () => root.render(<ComparisonChecks checkSet={{ binding, checks }} binding={binding} evaluation={null} busy={false} onChange={change} onDraftChange={() => {}} />));
    const removes = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Remove');
    expect(removes[0].getAttribute('aria-label')).not.toBe(removes[1].getAttribute('aria-label'));
    await act(async () => removes[0].click());
    expect(change).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Remove this check?');
    expect(document.activeElement?.textContent).toBe('Confirm removal');
    await act(async () => [...container!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel removal')!.click());
    expect(change).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('shows concise values while distinguishing an observation close to its limit', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const check = { id: 'x', metric: 'mean' as const, measure: 'candidate' as const, operator: 'lte' as const, limit: 1.0000001 };
    await act(async () => root.render(<ComparisonChecks checkSet={{ binding, checks: [check] }} binding={binding} evaluation={null} busy={false} onChange={() => {}} onDraftChange={() => {}} />));
    expect(container.textContent).toContain('1.0000001');
    await act(async () => root.render(<ComparisonChecks checkSet={{ binding, checks: [check] }} binding={binding} evaluation={{ status: 'fail', results: [{ check, observed: 1.0000002, status: 'fail', reasons: [] }] }} busy={false} onChange={() => {}} onDraftChange={() => {}} />));
    expect(container.textContent).toContain('1.0000001');
    expect(container.textContent).toContain('1.0000002');
    const ordinary = { ...check, limit: 25 };
    await act(async () => root.render(<ComparisonChecks checkSet={{ binding, checks: [ordinary] }} binding={binding} evaluation={{ status: 'pass', results: [{ check: ordinary, observed: 23.733333333333334, status: 'pass', reasons: [] }] }} busy={false} onChange={() => {}} onDraftChange={() => {}} />));
    expect(container.textContent).toContain('23.7333');
    expect(container.textContent).not.toContain('23.733333333333334');
    await act(async () => root.unmount());
  });

});
