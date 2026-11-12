# Saved Comparison Results Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Save and revisit explicit historical snapshots of completed checked capture comparisons.

**Architecture:** Reuse the current comparison summary snapshot and CSV serializer. A strict bounded localStorage library owns validation and atomic updates; a focused React history section owns inspection, removal confirmation and export. The comparison panel creates the same snapshot for the current result and CSV.

**Tech Stack:** React 19, TypeScript, Vitest/jsdom, existing Electron export bridge and CSS tokens.

**Spec:** `docs/superpowers/specs/2026-11-12-comparison-result-history-design.md`.

## Global Constraints

- Preserve local-first data and all existing comparison and workspace behavior; do not change raw captures.
- Explicit saves only; 50 results and 512 KiB maximum, no automatic eviction, fail closed on unreadable data.
- Snapshots retain full precision and explain they are historical; no rerun or source file is required to inspect or export.
- Dark, Light and Sage; accessible keyboard and focus, 44px narrow controls and no page overflow at 320px.
- Run focused tests during each task, then full `npm test` and `npm run check`, PTY smoke and visual inspection. Perform a thorough self-review before the authorized push to `main`.

## Review Focus

1. Corrupt, unsupported, oversized, duplicate or partially invalid stored data must survive all attempted writes unchanged (Task 1).
2. A saved historical result must not misreport a current or modified capture, and must retain the same numeric evidence and outcome after restart (Tasks 1–2).
3. Missing checks, stale comparison, open draft, busy operation or non-finite values must not save a misleading result (Tasks 1–2).
4. Deletion, storage failure, export cancellation and interrupted export must preserve unrelated records and raw captures (Tasks 1–2).
5. Long names, three outcomes, keyboard focus and 320px layouts must stay understandable in all themes (Tasks 2–3).

### Task 1: Safe snapshot history

**Files:** Create `src/lib/captures/comparisonHistory.ts` and `comparisonHistory.test.ts`; consume `ComparisonSummarySnapshot` and `comparisonDelta`.

- [x] Test a complete pass/fail/inconclusive snapshot round trip; returned values must not alias mutable inputs. Reject malformed schema, unsupported version, duplicate IDs, impossible outcomes, non-finite values, excessive sizes and over-50 history without overwriting original text. Test storage read/write exceptions and confirmed removal without changing other records.
- [x] Run the test and confirm it fails for the absent module; implement `loadComparisonHistory(storage)`, `saveComparisonResult(record, storage)`, and `removeComparisonResult(id, storage)` with strict validation, bounded strings/arrays, and explicit errors. Compare stored check observations/outcomes to their metrics where possible; never coerce bad values.
- [x] Run focused tests and typecheck; verify all pass.

### Task 2: Result history and comparison integration

**Files:** Create `src/components/telemetry/ComparisonHistory.tsx`, `comparison-history.css`, `ComparisonHistory.test.tsx`; modify `CaptureComparisonPanel.tsx` and its test.

- [x] Add failing UI tests for save, close/reload/inspect, no-check/stale/draft gating, failed storage, confirmed/cancelled removal, and CSV export from the historical snapshot rather than the current comparison.
- [x] Factor one current `ComparisonSummarySnapshot` in the panel and use it both for its existing CSV export and explicit save action. Add a historical list that reads validated storage and exposes distinct accessible row actions; preserve existing results on errors. Reuse the native export stream and release incomplete streams. Display source paths as context, saved times, check outcomes, statistics and reasons; clearly label the snapshot historical.
- [x] Implement theme-aware responsive styles and keyboard focus; run focused tests and typecheck.

### Task 3: Documentation, desktop and final self-review

**Files:** Modify `README.md`, `RELEASE_NOTES.md`, `docs/design.md`; ignored `output/` holds evidence.

- [x] Run `npm test` and `npm run check`; resolve regressions and record results.
- [x] With isolated PTY captures, compare two known signals, save a checked result, reload, inspect and export it; verify values/outcomes and preservation after an unavailable capture. Exercise remove cancellation and confirmation. Inspect desktop and 320/390px layouts in Dark, Light and Sage; test keyboard and focus.
- [x] Review the entire branch diff from `main` (including acceptance checks) for correctness, data preservation, stale state, UI/accessibility and test gaps. Fix important findings with regression tests, rerun checks, update docs, and prepare the reviewed commits. Push them to `main` using a safe fast-forward update after verification; never force-push.
