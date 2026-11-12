# Portable Capture Bundles Implementation Plan

> **For agentic workers:** Implement task by task with test-driven development; steps use checkbox syntax for tracking.

**Goal:** Export and import one completed capture with raw bytes, receive timing, notes, and a chosen decoder so collaborators can replay it locally.

**Architecture:** Electron streams a versioned framed container and owns native file dialogs. The Rust sidecar validates and publishes files inside the capture library while enforcing capture quota; the renderer reviews included data and restores notes and decoder settings under new local identities.

**Tech Stack:** Electron/Node streams, React/TypeScript, Rust, Vitest and Node tests.

**Spec:** `docs/superpowers/specs/2026-11-12-portable-capture-bundles-design.md`

## Global Constraints

- Linux desktop remains the shipping target; no cloud service, automatic connection, or command execution.
- Do not overwrite source captures or existing library items; preserve timing fidelity and report incomplete metadata restoration.
- Reuse the existing signal-workbench design system, including keyboard focus and dark, light, and sage themes.

## Review Focus

1. A truncated, oversized, tampered, or unsupported container must fail before publishing any capture.
2. Active sessions and concurrent imports must not bypass quota or export moving data.
3. Imported notes and decoder IDs must not overwrite unrelated local records; failures must be visible and recoverable.
4. Raw data and notes may contain secrets; the export review must say so and no transfer is automatic.
5. Legacy captures without valid timing must retain an approximate state; repeated imports create independent library items.
6. Approximate replay needs original time bounds; preserve them without creating a reconnectable device identity.

### Task 1: Container format and file I/O

**Files:** Create `electron/capture-bundle.mjs` and `electron/capture-bundle.test.mjs`.

- [x] Write tests for byte-exact raw/timing round trips, bounded manifest, no timing, bad magic/version, truncated data, altered hashes, and trailing bytes.
- [x] Run the focused tests and confirm they fail for the missing module.
- [x] Implement streaming read/write using a framed, versioned manifest with lengths and SHA-256 digests, staged destinations, and cleanup after failure.
- [x] Run the focused tests and confirm they pass.

### Task 2: Library integration and desktop bridge

**Files:** Modify `src-native/src/backend.rs`, `electron/main.mjs`, `electron/contract.cjs`, and `src/lib/serial/serial.ts`; add focused service/native tests.

- [x] Test fresh destination names, active capture rejection, quota enforcement, and cleanup when publication fails.
- [x] Add a narrow native import operation that accepts only Electron-owned staged files, reserves raw plus timing quota before extraction under the existing sessions-then-quota lock order, and creates fresh library files. Check active and closing sources and prevent source replacement during export.
- [x] Add Electron-owned save/open dialogs and invoke the container service and native operations; renderer arguments never select arbitrary filesystem paths.
- [x] Run focused service and Rust tests, then the desktop bridge tests.

### Task 3: Metadata and user flow

**Files:** Modify `src/components/captures/SavedLogsScreen.tsx`, `src/components/captures/saved-logs.css`, `src/lib/captures/captureEvents.ts`, and decoder/workspace helpers as needed; add focused UI and storage tests.

- [x] Test export review and decoder choice, cancellation, successful import with remapped notes/profile, conflicts, and storage failure guidance.
- [x] Add and test the standalone export review dialog, plus strict, retry-safe note and decoder import helpers. The dialog remains disconnected until desktop import/export is implemented.
- [x] Add import/export controls and a compact, accessible review surface, using established design tokens and layouts.
- [x] Restore metadata with strict reads, capacity checks, new IDs, and an idempotent durable recovery record; preserve original time bounds and allow the included decoder to be applied on the imported capture.
- [x] Run focused UI/storage tests. Rendered theme inspection remains a follow-up because the desktop/browser host is unavailable in this environment.

### Task 4: Example, documentation, and verification

**Files:** Add a small synthetic example under the packaged `electron/` assets; update `README.md` and `RELEASE_NOTES.md`.

- [x] Generate or check in a deterministic example bundle and document the import/export flow and privacy boundary.
- [x] Run round-trip tests and the real-sidecar bundle smoke check; compile and lint the Linux target. Windows cannot run the Linux PTY suite, and one existing Windows symlink test requires privileges unavailable here.
- [x] Review the diff and record checks that the environment could not run.
