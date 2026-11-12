# Saved comparison results

## Purpose

Repeated bench tests need a way to revisit what was observed. Comparison checks currently disappear after a restart unless the comparison is rerun or exported. Let a user explicitly save a local, immutable snapshot of a completed comparison with configured checks, then inspect or export it later. Historical results describe recorded data at save time; they are not live tests and are not proof that hardware, captures, or clocks were correct.

## Choice and scope

A bounded local history inside Compare test runs reuses the existing comparison, exact statistics, checks and CSV export. A full multi-signal test-suite database would support broader automation but is disproportionate to this need; relying only on CSV leaves results disconnected from the bench. The user can save pass, fail, or inconclusive comparisons; no result is saved automatically. Store at most 50 results or 512 KiB, with explicit removal and no automatic eviction. Keep the history independent of saved-analysis workspaces, on the user's computer, without changing or requiring the raw captures after saving.

Each record retains a generated ID, save timestamp, baseline/candidate paths, and the complete existing comparison summary snapshot: source names, signal names and unit, anchors, requested and effective intervals, capture state and timing mode, sample counts, skipped-unit counts, full statistics, checks, observed values, statuses and inconclusive reasons. Reopening a result shows these saved values and limits and labels them as historical. It never silently recomputes or claims source files are unchanged. A missing or changed capture does not prevent inspection or CSV export. No automatic device commands, network requests, background testing, charts, or result sharing.

The local history uses one versioned localStorage entry. Validate all records and refuse to overwrite an unreadable, malformed, unsupported, oversized, or inconsistent library; show actionable guidance and preserve the original bytes. Validate records before saving, reject non-finite numbers rather than allowing JSON to turn them into null, preserve exact numeric values and reasons, and enforce unique IDs. A storage quota or unavailable-storage error leaves the existing history intact and offers retry guidance. Deleting requires explicit confirmation and deletes the result only, never the underlying captures. Export uses the existing safe cancellable desktop CSV stream and the saved snapshot, not the current comparison.

## Interaction and visual design

Add a secondary **Save result** action beside the completed comparison summary; it is disabled for stale/unavailable results, unsaved check drafts, work in progress, or no evaluated checks. Feedback confirms the local save. Below the current comparison, a **Saved results** section remains available without open captures. Use continuous ruled rows with saved time, baseline → candidate, signal, and text-and-icon Pass/Fail/Inconclusive. Each row expands to a compact evidence view with time zero, requested/effective intervals, timing, counts, full statistical values and per-check observations, limits and reasons, plus **Export CSV** and **Remove**. Identify rows accessibly; confirm deletion inline, preserve focus, and prevent simultaneous exports. Empty, full, loading, disabled, error and deletion-confirmation states are deliberate.

Follow `docs/design.md`: flat instrument surfaces, semantic Dark/Light/Sage tokens, restrained accent, mono numerical values, visible focus, text labels rather than color alone, and no decorative card grid. Stack controls at narrow widths; at 480px and below targets are at least 44px high and the page has no horizontal overflow at 320px. Keyboard users can save, open, export, cancel removal and remove a result. Respect reduced motion.

## Verification

Use unit tests for exact round trips, all three outcomes, limits, invalid versions/records, duplicates, non-finite data, quota failures, safe deletion, and read failure without data loss. Component/integration tests cover save/inspect/remove/cancel, restored results independent of captures, stale or absent check gating, CSV export and errors. Run `npm test` and `npm run check`; exercise save, reload, inspect and export with two isolated PTY captures. Inspect representative desktop and narrow screenshots across all three themes and exercise keyboard focus. Perform a separate self-review of the complete diff, including the preceding unmerged acceptance-checks work, before pushing the verified branch to main.
