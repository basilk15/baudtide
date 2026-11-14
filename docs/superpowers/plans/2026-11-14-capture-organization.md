# Capture Organization Implementation Plan

**Goal:** Organize a growing local capture library with tags and favorites.
**Architecture:** Strict versioned localStorage helper; scoped row controls and inline tag editor; filters in SavedLogsScreen, composed with native search/state/sort.
**Tech stack:** React, TypeScript, existing design tokens, Vitest; no new dependency or native command.
**Spec:** docs/superpowers/specs/2026-11-14-capture-organization-design.md
**Base:** c789963 on feature/example-capture-gallery (not yet merged into main).

## Constraints and review focus

Preserve captures/notes and unrelated organization entries. Fail visibly on storage corruption or quota errors. Do not lose tags when toggling favorites, or overwrite a newer favorite when saving tags. Keep filters and counts coherent, and never suggest native content search matches tags. Tags stay installation-local.

### Task 1: Persistence
- [x] Add failing tests for normalized/deduplicated tags, limits, corruption, write failures, unrelated updates, and cleanup.
- [x] Implement captureOrganization.ts with strict reads and read-before-write operations; run focused tests.

### Task 2: Controls and integration
- [x] Test favorite/tag controls, cancel/focus, filtering/reset, and failed writes before implementing.
- [x] Add scoped controls/CSS and integrate filters with existing list organization; maintain polling/editor stability.
- [x] Clean metadata after explicit deletion, reporting cleanup failures separately.

### Task 3: Verification
- [x] Run full frontend/native checks, production build, and sidecar smoke.
- [x] Inspect rendered UI and responsive themes; record evidence limits.
- [x] Complete independent code review, fix findings, document, commit, and push the feature branch.

## Verification record

300 frontend tests passed; one existing Linux-only permissions test skipped locally on Windows. 77 native tests and the inherited real-sidecar bundle smoke passed. Typecheck and production build passed. Focused organization tests: three files, eleven tests. The independent reviewer approved after fixes for single-editor coordination, read errors discovered during writes, and focus restoration when an edit hides a filtered row.

Rendered dark preview inspected with the mocked desktop bridge; browser interactions verified normalized tags were saved. The screenshot provider produced a cropped image, so layout checks were also used. At a real 320px iframe viewport, page width was 320px and editor scroll width matched its client width. Light and sage save controls used white text on their existing dark accents. These are browser-layout checks, not full screenshot approval of every theme. Persistence and deletion errors were exercised by automated tests; raw capture operations were exercised separately with the real sidecar.
