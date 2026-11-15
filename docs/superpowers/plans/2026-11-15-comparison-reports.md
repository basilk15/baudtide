# Comparison reports Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, followed by one fresh-context code reviewer.

**Goal:** Preview and explicitly copy comparison evidence as safe, shareable Markdown.

**Architecture:** A pure formatter consumes existing comparison snapshots and explicit context/options. A shared disclosure owns preview/path consent/clipboard UI. Current and saved comparison components provide their existing snapshots and invalidate current reports with comparison edits.

**Tech Stack:** React, TypeScript, token CSS, Vitest; existing clipboard API.

**Spec:** `docs/superpowers/specs/2026-11-15-comparison-reports-design.md`

## Global Constraints

- No uploads, dependencies, capture mutations or automatic clipboard writes.
- Local capture path fields are opt-in per report; literal escaping is mandatory.
- Include uncertainty and historical/current provenance, full precision, UTC boundaries and unavailable data.
- Preserve all existing CSV/history/check flows and all three themes; page fits at 320px.

## Review Focus

- Markup/newlines/HTML/link syntax in labels and reasons cannot become executable or structural Markdown.
- No-check, approximate, incomplete and zero-baseline evidence must stay honest.
- Copy pending, denied, stale-content and unmount paths must not claim false success.
- Current edits invalidate reports; saved reports must work without reopening captures.
- Repeated source pairs need distinct accessible action names and focus restoration.

## Tasks

### 1. Formatter

Create `src/lib/captures/comparisonReport.ts` and `.test.ts`.
Produce `comparisonReportMarkdown(snapshot, options): string` with source context, optional saved timestamp/paths, path consent and current quality reasons.
- [x] Write failing tests for numerical/provenance/check evidence, unavailable values/zero baseline/no checks, escaping, default path omission and explicit inclusion, and determinism.
- [x] Observe failure, implement pure formatter, run focused tests.

### 2. Preview and integration

Create `src/components/telemetry/ComparisonReport.tsx`, `.test.tsx`, and `comparison-report.css`; modify CaptureComparisonPanel and ComparisonHistory plus their tests.
- [x] Write failing tests for explicit copy, pending duplicate protection, denial/manual selection, Escape/focus, stale result changes and historical/current entry points.
- [x] Implement shared disclosure with bounded source preview and opt-in path checkbox; connect current/saved snapshots and quality reasons with unique labels.
- [x] Run focused interaction/integration tests and typecheck.

### 3. Polish and delivery

Update README.md and RELEASE_NOTES.md; record review under `docs/superpowers/reviews/`.
- [x] Inspect current-run rendered screenshots: desktop/narrow, themes, long text, error/pending/success and focus; fix observed issues.
- [x] Run `npm test`, production build, Rust formatting/Clippy and `git diff --check`.
- [x] Request independent code review, resolve findings, verify and commit/push `feature/comparison-markdown-reports`.

## Ledger

- Base is the completed saved-view iteration cc9f9ba; keep earlier work present without merging main as part of this feature.
- Continue the established separate-branch/inline workflow under the user's delegated choice and design scope.
- Baseline: 310 frontend tests passed with one Windows platform skip.

- Complete: 322 frontend tests passed (one Windows skip), 77 native tests passed, format/Clippy/typecheck/build and whitespace checks passed. All 33 focused tests independently cleared; Markdown leading-marker finding fixed with regression evidence. Current screenshot/review record is under `docs/superpowers/reviews/2026-11-15-comparison-reports-review.md`.
