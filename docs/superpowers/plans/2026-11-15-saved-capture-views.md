# Saved capture views Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution, then one fresh-context reviewer.

**Goal:** Save and recall named local capture-library filter combinations.

**Architecture:** A strict local-storage module owns filter/view types and persistence. A focused controls component owns view management and recovery UI. SavedLogsScreen supplies current filters and applies selected filters to its existing pipeline.

**Tech Stack:** React/TypeScript, token CSS, Vitest, existing desktop bridge.

**Spec:** `docs/superpowers/specs/2026-11-15-saved-capture-views-design.md`

## Global Constraints

- Up to 24 views, names 1–48 normalized characters, query at most 2000 characters; versioned local storage only.
- No silent overwrite/reset of invalid saved data; explicit application and two-step removal.
- Preserve existing capture/search/reset behavior, all three themes and 320px layouts. No dependencies.

## Review Focus

- Corrupt/unsupported storage must survive failed reads and subsequent write attempts.
- Repeated submissions and duplicate names cannot create unwanted extra views.
- Applying a view must restore all filters together and trigger the correct existing search scope.
- Missing tag options, stale saved names and no matching captures remain understandable.
- Keyboard cancellation/removal/failure paths must leave focus on a usable control.

## Tasks

### 1. Storage contract

Files: create `src/lib/captures/captureViews.ts` and `.test.ts`.
Interfaces: `CaptureViewFilters`, `CaptureView`, `loadCaptureViews`, `saveCaptureView`, `removeCaptureView`, `captureViewMatches`, `CaptureViewsReadError`.
- [x] Write failing tests for round-trip fields and independent copies, duplicate/invalid names, limits, invalid versions/filters/ids and preserved malformed data, storage quota failures, stable removal and filter equality.
- [x] Watch failure, implement strict validation and reload-before-write persistence, run focused tests.

### 2. Controls and integration

Files: create `src/components/captures/CaptureViewsControls.tsx`, `capture-views.css`, controls tests; modify SavedLogsScreen and organization integration tests.
Interfaces: controls consume `{filters: CaptureViewFilters, onApply, children}`; supply native selector, inline manager, persistence errors and recovery. Parent owns current six filter fields.
- [x] Write failing integration checks for save/apply/reopen/remove, filter results/scope, duplicate/save failure, retry, explicit-only apply and Escape focus.
- [x] Implement component and apply handler; reuse organization filter layout and preserve missing selected tags.
- [x] Run focused tests and typecheck; check current-library behavior remains intact.

### 3. Polish, review and delivery

Files: README.md, RELEASE_NOTES.md, review record under `docs/superpowers/reviews/`.
- [x] Capture/inspect desktop and narrow actual App renders with fixtures. Check themes, focus, long names, empty/error states and contrast; fix observations.
- [x] Document feature and local-only boundaries; run `npm test`, `npm run build`, `git diff --check`.
- [x] Dispatch one fresh-context code reviewer, fix actionable findings, verify changed paths, commit and push `feature/saved-capture-views`.

## Ledger

- Ruling: continue the user's established separate-branch, inline implementation workflow; no additional worktree or approval checkpoint is needed for the delegated feature choice.
- Baseline: current main contains both prior features and UI polish at cbbf4ca.

- Storage boundary review: raised the shared serialized cap to400000 and guarded writes; full escaped-query regression now passes.
- Verification: 310 frontend tests passed (one Windows skip),77native tests passed, build/typecheck/format passed. Independent review cleared; current screenshots and remaining environment limits recorded in the review document.
