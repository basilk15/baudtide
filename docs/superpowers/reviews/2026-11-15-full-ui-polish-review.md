# Full UI scan and polish

Scope: working UI on `feature/comparison-markdown-reports`, following commit 64e2374. Preserve the graphite, light and sage workbench identity. This pass covers the application shell and major pages as well as the new capture tools.

## Findings and fixes

1. **P1 — filled button contrast.** The light-theme New terminal label measured 2.92:1 against its fill. `--color-accent-ink` was being used for both soft backgrounds and filled controls. Added `--color-on-accent` and used it for filled primary actions, the capture-search checkmark, autoscroll knob and companion brand. Dark keeps its dark foreground; light and sage use white. The corrected browser measurement is **5.79:1**. Soft selection colors retain their existing token.
2. **P1 — mobile drawer keyboard access.** Opening left focus in underlying content; Escape and Tab containment were missing. Added dialog semantics, initial focus, inert background with original-state restoration, Tab wrapping and Escape/close focus return. Desktop resize releases the drawer and focuses the selected desktop navigation item.
3. **P2 — 320px header overlap.** Search, the brand and the fixed navigation trigger collided. Omit the redundant brand/preferences shortcut below 381px, preserving Preferences in navigation. Measured separate 44px navigation/search/notification targets after the fix. Keep breadcrumbs on one line and truncate runtime text before it squeezes controls.
4. **P2 — application shortcut conflict.** Independent review found Ctrl/Cmd+K could open the command palette behind the drawer. Drawer key events now stop before reaching window-level application shortcuts, preserving native button activation. A failing regression demonstrated the conflict before the fix.
5. **P2 — missing current-page navigation.** Preferences and Help now expose the current page and its selected styling. This also fixes focus restoration when resizing from those pages. Resize coverage includes Logs, Preferences and Help.
6. **P3 — hierarchy and repetition.** Removed redundant workspace/settings/getting-started/new-terminal/issue-tracker labels. Kept headings, factual descriptions and controls. Removed orphaned home-label CSS and eased overly tight display tracking. Group New terminal and active count ahead of workspace-management controls so wrapping does not bury the primary action.
7. **P1 — modal layering and arrival.** The bundle review appeared beneath the sticky header/sidebar, and initial Cancel focus scrolled past its heading in a 500px-tall window. Persistent opacity animation and main-page isolation created stacking contexts. Entry animations now release their layer, modal pages suppress entry animation and the main container releases isolation while a modal is open. Bundle initial focus moves to the visible header Close control without scrolling, covered by a failing-then-passing regression. Browser hit tests confirm the backdrop is topmost over both header and sidebar; the dialog opens at scroll position zero with its heading visible.

## Captured steps

The current-run PNGs are under `output/full-ui-scan/` (ignored local evidence). Exact returned browser images were saved and reopened for inspection. Each capture shows a specified viewport or scrolled position; the application owns its normal internal scrolling. The surrounding dark area is the fixture host.

| Step | Surface | Result and evidence |
|---|---|---|
| 1 | Shell / 320px header | Overlap corrected; `01-before-logs320.png`, `08-after-header320.png`. |
| 2 | Navigation | Keyboard/focus fixes verified in browser and regression tests; `02-before-nav320.png`, `15-after-nav720.png`. |
| 3 | Connection setup | Redundant label removed; no-port recovery and framing form inspected; `03-before-connection.png`. |
| 4 | Live terminal arrival | Primary action grouping and contrast improved; `04-before-terminal.png`, `16-final-terminal-light.png`. This was an empty-session review. |
| 5 | Saved logs and views | Long names, filters, save form and action rows inspected; `05-before-views.png`. |
| 6 | Visualization arrival | Source controls, analysis picker and empty signal area inspected; `06-before-visualize-desktop.png`. |
| 7 | Mobile sharing arrival | Source selection and empty guidance remain coherent; `07-before-mobile.png`. No link was started. |
| 8 | Preferences | Cleaned heading, light theme inspected; `09-after-prefs-light.png`. |
| 9 | Help / feedback | Cleaned heading, sage theme inspected; `10-after-help-sage.png`. |
| 10 | Example gallery | Actual synthetic example rendering inspected; `11-scan-gallery.png`. |
| 11 | Comparison report | Current-result report inspected at 320px, zero document horizontal overflow measured; `12-scan-report320.png`. |
| 12 | Command palette / notifications | Narrow overlays inspected; `13-scan-palette320.png`, `14-scan-notifications320.png`. |
| 13 | Bundle export review | Layering and initial scroll corrected; `17-final-bundle-fixed.png`. No export was submitted. |

![Light-theme terminal actions](../../../output/full-ui-scan/16-final-terminal-light.png)

![Bundle review above the application chrome](../../../output/full-ui-scan/17-final-bundle-fixed.png)

## Validation and limits

- Regression tests were observed failing before drawer behavior and shortcut fixes. Final coverage includes focus, Tab/Shift+Tab, Escape, preserved inert attributes, navigation, app shortcuts and desktop resize.
- Final full frontend/Electron suite: **328 passed, one Linux-only permission test skipped on Windows**. Production build and typecheck passed. Existing Vite large-chunk warning remains.
- `git diff --check` passed. Independent reviewer cleared the implementation, with the shortcut and Preferences/Help focus findings resolved.
- Tests use actual React components. Browser screenshots use the actual App with a mocked desktop bridge and synthetic capture metadata, plus the real comparison/report components with synthetic readings. No user hardware, LAN sharing, OS file pickers or hardware clipboard was exercised.
- This is a broad UI scan, not an accessibility certification or an exhaustive state/browser matrix. Dark, light and sage were sampled. Main evidence uses 320px and 1280px widths with a 500px-tall window; the navigation was additionally inspected at 720px. Earlier oversized/duplicated host captures and blank/loading frames were rejected.
- Browser host registration, frame capture, connection and approval-review timeouts interrupted additional checks; capture resumed after reload. The attempted automatic page/size matrix did not complete and is not counted as validation. No full native-desktop UI claim is made.
- No new dependencies, native APIs, uploads or capture mutations were introduced.

## Assessment

The fixes address verified defects while preserving the existing product style. Instrument framing, continuous capture rows and existing theme roles remain consistent. Accessibility, theme contrast and responsive behavior improved in the inspected states; broader hardware/native-window validation remains outside this evidence.
