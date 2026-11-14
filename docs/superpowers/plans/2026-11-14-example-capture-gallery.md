# Example Capture Gallery Implementation Plan

> Implement inline with test-driven development and a final fresh code review.

**Goal:** Make hardware-free evaluation discoverable through two useful local recordings.
**Architecture:** A shared JSON catalogue describes bundled synthetic captures; Electron resolves allowlisted IDs and imports through CaptureBundleService. React shows the catalogue in Saved logs and reuses existing recovery.
**Tech Stack:** React/TypeScript, Electron/Node, existing Rust sidecar, Vitest.
**Spec:** docs/superpowers/specs/2026-11-14-example-capture-gallery-design.md

## Global constraints

Preserve existing capture data, quota, and restoration. No serial connection, network transfer, dependency, or automatic navigation. Support dark, light, and sage themes, keyboard operation, and narrow layouts.

## Review focus

Unknown/path-like IDs must fail; UI descriptions must match bundled bytes; a failed restoration remains recoverable; repeated imports remain independent; Open in Visualize must target the imported item.

### Task 1: Catalogue and assets

- [x] Add tests for allowlisted filename resolution and both bundled examples, including timing, notes, and custom decoder.
- [x] Observe failure, implement shared catalogue and resolver, extend deterministic fixture generation, and update packaging.
- [x] Regenerate fixtures and run focused tests.

### Task 2: Gallery and integration

- [x] Add UI tests for selection, explicit import, busy state, and a populated library's gallery/import/open flow.
- [x] Observe failure; build the inline ExampleCaptureGallery with scoped tokens and responsive layout.
- [x] Pass optional example IDs through the existing narrow desktop command; reuse restoration and recovery without reporting partial restoration as success.
- [x] Run focused UI and bridge tests.

### Task 3: Verification and documentation

- [x] Exercise both examples with the actual sidecar; run frontend/native suites and production build.
- [x] Inspect gallery across themes and narrow sizes using the workspace browser; record limits.
- [x] Obtain fresh code review, resolve findings, update README and release notes, commit and push the feature branch.

## Execution notes

The user delegated feature selection. Work remains on feature/example-capture-gallery. No additional worktree was created; the existing clean checkout is dedicated to this task. Main will not be merged as part of this iteration without a subsequent request.

Verification: 289 frontend tests passed (one existing Linux permissions test skipped on Windows), 77 native tests passed, production build passed, and both examples passed the real-sidecar smoke check including recorded timing, decoder metadata, independent repeated imports, and recovery. Focused gallery/import suites passed 10 tests after the final review fixes. The reviewer approved after fixing a stale Open action on recovery and adding the exact 60-second sample endpoint.

UI: inspected the dark rendered gallery in the workspace browser. Browser layout checks at 390 px showed no horizontal overflow and a 44 px import control; light and sage styles retained readable foregrounds on their primary controls. Subsequent screenshot capture timed out, so no claim is made of complete visual inspection of light/sage. The preview uses a mocked desktop bridge; actual file operations were exercised separately with the real sidecar.

Ruling: the completed-import action is generic (Open imported capture) so standard bundles and imports recovered after a restart receive the same correct action without adding provenance fields to the recovery format.
