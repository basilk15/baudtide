# Comparison Acceptance Checks Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user define, persist, evaluate and export explicit acceptance checks for an existing two-capture comparison, while never presenting unreliable evidence as a pass.

**Architecture:** Add a small pure check/evidence module fed by the comparison's exact full-history statistics. Integrate a bounded inline editor and results into the existing comparison, persist only the check configuration in analysis workspaces, and extend the existing atomic CSV export with the identical evaluated snapshot. Do not introduce a new execution service or touch raw captures.

**Tech Stack:** React 19, TypeScript, Vitest/jsdom, existing Electron telemetry export bridge, CSS design tokens, Linux PTY smoke fixture.

**Spec:** `docs/superpowers/specs/2026-11-12-comparison-acceptance-checks-design.md` (read the behavior, quality rules, design and out-of-scope sections before starting).

**Baseline:** `basilk15/baudtide` main at `4f91477`; re-check main and rebase the plan's file references if the branch changes. The focused comparison/workspace tests passed on this snapshot. Browser preview showed the empty comparison; populated desktop behavior was not validated during planning.

## Global Constraints

- Zero to eight optional checks; metrics `min`, `max`, `mean`, `deviation`; measures `candidate`, `difference`, `percent`; inclusive `lte`/`gte`; finite limit.
- Use full-history values, signed candidate-minus-baseline and existing percent definition `(candidate - baseline) / abs(baseline) * 100`; evaluate unrounded numbers and show adequate precision.
- Data-quality rules, binding, aggregation precedence, explicit persistence, and CSV provenance are exactly as specified. Neither a chart overview nor a previous run is a substitute for current results.
- Preserve existing local-first capture data, mobile permissions, themes, shortcuts and comparison behavior. No new runtime dependency, backend protocol, automatic device action, or remote service.
- UI must meet `docs/design.md` and the spec in Dark, Light, and Sage; support keyboard, reduced motion and 320px layouts.
- New tests stay beside their code. Ship only after the existing test/check commands and the desktop/PTY and visual gates below pass; record any environment-specific blocker rather than declaring success.

## Review Focus

The owning task includes a test for each condition:

1. Requested interval extends beyond a selected/indexed range, or either range is empty: checks are inconclusive; never silently pass (Task 1).
2. Mixed units, approximate timing, discarded overlong lines, active/failed/unknown capture state, known gap, invalid gap timestamp, or zero matching readings: explain the affected side and suppress pass/fail evaluation (Task 1).
3. Baseline zero, negative baseline, overflow, inclusive threshold, or displayed precision near a threshold: stable and truthful individual outcomes (Tasks 1 and 3).
4. A restored signal is missing, changes key/unit, or a run is cancelled/superseded: retain configuration and never publish/export a stale verdict (Tasks 2 and 3).
5. Corrupt new settings, CSV special characters, cancelled/failed save, or a prior destination file: preserve the user's workspace, capture and destination and give useful recovery feedback (Tasks 2 and 4).

## File map

- Create `src/lib/captures/comparisonChecks.ts` and `comparisonChecks.test.ts`: bounded schema, validation, quality and deterministic evaluation.
- Modify `src/lib/captures/captureComparison.ts` and its test: optional check set in comparison settings and compatibility normalization.
- Modify `src/lib/workspaces/analysisWorkspaces.ts` and its test: tolerant read, strict save and restoration warning for corrupt optional checks; retain existing v1 workspaces.
- Create `src/components/telemetry/ComparisonChecks.tsx`, `comparison-checks.css`, and `ComparisonChecks.test.tsx`: accessible editor and results, using existing shared controls and tokens.
- Modify `src/components/telemetry/CaptureComparisonPanel.tsx` and its test: snapshot freshness, evidence, binding, re-evaluation, presentation and export integration.
- Modify `src/components/telemetry/TelemetryAnalysisWorkspace.tsx` and relevant existing tests: workspace recovery notice and restored settings.
- Create `src/lib/captures/comparisonSummary.ts` and `comparisonSummary.test.ts`: pure CSV rows/serialization from the same snapshot; retain the desktop export stream lifecycle in the panel.
- Update `docs/design.md`, `README.md` and `RELEASE_NOTES.md` after verified behavior is in place. Use ignored `output/` for screenshots and test artifacts.

---

### Task 1: Define check semantics and evidence quality

**Files:** Create `src/lib/captures/comparisonChecks.ts`; test `src/lib/captures/comparisonChecks.test.ts`.

**Interfaces:**

