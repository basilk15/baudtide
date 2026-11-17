// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ComparisonCheckPresets } from './ComparisonCheckPresets';
import { saveComparisonPreset } from '../../lib/captures/comparisonPresets';
import type { ComparisonCheckSet } from '../../lib/captures/comparisonChecks';

const binding={baselineField:'temperature',candidateField:'temperature',unit:'C'};
const checkSet:ComparisonCheckSet={binding,checks:[{id:'current',metric:'mean',measure:'percent',operator:'lte',limit:1.0000001}]};
let host:HTMLDivElement;
afterEach(()=>{host?.remove();localStorage.clear();vi.unstubAllGlobals();vi.restoreAllMocks();});
const click=async(name:string)=>act(async()=>{[...host.querySelectorAll('button')].find(e=>(e.getAttribute('aria-label')??e.textContent?.trim())===name)!.click();});

it('previews before explicitly replacing checks and restores focus on Escape',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);saveComparisonPreset('Calibration limits',checkSet);
  host=document.createElement('div');document.body.append(host);const root=createRoot(host),apply=vi.fn(),review=vi.fn();
  await act(async()=>root.render(<ComparisonCheckPresets checkSet={checkSet} canSave binding={binding} busy={false} onApply={apply} onReviewChange={review}/>));
  expect(host.querySelector('input')).toBeNull();await click('Presets');expect(apply).not.toHaveBeenCalled();
  await click('Review preset Calibration limits');expect(apply).not.toHaveBeenCalled();expect(review).toHaveBeenLastCalledWith(true);
  expect(host.textContent).toContain('1.0000001');expect(host.textContent).toContain('replaces all current checks (1)');
  await click('Apply preset');expect(apply).toHaveBeenCalledOnce();expect(apply.mock.calls[0][0].checks[0].id).not.toBe('current');expect(review).toHaveBeenLastCalledWith(false);
  await act(async()=>host.querySelector('[aria-label="Saved check presets"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
  expect(document.activeElement?.textContent?.trim()).toBe('Presets');await act(async()=>root.unmount());
});
