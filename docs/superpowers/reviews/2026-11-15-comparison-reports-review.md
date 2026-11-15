# Comparison report review

Scope: `feature/comparison-markdown-reports`, based on completed saved-view iteration cc9f9ba. The feature adds explicit Markdown preview/copy to both current comparisons and historical saved results.

## Behavior and evidence

- Pure formatting preserves full-precision statistics, signed differences, unavailable values, zero-baseline percentage limits, units, UTC alignment/ranges, reading/exclusion counts and acceptance definitions/observations/outcomes.
- Current reports include current quality reasons even without checks. Historical reports use the retained snapshot and explicitly say captures were not reopened or rechecked.
- Path fields are omitted until explicitly selected. Closing a report resets path consent. Names, labels and evidence notes are disclosed; no claim of automatic redaction is made.
- Opening does not copy. Explicit Copy has a synchronous duplicate guard, pending/denied/success handling, stale-text and unmount protection. Select report preserves a manual fallback.
- Current source/range/check changes invalidate or disable the preview. Saved result reports work without accessing original capture files.

## UI polish

- Actual comparison rendering exposed inherited grid labels, a full-width checkbox and inline-block buttons. Scoped component-owned selectors fix checkbox size/alignment and icon spacing without altering neighboring forms.
- Kept the report collapsed by default, with one ruled panel, a bounded source preview and clear copy/selection actions. Opening scrolls the report into view while placing focus on its read-only preview.
- Narrow actions fill the available width with 44px targets; source text scrolls internally. Page overflow measured zero at 320, 390, 720 and 1280px.
- Dark, light and sage styles were inspected. Sampled report text/control-label/source contrast ranged from 5.62:1 to 11.33:1. This focused sampling is not a complete accessibility certification.
- Context-specific names distinguish report regions and copy/selection/path controls for repeated saved source pairs. Disclosure reports the actual current path-inclusion state. Escape and Close restore trigger focus.

## Review and validation

- Independent reviewer found one P2: leading evidence list markers/indentation could become Markdown structure. Added a failing regression, then escaped leading unordered/ordered markers, rules and indentation. The reviewer independently cleared the fix and final UI/accessibility delta with no remaining blockers.
- Final focused suite: 33 tests passed. Tests cover adversarial markup/HTML/links/mentions/table text, evidence caveats, history provenance, current invalidation and check drafts, opt-in paths, explicit copy, unavailable/denied clipboard, duplicate pending actions, stale completion, unmount and focus/selection.
- `npm test`: 322 frontend/Electron tests passed, one Linux-only permission test skipped on Windows; 77 native tests passed. Final frontend rerun remained green after accessibility refinements.
- `npm run build`: typecheck and production build passed. Existing large-chunk warning remains.
- `npm run format:check` and `npm run lint:rust` passed (GNU toolchain explicitly selected for local Clippy).
- `git diff --check` passed.

## Screenshot record and limits

Current-run exact PNGs saved under ignored `output/comparison-report-review/` and reopened for inspection:

- `01-before-polish-dark.png`: inherited-control styling defect before polish.
- `02-current-dark.png`, `03-current-light.png`: final current-report desktop previews.
- `04-saved-sage-390.png`: final saved-report narrow layout.
- `05-clipboard-error-320.png`: final error/manual-copy recovery layout.

Screenshots use the actual comparison/index/chart/report components with synthetic samples and the production stylesheet order in a local fixture. Clipboard error/success states were exercised with controlled browser clipboard mocks; native-window/hardware clipboard behavior was not captured. Browser tab registration intermittently timed out; an existing tab and iframe viewport captured valid evidence. No screenshots from earlier iterations were used.

Guidance: repository design context, Impeccable Operate/craft/polish, screenshot-first audit, [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md), TDD and fresh-context code review.
