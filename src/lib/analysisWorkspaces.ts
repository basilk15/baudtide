import { normalizeTelemetryDecoderProfile, type TelemetryDecoderProfile } from './telemetryDecoders';
import { watchOptionsError, type TelemetryAlertRule } from './telemetryAlerts';

const STORAGE_KEY = 'baudtide.analysis-workspaces.v1';
export type AnalysisSourcePreset = {
  key: string;
  kind: 'live' | 'recorded';
  target: string;
  name: string;
  selectedFields: string[];
  decoder?: TelemetryDecoderProfile;
  rangeSeconds?: { start: number; end: number };
};
export type AnalysisWatchPreset = Omit<TelemetryAlertRule, 'id' | 'sessionKey'> & { sourceKey: string };
export type SavedAnalysisWorkspace = {
  id: string; name: string; updatedAt: number;
  alignment: 'elapsed' | 'clock'; chartMode: 'compare' | 'lanes'; windowMs: number; replayRate: number;
  sources: AnalysisSourcePreset[]; watches: AnalysisWatchPreset[];
};
export type AnalysisWorkspaceLibrary = { version: 1; activeId: string | null; workspaces: SavedAnalysisWorkspace[] };

/** Keep unresolved saved signals until restoration finishes or the user changes them. */
export function selectedAnalysisFields(sourceId: string, selectedFields: readonly string[], pendingFields: readonly string[] = []): string[] {
  const prefix = `${sourceId}\u0000`;
  const visible = selectedFields.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
  return [...new Set([...visible, ...pendingFields])];
}

