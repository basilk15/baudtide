# Capture feature UI review — 14 November 2026

Scope: example capture gallery and capture tags/favorites on `feature/capture-tags-favorites`.

The UI now has a clearer hierarchy and less visual noise. The existing workbench palette, typefaces, capture actions, synthetic recording disclosure and local-only organization are preserved.

## Findings and fixes

| Location | Finding | Resolution |
| --- | --- | --- |
| `ExampleCaptureGallery.tsx` / `example-capture-gallery.css` | Gallery was 733px tall at a 1280×800 viewport, with import ending at y997. Repeated labels, oversized plot and stacked facts consumed the screen. | Compact title/disclosure line, fixed-height trace, three-column facts on desktop, simpler example choices and tighter spacing. Final DOM measurement: 547px tall; import ends at y761 with the page at the top. Narrow screens retain stacked facts and a full-width import action. |
| `SavedLogsScreen.tsx` / `capture-organization.css` | State/sort controls and local filters formed detached bands. | One organization surface with a subtle internal rule; local-only disclosure remains visible. |
| `capture-organization.css` | Favorite/tag controls and tag chips competed with capture actions. | Quiet controls, soft tag surfaces, clear selected favorite state, retained hover/focus styling. |
| `saved-logs.css` | Header actions wrapped unevenly. Long capture names were aggressively truncated on narrow screens; the file icon drifted down beside an expanded editor. | Stable desktop action row, deliberate narrow button grid, wrapping capture names and top-aligned icons. |
| `CaptureOrganizationControls.tsx` | Failed saves left focus on the submit button; the expanded editor had no explicit control linkage. | Focus returns to the invalid input, error association remains intact, trigger links to the form. Regression assertions added. |
| `SavedLogsScreen.tsx` | Search relied on placeholder text for its accessible name. Empty organization results suggested changing sort, which cannot change membership. | Explicit search label/name/autocomplete; empty-state guidance names state, favorite and tag filters. |

## Evidence and validation

- Inspected real React App screens through a local mock desktop bridge, with representative completed/interrupted captures, tags and a favorite. These are visual fixtures, not hardware end-to-end validation.
- Desktop 1280×800 and actual iframe viewports at 320px and 390px: capture content had zero horizontal page overflow. Inspected the library, both example choices, editor, selected favorite, combined filters, validation and successful example import status.
- Dark, light and sage theme checks used computed colors. Sampled organization helper/control text and tags ranged from 5.62:1 to 9.9:1 contrast, above the 4.5:1 body-text target. This is a focused sample, not an exhaustive accessibility certification.
- Keyboard/editor behavior: initial input focus, retained invalid draft, invalid-field focus, Escape cancellation, single editor coordination and filtering focus are covered by tests. Busy gallery selection and explicit import are also covered.
- Fresh final verification: `npm run test:frontend` — 55 files passed, 300 tests passed, one Linux-only permission test skipped on Windows. `npm run build` — typecheck and production build passed. Existing large-chunk build warning remains.
- Independent fresh-context code reviewer: no blockers or actionable regressions. Reviewed CSS cascade, narrow wrapping, themes, selection/busy behavior and editor focus.
- `git diff --check` passed.

## Screenshot record and limits

Exact PNG bytes were saved and the baseline library and saved after-images were reopened for inspection under `output/ui-review/` (ignored local review artifacts):

- `01-before-library.png`, `02-before-gallery.png`: baseline screenshots.
- `03-after-library-light.png`, `04-after-gallery-dark.png`: desktop refinement screenshots.
- `05-after-editor-320.png`, `06-after-gallery-sage-390.png`: narrow editor and gallery screenshots.
- `07-final-gallery-dark.png`, `08-final-library-light.png`: final desktop screenshots, saved and reopened for inspection.

The first browser tab later returned `screenshot_no_frame`; resize/full-page retries did not restore painting. A fresh tab restored capture and allowed the final desktop gallery and library screenshots above. Final geometry and markup were also checked through the live DOM and the final build/tests. The native desktop application was not visually captured in this pass.

The 320px screenshot also exposes an existing global topbar overlap outside the capture features. Capture controls remain within their viewport; global shell compression should be reviewed separately across all screens.

Review guidance: Impeccable polish/craft floor, frontend-design, product-design screenshot audit, the repository design context, and the [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md).