```ts
type CheckMetric = 'min' | 'max' | 'mean' | 'deviation';
type CheckMeasure = 'candidate' | 'difference' | 'percent';
type ComparisonCheck = { id: string; metric: CheckMetric; measure: CheckMeasure; operator: 'lte' | 'gte'; limit: number };
type CheckBinding = { baselineField: string; candidateField: string; unit: string };
type ComparisonCheckSet = { binding: CheckBinding; checks: ComparisonCheck[] };
type CheckResult = { check: ComparisonCheck; status: 'pass' | 'fail' | 'inconclusive'; observed: number | null; reasons: string[] };
type CheckEvaluation = { status: 'none' | 'pass' | 'fail' | 'inconclusive'; results: CheckResult[] };
```

- [ ] Write tests for `normalizeCheckSet(value: unknown): ComparisonCheckSet | null`: 1–8 unique nonempty IDs of at most 160 characters, valid enums, finite thresholds, bounded field keys (256 characters), bounded unit (64 characters, empty allowed), no NUL; reject empty check sets, duplicates, nine checks, malformed or non-finite values. Represent no checks by omitting the optional set entirely.
- [ ] Write table-driven tests for `evaluateChecks(checks: readonly ComparisonCheck[], baseline: SignalStatistics, candidate: SignalStatistics, qualityReasons: readonly string[]): CheckEvaluation`: exact boundary passes, both directions fail beyond the bound, examples `20 → 24`, negative baseline `-10 → -5` gives `+50%`, zero baseline makes only percent inconclusive, and non-finite/overflow results are inconclusive. Verify no checks gives `none` and overall precedence is fail, then inconclusive, then pass when evidence is otherwise usable.
- [ ] Write tests for `comparisonQualityReasons(input: ComparisonQualityInput): string[]`, where each side contains `label: 'Baseline' | 'Candidate'`, `requested: CaptureRange`, `selection: CaptureRange`, `indexed: CaptureRange`, `timingMode: 'recorded' | 'approximate'`, `gaps: readonly TelemetryGap[]`, `droppedOverlongLineCount: number`, `captureState: SavedLog['state']`, and `statistics: SignalStatistics`. Cover exact inclusive endpoints, clipped start/end, reversed/empty intersection, zero readings, skipped units, approximate timing, nonzero discarded overlong lines anywhere in the capture, all seven `SavedLog.state` values (only `saved`/`disconnected` can be conclusive), in/out-of-range gaps and invalid gap timestamps. Include a 60-second request whose final accepted reading is at 59.8 seconds; it is clipped and the reason recommends shortening the interval or recording longer. Any reason makes every check inconclusive with side-specific reasons.
- [ ] Test `overlappingRecordedInterval(baseline: { selection: CaptureRange; indexed: CaptureRange; anchorMs: number }, candidate: { selection: CaptureRange; indexed: CaptureRange; anchorMs: number }): { startSeconds: number; endSeconds: number } | null` using different anchors, negative offsets, millisecond precision and non-overlap; only positive-duration intersections produce a value.
- [ ] Run `npx vitest run src/lib/captures/comparisonChecks.test.ts`; confirm failure because the module does not exist. Implement the exported types/functions above, using `comparisonDelta` only where its result is finite; do not change its existing behavior.
- [ ] Run the same command and `npx vitest run src/lib/captures/captureComparison.test.ts`; both must pass. Confirm statistics from the existing 2,000-record test remain independent of decimation.

### Task 2: Persist configuration safely and preserve older workspaces

**Files:** Modify `src/lib/captures/captureComparison.ts`, `src/lib/workspaces/analysisWorkspaces.ts`, `src/components/telemetry/TelemetryAnalysisWorkspace.tsx`; test their adjacent `*.test.ts` / `TelemetryAnalysisWorkspace.test.tsx` files.

**Interfaces:** `CaptureComparisonSettings` gains optional `checkSet?: ComparisonCheckSet`. `normalizeCaptureComparison(value: unknown)` continues returning `CaptureComparisonSettings | null` for existing callers. Add a read helper returning `{ comparison: CaptureComparisonSettings | null; discardedChecks: boolean }`. Add ephemeral `recoveryWarnings: Record<string, string>` to the in-memory `AnalysisWorkspaceLibrary`; it is never written to localStorage. The normalizer must distinguish absent check data from malformed check data.