/** An update retains unresolved devices and captures from the restored analysis. */
export function preserveUnavailableAnalysisSources(
  workspace: SavedAnalysisWorkspace,
  restored: SavedAnalysisWorkspace,
  pendingLives: readonly AnalysisSourcePreset[],
  removedCapturePaths: ReadonlySet<string>,
): SavedAnalysisWorkspace {
  const sources = [...workspace.sources];
  const watches = [...workspace.watches];
  const absent = [...pendingLives, ...restored.sources.filter((source) => source.kind === 'recorded'
    && !removedCapturePaths.has(source.target)
    && !sources.some((candidate) => candidate.kind === 'recorded' && candidate.target === source.target))];
  for (const source of absent) {
    if (sources.some((candidate) => candidate.target === source.target && candidate.kind === source.kind)) continue;
    const key = `pending-${sources.length}`;
    sources.push({ ...source, key });
    watches.push(...restored.watches.filter((watch) => watch.sourceKey === source.key).map((watch) => ({ ...watch, sourceKey: key })));
  }
  return { ...workspace, sources, watches };
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\u0000'); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }

export function normalizeAnalysisWorkspace(value: unknown): SavedAnalysisWorkspace | null {
  if (!object(value) || !text(value.id, 160) || !text(value.name, 80) || !value.name.trim() || !finite(value.updatedAt)
    || !['elapsed', 'clock'].includes(String(value.alignment)) || !['compare', 'lanes'].includes(String(value.chartMode))
    || !finite(value.windowMs) || !Number.isSafeInteger(value.windowMs) || value.windowMs < 0
    || ![1, 2, 4, 16].includes(Number(value.replayRate)) || !Array.isArray(value.sources) || value.sources.length > 24
    || !Array.isArray(value.watches) || value.watches.length > 48) return null;
  const sources: AnalysisSourcePreset[] = [];
  for (const source of value.sources) {
    if (!object(source) || !text(source.key, 160) || !['live', 'recorded'].includes(String(source.kind))
      || !text(source.target, 8192) || !text(source.name, 200) || !Array.isArray(source.selectedFields)
      || source.selectedFields.length > 8 || source.selectedFields.some((field) => !text(field, 256))
      || sources.some((candidate) => candidate.key === source.key || (candidate.kind === source.kind && candidate.target === source.target))) return null;
    if (source.kind === 'live' && !/^serial:[^:\s]+:\d+:[5678]:(?:none|odd|even):(?:one|two):(?:none|software|hardware)$/u.test(source.target)) return null;
    const decoder = source.decoder === undefined ? undefined : normalizeTelemetryDecoderProfile(source.decoder);
    if (source.decoder !== undefined && !decoder) return null;
    let rangeSeconds: AnalysisSourcePreset['rangeSeconds'];
    if (source.rangeSeconds !== undefined) {
      const range = source.rangeSeconds;
      if (!object(range) || !finite(range.start) || !finite(range.end) || range.start < 0 || range.end < range.start) return null;
      rangeSeconds = { start: range.start, end: range.end };
    }
    sources.push({ key: source.key, kind: source.kind as AnalysisSourcePreset['kind'], target: source.target, name: source.name,
      selectedFields: [...new Set(source.selectedFields as string[])], ...(decoder ? { decoder } : {}), ...(rangeSeconds ? { rangeSeconds } : {}) });
  }
  const watches: AnalysisWatchPreset[] = [];
  for (const watch of value.watches) {
    if (!object(watch) || !text(watch.sourceKey, 160) || !sources.some((source) => source.key === watch.sourceKey && source.kind === 'live')
      || !text(watch.fieldKey, 256) || typeof watch.enabled !== 'boolean' || (watch.unit !== undefined && !text(watch.unit, 64))
      || watches.some((candidate) => candidate.sourceKey === watch.sourceKey && candidate.fieldKey === watch.fieldKey)) return null;
    if (watchOptionsError(watch as unknown as TelemetryAlertRule)) return null;
    if (watch.condition === 'above' || watch.condition === 'below') {
      if (!finite(watch.threshold)) return null;
    } else if (watch.condition !== 'outsideRange' || !finite(watch.min) || !finite(watch.max) || watch.min >= watch.max) return null;
    watches.push({ sourceKey: watch.sourceKey, fieldKey: watch.fieldKey, enabled: watch.enabled,
      condition: watch.condition,
      ...(watch.sustainMs === undefined ? {} : { sustainMs: watch.sustainMs as number }),
      ...(watch.hysteresis === undefined ? {} : { hysteresis: watch.hysteresis as number }),
      ...(watch.staleAfterMs === undefined ? {} : { staleAfterMs: watch.staleAfterMs as number }), ...(watch.unit === undefined ? {} : { unit: watch.unit as string }),
      ...(watch.condition === 'outsideRange' ? { min: watch.min as number, max: watch.max as number } : { threshold: watch.threshold as number }) });
  }
  return { id: value.id, name: value.name.trim(), updatedAt: value.updatedAt, alignment: value.alignment as SavedAnalysisWorkspace['alignment'],
    chartMode: value.chartMode as SavedAnalysisWorkspace['chartMode'], windowMs: value.windowMs, replayRate: Number(value.replayRate), sources, watches };
}

export function loadAnalysisWorkspaces(): AnalysisWorkspaceLibrary {
  const empty: AnalysisWorkspaceLibrary = { version: 1, activeId: null, workspaces: [] };
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!object(value) || value.version !== 1 || !Array.isArray(value.workspaces)) return empty;
    const workspaces = value.workspaces.slice(0, 30).map(normalizeAnalysisWorkspace).filter((workspace): workspace is SavedAnalysisWorkspace => Boolean(workspace));
    const unique = workspaces.filter((workspace, index) => workspaces.findIndex((candidate) => candidate.id === workspace.id) === index);
    return { version: 1, activeId: unique.some((workspace) => workspace.id === value.activeId) ? value.activeId as string : null, workspaces: unique };
  } catch { return empty; }
}

export function storeAnalysisWorkspaces(library: AnalysisWorkspaceLibrary) {
  const normalized = library.workspaces.map(normalizeAnalysisWorkspace);
  if (library.workspaces.length > 30 || normalized.some((workspace) => !workspace)) throw new Error('Use a name and valid sources to save this analysis. Up to 30 workspaces can be saved.');
  const contents = JSON.stringify({ version: 1, activeId: library.activeId, workspaces: normalized });
  if (contents.length > 512 * 1024) throw new Error('This workspace library is too large. Reduce the saved decoder definitions.');
  try { window.localStorage.setItem(STORAGE_KEY, contents); }
  catch { throw new Error('Could not save analysis workspaces. Check that local storage is available and has free space.'); }
}

/** Missing or ambiguous devices are never silently assigned a saved profile. */
export function resolveAnalysisSession<T extends { identity?: string; legacyIdentity?: string }>(target: string, sessions: readonly T[]): T | undefined {
  const matches = sessions.filter((session) => session.identity === target || session.legacyIdentity === target);
  return matches.length === 1 ? matches[0] : undefined;
}
