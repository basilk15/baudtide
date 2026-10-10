import { describe, expect, it } from 'vitest';
import { normalizeAnalysisWorkspace, resolveAnalysisSession, selectedAnalysisFields, preserveUnavailableAnalysisSources, type SavedAnalysisWorkspace } from './analysisWorkspaces';
import { stableTerminalSessionIdentity } from './sessionWorkspaces';
import { defaultSerialConnectionSettings } from './serial';

const connection = { port: '/dev/ttyUSB0', baudRate: 115200, settings: defaultSerialConnectionSettings,
  deviceIdentity: { vendorId: 4292, productId: 60000, serialNumber: 'board-A', stablePath: null } };
const identity = stableTerminalSessionIdentity(connection);
const workspace: SavedAnalysisWorkspace = { id: 'bench', name: 'Bench', updatedAt: 1000, alignment: 'elapsed', chartMode: 'lanes', windowMs: 0, replayRate: 4,
  sources: [{ key: 'sensor', kind: 'live', target: identity, name: 'Sensor', selectedFields: ['temperature'] },
    { key: 'log', kind: 'recorded', target: '/saved/bench.log', name: 'Capture', selectedFields: ['voltage'], rangeSeconds: { start: 10, end: 20 } }],
  watches: [{ sourceKey: 'sensor', fieldKey: 'temperature', enabled: true, condition: 'above', threshold: 50 }] };

describe('durable analysis targets', () => {
  it('follows identified devices across changed ports and rejects ambiguous matches', () => {
    const changed = stableTerminalSessionIdentity({ ...connection, port: '/dev/ttyUSB7' });
    expect(changed).toBe(identity);
    expect(stableTerminalSessionIdentity({ ...connection, deviceIdentity: { ...connection.deviceIdentity, serialNumber: 'board-B' } })).not.toBe(identity);
    const session = { identity: changed };
    expect(resolveAnalysisSession(identity, [session])).toBe(session);
    expect(resolveAnalysisSession(identity, [session, { identity }])).toBeUndefined();
    const legacy = stableTerminalSessionIdentity({ ...connection, deviceIdentity: null });
    expect(resolveAnalysisSession(legacy, [{ identity, legacyIdentity: legacy }])).toBeDefined();
  });
  it('preserves settings and references without persisting native session IDs', () => {
    expect(normalizeAnalysisWorkspace(JSON.parse(JSON.stringify(workspace)))).toEqual(workspace);
  });
  it('retains independent eight-signal selections for each source', () => {
    const sources = workspace.sources.map((source) => ({ ...source, selectedFields: Array.from({ length: 8 }, (_, index) => `signal_${index}`) }));
    expect(normalizeAnalysisWorkspace({ ...workspace, sources })?.sources).toEqual(sources);
    expect(normalizeAnalysisWorkspace({ ...workspace, sources: [{ ...sources[0], selectedFields: [...sources[0].selectedFields, 'ninth'] }] })).toBeNull();
  });
  it('rejects corrupt rules, invalid ranges, duplicate device references, and missing rule targets', () => {
    for (const invalid of [
      { ...workspace, watches: [{ ...workspace.watches[0], threshold: null }] },
      { ...workspace, watches: [{ ...workspace.watches[0], sourceKey: 'missing' }] },
      { ...workspace, sources: [...workspace.sources, { ...workspace.sources[0], key: 'duplicate' }] },
      { ...workspace, sources: [{ ...workspace.sources[1], rangeSeconds: { start: 20, end: 10 } }] },
      { ...workspace, windowMs: -1 },
    ]) expect(normalizeAnalysisWorkspace(invalid)).toBeNull();
  });
});

describe('updating a restored analysis', () => {
  it('keeps an explicitly removed capture out of the saved workspace after repeated updates', () => {
    const current = { ...workspace, sources: [workspace.sources[0]] };
    const removed = new Set([workspace.sources[1].target]);
    const saved = preserveUnavailableAnalysisSources(current, workspace, [], removed);
    expect(normalizeAnalysisWorkspace(saved)?.sources).toEqual(current.sources);
    expect(preserveUnavailableAnalysisSources(current, saved, [], removed)).toEqual(saved);
    expect(workspace.sources).toHaveLength(2);
  });

  it('continues retaining genuinely unavailable captures and devices with their settings and watches', () => {
    const current = { ...workspace, sources: [], watches: [] };
    const saved = preserveUnavailableAnalysisSources(current, workspace, [workspace.sources[0]], new Set());
    expect(normalizeAnalysisWorkspace(saved)).toEqual(saved);
    expect(saved.sources.map(({ key: _key, ...source }) => source)).toEqual(workspace.sources.map(({ key: _key, ...source }) => source));
    expect(saved.watches).toEqual([{ ...workspace.watches[0], sourceKey: saved.sources[0].key }]);
    expect(current.sources).toEqual([]);
    expect(current.watches).toEqual([]);
  });

  it('can save a removed capture that the user explicitly adds again', () => {
    const removed = new Set([workspace.sources[1].target]);
    const saved = preserveUnavailableAnalysisSources(workspace, workspace, [], removed);
    expect(saved).toEqual(workspace);
    expect(saved.sources).toHaveLength(2);
  });

  it('deduplicates newly available sources instead of restoring their old fields or duplicate watches', () => {
    const current = { ...workspace, sources: workspace.sources.map((source) => ({ ...source, selectedFields: [] })), watches: [] };
    expect(preserveUnavailableAnalysisSources(current, workspace, [workspace.sources[0]], new Set())).toEqual(current);
  });

  it('retains saved fields when a matching terminal has not emitted telemetry yet', () => {
    const savedFields = selectedAnalysisFields('live:sensor', [], workspace.sources[0].selectedFields);
    const saved = { ...workspace, sources: [{ ...workspace.sources[0], selectedFields: savedFields }] };
    expect(normalizeAnalysisWorkspace(JSON.parse(JSON.stringify(saved)))?.sources[0].selectedFields).toEqual(['temperature']);
  });

  it('merges partially resolved fields without duplicates or fields from another source', () => {
    expect(selectedAnalysisFields('live:sensor', ['live:other\u0000voltage', 'live:sensor\u0000temperature'], ['temperature', 'humidity']))
      .toEqual(['temperature', 'humidity']);
  });

  it('honors explicit selection changes once pending restoration has been cleared', () => {
    expect(selectedAnalysisFields('live:sensor', ['live:other\u0000voltage'])).toEqual([]);
    expect(selectedAnalysisFields('live:sensor', ['live:sensor\u0000humidity'])).toEqual(['humidity']);
  });
});