- [ ] Add tests: old workspaces round-trip unchanged; valid checks round-trip with IDs, exact limits and binding; corrupt or oversized new check data is dropped on load while the remaining workspace survives and its warning is associated with its ID. Existing malformed core comparison settings retain their current handling. A strict save of invalid check data fails rather than silently dropping it.
- [ ] Add a restoration integration test that the selected workspace exposes an actionable notice such as “Some acceptance checks could not be restored. Review and add them again.” Re-opening a valid workspace must not show that notice. No verdict is stored or restored.
- [ ] Run `npx vitest run src/lib/workspaces/analysisWorkspaces.test.ts src/components/telemetry/TelemetryAnalysisWorkspace.test.tsx` and confirm the new tests fail. Implement the tolerant read helper and strict write validation; carry read warnings through `loadAnalysisWorkspaces` and show the warning when restoring the affected workspace, including linked bench restoration. Ensure `storeAnalysisWorkspaces` serializes only the version, active ID, and normalized workspaces.
- [ ] Run those tests plus `npx vitest run src/lib/captures/captureComparison.test.ts`; confirm all pass, and inspect localStorage output to confirm warnings and verdicts are not persisted.

### Task 3: Build and integrate the comparison checks UI

**Files:** Create `src/components/telemetry/ComparisonChecks.tsx`, `comparison-checks.css`, `ComparisonChecks.test.tsx`; modify `CaptureComparisonPanel.tsx` and `CaptureComparisonPanel.test.tsx`.

**Interfaces:** `ComparisonChecks` receives the current optional `checkSet`, resolved `binding: CheckBinding | null`, current `evaluation: CheckEvaluation | null`, `busy: boolean`, and callbacks `onChange(next: ComparisonCheckSet | undefined): void` and `onDraftChange(isEditing: boolean): void`. `CaptureComparisonPanel` owns the draft-lock flag, measurement snapshot and persisted settings. The child owns draft fields and focus; rebind is an explicit `onChange` using the current resolved binding after a confirmation showing old/new units and stating that limits are not converted. Lift `onDraftChange` through `CaptureComparisonPanel` to `TelemetryAnalysisWorkspace` so its Save/Update actions are disabled with guidance while a draft is open.

- [ ] Add component tests for zero checks, add/edit/cancel/remove, max eight, invalid empty/non-finite limit, unique accessible labels, associated error, keyboard focus after save/cancel/remove, and explicit rebind including old/new unit confirmation. Assert draft changes do not mutate saved checks; unresolved or mismatched binding explains suspension and preserves checks. Test unitless and percent labels, and text/icon status independent of color.
- [ ] Add integration tests using existing `CaptureComparisonPanel.test.tsx` fixtures with recorded timing and complete requested ranges: compare means 20 and 40, check candidate mean ≤ 40 passes and percent change ≤ 10 fails; changing only an applied limit updates the verdict without querying the indexes again. Editing a draft disables export and workspace Save/Update, and does not change the applied result until Save or Cancel. Assert UI precision does not misrepresent an outcome close to a bound.
- [ ] Add tests for missing/replaced captures, field/unit mismatch, explicit rebind, range/decoder/event changes, changed event timestamps or gap/timing evidence, capture state transitions, closed panels, failed reruns, aborted and superseded asynchronous comparisons, and restored settings. A change to any measurement input clears the visible/exportable result; an unresolved binding stays suspended. In-flight responses from obsolete requests must not restore it. An index opened while a capture is active remains ineligible after disconnect until it is reopened/reindexed; after restoration, the user must run Compare again.
- [ ] Run `npx vitest run src/components/telemetry/ComparisonChecks.test.tsx src/components/telemetry/CaptureComparisonPanel.test.tsx` and verify the new tests fail. Implement the editor and ruled results section, with no nested `<form>`. Keep the measurement cache key limited to all actual comparison inputs, including source index identity, selection, resolved event timestamps, field units, capture state, timing/gap evidence, and decoder-derived index; exclude check set so saved limit edits evaluate the same measurement. Include interval draft values in the measurement key; invalidate before asynchronous updates. Use a request generation/abort guard so only the latest completed operation publishes.
- [ ] Carry `SavedLog.state` from the library and the state at index creation into each `ComparisonSource`; invalidate and reload an index created while active when the capture stops, rather than reusing its fixed-size snapshot. Construct quality input from each source's index range, selected range, timing mode, known gaps, current result statistics, anchor, discarded-overlong count and requested interval. Explain that the indexed range ends at the last accepted reading and an empty known-gap list does not prove uninterrupted capture. Do not evaluate against incompatible/unresolved binding. Format exact thresholds/observations with sufficient significant digits and distinguish unavailable from zero. Add and test the “Use overlapping recorded interval” recovery action from Task 1, disabled with guidance when no positive-duration overlap exists; it fills the interval but does not run the comparison. Place the outcome below statistics and above the chart; keep the current chart and measurements available for inconclusive results.
- [ ] Implement styles using existing semantic tokens and `docs/design.md`: ruled rows, no card grid, labeled outcomes, predictable focus, visible hover/error/disabled states, no new decorative accent treatment. Stack under 700px and meet the 480px/320px requirements. Run the two component tests and `npm run typecheck`; confirm they pass.

