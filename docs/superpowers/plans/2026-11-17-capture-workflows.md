# Capture Workflows Implementation Plan
> Execute inline in sequence using superpowers:executing-plans.
**Goal:** Make recorded bench experiments easier to document, revisit and report.
**Architecture:** Separate validated local metadata modules and focused UI components, integrated into SavedLogsScreen.
**Tech Stack:** React, TypeScript, localStorage, Vitest.
**Spec:** docs/superpowers/specs/2026-11-17-capture-workflows-design.md

## Global Constraints
Local-first; no raw file mutation; no runtime dependencies; preserve themes and native search.
## Review Focus
- Corrupt storage: preserve data, show actionable errors.
- Failed writes: retain draft and previous state.
- Missing tags: saved filters remain selectable and clearable.
- Long user text: wrap without viewport overflow.
- CSV spreadsheet input: formula-like text stays inert.

### Task 1: Notebook
- [ ] Write failing storage validation/persistence tests and editor interaction test.
- [ ] Implement captureNotebook.ts, CaptureNotebook.tsx, styles and screen integration.
- [ ] Verify focused tests, typecheck; commit.
### Task 2: Saved views
- [ ] Write failing view round-trip, validation, duplicate and storage failure tests.
- [ ] Implement captureViews.ts and CaptureLibraryViews.tsx, integrate complete filter state.
- [ ] Verify focused tests and typecheck; commit.
### Task 3: Inventory
- [ ] Write failing CSV escaping/order/metadata tests.
- [ ] Implement captureInventory.ts and review/export component using filtered rows.
- [ ] Verify focused tests, document capabilities; commit.
### Task 4: Review and release
- [ ] Full UI review with screenshots across core screens, themes and narrow layouts.
- [ ] Self-review plus fresh code review; resolve substantial findings.
- [ ] Run repository quality checks, tests and production audit.
- [ ] Push feature branch for CI; after green CI and checking main has not advanced, fast-forward main.
