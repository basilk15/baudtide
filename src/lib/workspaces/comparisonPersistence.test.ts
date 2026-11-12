// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { loadAnalysisWorkspaces, storeAnalysisWorkspaces } from './analysisWorkspaces';

const comparison = { baselinePath: '/a', candidatePath: '/b', baselineField: 'x', candidateField: 'x', baselineEvent: '', candidateEvent: '', startSeconds: 0, endSeconds: 1 };
const checkSet = { binding: { baselineField: 'x', candidateField: 'x', unit: 'C' }, checks: [{ id: '1', metric: 'mean', measure: 'candidate', operator: 'lte', limit: 25 }] };
const workspace = { id: 'test', name: 'Bench', updatedAt: 1, alignment: 'elapsed', chartMode: 'compare', windowMs: 0, replayRate: 1, sources: [], watches: [], comparison: { ...comparison, checkSet } };
afterEach(() => localStorage.clear());
describe('saved comparison checks', () => {
  it('retains valid checks but no transient verdict in local storage', () => {
    localStorage.setItem('baudtide.analysis-workspaces.v1', JSON.stringify({ version: 1, activeId: 'test', workspaces: [workspace] }));
    const result = loadAnalysisWorkspaces();
    expect(result.workspaces[0].comparison?.checkSet).toEqual(checkSet);
    storeAnalysisWorkspaces(result);
    expect(localStorage.getItem('baudtide.analysis-workspaces.v1')).not.toContain('recoveryWarnings');
  });
  it('keeps the workspace and warns when only its optional checks are corrupt', () => {
    localStorage.setItem('baudtide.analysis-workspaces.v1', JSON.stringify({ version: 1, activeId: 'test', workspaces: [{ ...workspace, comparison: { ...comparison, checkSet: { ...checkSet, checks: [] } } }] }));
    const result = loadAnalysisWorkspaces();
    expect(result.workspaces[0].comparison).toEqual(comparison);
    expect(result.recoveryWarnings?.test).toContain('checks');
  });
  it('keeps the recovery warning across saving a different selected workspace', () => {
    const broken = { ...workspace, comparison: { ...comparison, checkSet: { ...checkSet, checks: [] } } };
    const other = { ...workspace, id: 'other', comparison };
    localStorage.setItem('baudtide.analysis-workspaces.v1', JSON.stringify({ version: 1, activeId: 'test', workspaces: [broken, other] }));
    const loaded = loadAnalysisWorkspaces();
    storeAnalysisWorkspaces({ ...loaded, activeId: 'other' });
    const reloaded = loadAnalysisWorkspaces();
    expect(reloaded.recoveryWarnings?.test).toContain('checks');
    expect(reloaded.workspaces.find((item) => item.id === 'test')?.comparison).toEqual(comparison);
  });

});
