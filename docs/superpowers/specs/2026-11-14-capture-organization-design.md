# Capture tags and favorites

The user delegated the next feature iteration. My choice is local capture organization, building on the example-gallery branch: larger libraries need retrieval tools more than another analysis mode.

## Approach

Add favorites and lightweight tags to Saved logs. Folders/projects introduce hierarchy and moving-file semantics; favorites alone do not distinguish firmware or bench runs. Combine a one-click star with up to eight comma-separated tags, each up to 24 characters, normalized to lowercase with surrounding/repeated whitespace removed. Deduplicate tags; reject invalid/over-limit input instead of truncating.

Persist a versioned renderer-local library keyed by exact capture path, following existing note storage. Tags/favorites are local to this installation, excluded from bundles and raw files. Strict reads and read-before-write updates preserve unrelated metadata and unreadable storage. Bounded library: 10,000 entries, paths up to 4096 characters. Empty unfavorited entries are removed. Explicit capture deletion attempts metadata cleanup after raw deletion; a failure is reported without misreporting deletion. Do not prune unavailable captures implicitly.

## UX and direction

Use existing signal-workbench tokens and typography. A compact favorite icon with a descriptive pressed-state label joins row actions. Quiet tag chips sit beneath the capture identity; a Tags button opens one inline editor with Save, Cancel, validation, and local-only guidance. Focus the editor on opening and restore focus to its trigger on closing. Editor state does not reset on polling. A dedicated filter row contains Favorites, an accessible native tag select, and a count; combine these with existing state/content search and sorting. Counts and empty-state/reset actions must explain the active filters. No horizontal overflow at 320px. Favoriting preserves tags; editing tags preserves the latest favorite state.

A separate persistent organization error is not cleared by refreshing raw captures. Retry reloads the library; unreadable data disables editing/filtering until repaired. Failed writes preserve the displayed state and keep the editor open. Tags are local metadata and are not searched by the native captured-content search; the tag selector is independent.

## Verification

Tests cover persistence, normalization, limits, corruption, failed storage, unrelated edits, favorite/tag independence, filters combined with native state filters, empty/reset behavior, inline keyboard/cancel behavior, and deleted-item cleanup. Run frontend tests, native tests, typecheck/build and inherited bundle smoke. Review code independently and inspect rendered UI across themes/widths where possible.