### Task 4: Export the same verdict and provenance safely

**Files:** Create `src/lib/captures/comparisonSummary.ts` and `comparisonSummary.test.ts`; modify `CaptureComparisonPanel.tsx` and its tests. Reuse `electron/telemetry-export.mjs` and its existing tests.

**Interfaces:** Export `comparisonSummaryCsv(snapshot: ComparisonSummarySnapshot): string`. The snapshot contains baseline/candidate names, field keys, unit, anchors, requested and effective ranges, timing modes, `SignalStatistics`, existing metric rows, and optional `CheckEvaluation`; it is created once from the current completed comparison and applied checks and is shared by UI and export.

- [ ] Write serialization tests that preserve existing summary rows when there are no checks and append the spec's overall outcome, each check's metric/measure/operator/limit/observed/unit/status/reason, and source/interval/state/timing/count/skipped-unit provenance when checks exist. Verify actual newline, comma and quote escaping, spreadsheet-formula neutralization of user text with leading whitespace and `=`, `+`, `-`, `@`, tab or CR, unchanged numeric negative values, null observed values, and inconclusive reasons; compare values to the UI's evaluation.
- [ ] Add panel tests that stale results, running comparison, open draft and unresolved binding cannot export a verdict; native dialog cancellation, append/finish failure and retry handle the existing stream correctly. Exercise the existing `electron/telemetry-export.test.mjs` destination-preservation tests rather than replacing the export service.
- [ ] Run `npx vitest run src/lib/captures/comparisonSummary.test.ts src/components/telemetry/CaptureComparisonPanel.test.tsx electron/telemetry-export.test.mjs`; verify new tests fail. Implement the serializer with apostrophe-prefix neutralization for risky user-controlled text cells (including whitespace followed by a formula prefix, or leading tab/CR), while leaving numeric cells numeric; document that protection in the CSV notes. Switch the panel to pass the same immutable current snapshot to both presentation and export. Retain begin/append/finish/cancel cleanup and existing native destination protection. Do not export an old verdict while a new run or check edit is pending.
- [ ] Run that command again; verify all pass. Parse a generated CSV with a standard CSV reader to verify rows and values, including strings with commas, quotes, and newlines.

### Task 5: Desktop, visual, accessibility and regression release gate

**Files:** Update `docs/design.md`, `README.md`, `RELEASE_NOTES.md`; use ignored `output/` for evidence.

- [ ] Run `npm test` and `npm run check` from the repository root; both must exit 0. Record command output and explicitly resolve failures. Do not claim the Rust/desktop gate passed if prerequisites are missing.
- [ ] Use the documented isolated `npm run dev` + `npm run smoke:desktop` setup and PTY simulator (or the actual Electron app with isolated data). Produce two saved captures with deterministic numeric telemetry and event markers. Select event-aligned complete intervals, add at least one passing and one failing check, verify counts/statistics and result against hand calculations, save analysis, reload, confirm no old verdict, rerun and export CSV; parse and inspect provenance and outcomes. Repeat a clipped interval and its overlap-recovery action, an approximate timing or mixed-unit case, cancellation, and a missing capture. While a PTY capture is still active, verify checks are inconclusive; disconnect, reopen/reindex, and rerun before allowing a result. Confirm captures and an existing destination remain unchanged after cancelled/failed export. Record exact steps, expected/actual values and the environment; do not treat browser preview with mocked data as the desktop gate.
- [ ] Capture and inspect desktop (1440×900), medium (768px), narrow (390px) and minimum (320px) views in Dark, Light and Sage. Include empty, populated, editing, invalid, pass, fail, inconclusive, busy, and error states; verify long names, no page overflow, local table scrolling, target sizes, contrast, alignment, and readable numeric values. Exercise Tab/Shift-Tab/Enter/Escape, visible focus, screen-reader labels/status, and reduced motion. Correct and recheck any defect; save representative screenshots under `output/`.
- [ ] Update `docs/design.md` with the implemented checks component and responsive behavior, `README.md` with a concise user-facing capability, and `RELEASE_NOTES.md` under Unreleased. Document that a pass applies to recorded data and approximate or incomplete evidence is inconclusive. Ensure no unverified hardware or adoption claim is added.
- [ ] Re-run any tests affected by corrections and `git diff --check`; inspect `git status` for only intended source/docs. Review every spec requirement and the five Review Focus conditions against tests and smoke evidence. Stop for review before implementation is merged or published.
