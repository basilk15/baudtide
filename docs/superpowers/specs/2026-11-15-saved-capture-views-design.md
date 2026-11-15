# Saved capture views

The user delegated the next feature choice and requested the established implementation/testing/UI-polish iteration. My choice is named, local capture views: repeated bench work should not require reconstructing state, favorite, tag and search settings after every visit.

## Approaches

- Named filter views (chosen): reuse the existing query and organization pipeline. One small selector and a progressively revealed manager; no capture duplication.
- Capture collections: useful for grouping, but duplicates the tagging model and adds membership management.
- Bulk library actions: useful later, but introduces destructive/export scope without improving repeated retrieval.

These are my implementation choices under the user's delegated scope, not independently approved requirements.

## Behavior and boundaries

- Save the current query, complete-capture search flag, state filter, sort, favorites toggle and tag as a named view. Applying a view restores all six fields together through the existing search/filter pipeline.
- Applying is explicit. Opening the library never automatically restores a view or launches its complete-capture search.
- A selector shows the first saved view matching the current filters, otherwise Current filters. Manual changes leave saved views unchanged. Reset organization retains its existing search-preserving behavior.
- A compact Views control expands one inline manager containing a labeled name field, an honest summary of the current settings, Save view, and a list of saved views with Apply and a two-step Remove action. Escape/Close returns focus to the trigger. Removing a view does not delete captures or change the current filters.
- Persist locally under `baudtide.capture-views.v1`, version 1, with up to 24 views. Each view has a unique stable id, a normalized nonempty name of at most 48 characters, and validated filters. Case-insensitive duplicate names are rejected. Query limit 2000 characters; tags use the existing normalized 24-character format. Read/write errors are visible and recoverable; malformed/unsupported data must be preserved, never silently reset.
- Raw logs, bundles and native metadata are unchanged. No new dependencies, network service, automatic device actions, or default views.

## UI direction

Extend the Operate surface from `docs/design.md`: graphite/light/sage tokens, Ubuntu Sans and Mono, restrained aqua for active state, flat ruled surfaces, existing control radii. Keep the manager collapsed during normal capture browsing. Group the view selector beside the existing local filters; the expanded manager spans the available filter area. Long names and summaries wrap. Support 320px, intermediate and desktop layouts, visible keyboard focus and 44px narrow-screen actions.

## Verification

Exercise storage round trips, limits/invalid schemas, duplicate names, write/read failures and preserved data. Integration tests must save/apply/reopen/remove a view, verify actual row results and search scope restoration, and retain drafts/errors on failure. Inspect actual App renders with representative capture fixtures across themes and viewport sizes, empty/error/long-content states. Run the full frontend/native suite, production build and fresh-context code review before pushing the feature branch.
