# Shareable comparison reports

The user delegated the next feature and requested the same plan/build/test/UI-polish iteration. My choice is Markdown comparison reports: existing full-interval statistics, acceptance checks and retained results should be easy to paste into an open-source issue or discussion with their evidence limits intact.

## Approaches considered

- Markdown preview and explicit clipboard copy (chosen): works with issue/discussion editors and the existing browser/desktop UI, needs no new dependency, service or file permission.
- Native Markdown file export: useful later, but broadens the existing CSV/JSON export protocol for the same initial sharing task.
- Hosted report links: introduces uploading, accounts and retention into a local-first product.

These are my implementation decisions under the user's delegated scope.

## Contract

- Add Create report to current comparison results and retained historical results. One focused shared component reveals a local, read-only Markdown preview with Copy Markdown and Select report actions. Nothing is copied merely by opening it.
- Current reports reflect the currently valid comparison and check state, including quality reasons even without checks. Historical reports use only the retained snapshot and saved timestamp; they never reopen or re-evaluate captures.
- Include baseline/candidate names, signals/unit, capture states and timing modes, UTC alignment/requested/effective intervals, reading/exclusion counts, four statistics, signed candidate-minus-baseline differences/percentage changes, check definitions/observations/outcomes and deduplicated evidence notes.
- Preserve null/unavailable measurements, zero-baseline percentage limits, approximate timing and inconclusive outcomes. State that a pass applies to the recorded interval, with no unit conversion and population standard deviation.
- Omit capture path fields by default. An explicit Include local capture paths checkbox adds them to this preview/copy only. Names and evidence notes remain included; do not claim automatic redaction. No raw output, uploads, network requests, new persistence or dependencies.
- Treat all user-supplied labels/reasons/paths as literal Markdown table/list text: normalize line breaks and escape markup, pipes, HTML and link/mention syntax.
- Explicit copy has synchronous duplicate prevention, pending/error/success states and stale-content/unmount protection. Clipboard denial leaves a usable Select report/manual-copy fallback. Escape/collapse restores trigger focus.
- Disabling/report reset follows current comparison validity and draft-check state. Avoid making stale results shareable after a source/range/check change.

## UI direction

Extend `docs/design.md` and the existing comparison workbench. Keep the report collapsed by default; use a quiet disclosure, one ruled panel, a clear action row and a bounded source preview in the existing data font. Preserve dark/light/sage themes, visible focus, 44px narrow controls and 320px page fit. Preview may scroll internally as code; the page must not overflow.

## Verification

Test exact report measurements/provenance, unchecked and inconclusive cases, zero baseline, adversarial text, default path omission/explicit inclusion and deterministic output. Test copy/selection/denial/pending/unmount flows and both integration entry points. Inspect current-run actual App/component renders with representative fixtures across themes and widths; run full frontend/native tests, typecheck/build, format/Clippy, independent review, then push the new feature branch.
