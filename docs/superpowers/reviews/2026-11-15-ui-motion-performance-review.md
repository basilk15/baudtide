# UI motion and responsiveness review

Scope: follow-up to UI polish commit 7e5c770 on `feature/comparison-markdown-reports`. Keep the established workbench styling and all serial-session/capture behavior.

## Verified issues and changes

- **Terminal tabs moved after selection.** The former switch set a 5px vertical offset, waited 32ms, then transitioned back over 240ms. Removed this extra state, timer and transform. The active indicator and content now update together without shifting output. Monitors remain mounted; display activation, state and native readers retain their existing behavior.
- **Launch waited for a fixed introduction.** The splash previously used 1750ms/2100ms timers regardless of setup. It now exits 140ms after preferences/session recovery settles, or immediately with reduced motion. If the backend stalls, a one-second escape timer dismisses only the splash; connection recovery remains guarded until the real requests finish. The progress animation remains indeterminate while waiting.
- **Home entrance delayed ordinary controls.** Replaced the 500ms spatial entrance and 70/135ms sibling delays with a restrained 160ms opacity change from an already-visible state. It releases its animation layer after entry.
- **Decorative work continued in hidden windows.** The welcome chart now pauses its 650ms simulation interval when the document is hidden or reduced motion is enabled. It responds to live preference/visibility changes and resumes from the retained frame. Real terminal ingestion and watches are unaffected.

## Evidence

The actual App was instrumented with React Profiler in an ignored local fixture, with four synthetic native sessions and 500 retained lines per terminal. The native bridge was mocked; no hardware was connected.

| Check | Before | After |
|---|---|---|
| Six warm tab switches: nonzero React render passes | 12 | 6 |
| Artificial tab reset timer | 32ms per switch | Removed |
| Terminal output translation | 5px followed by 240ms return | None |
| Retained rows across four warmed panels | 2000 | 2000 |
| Normal setup-ready splash handoff | Fixed 2100ms introduction | 140ms exit after readiness |
| Home entrance | 500ms plus sibling delays | 160ms; no spatial movement/stagger |

The render-pass count supports reduced unnecessary work, **not a frame-rate or wall-clock speedup claim**. Raw development Profiler durations varied, and the background browser host changed timer cadence during comparison. These timings were not used as FPS, INP or production-latency evidence. Raw observations are saved under `output/motion-review/render-evidence.json`.

Page switches, the chart workspace, sidebar collapse and theme/navigation surfaces were inspected. Initial page samples included roughly 7–18ms primary development React commits, with additional first-use chart initialization. The evidence did not establish a separate repeatable sidebar/chart bottleneck, so those internals were preserved.

Current screenshots saved and reopened:

- `output/motion-review/01-terminal-tabs.png`: populated terminal, selected tab and retained output at 1280px.
- `output/motion-review/02-home-narrow.png`: home at 390px; zero document horizontal overflow measured.

![Populated terminal after tab-motion cleanup](../../../output/motion-review/01-terminal-tabs.png)

## Review and verification

- Four new regression tests failed before their fixes and now pass. They cover waiting for setup, cancelling fallback/exit timers, prompt completion, stalled setup, reduced motion, document visibility and resumption.
- Independent review identified the indefinite-splash risk. Added and verified the bounded escape without changing native recovery guards. Final review found no remaining actionable issue.
- Final frontend/Electron suite: **332 passed, one Linux-only permission test skipped on Windows** (62 test files).
- Production build and typecheck passed; existing Vite large-chunk warning remains. `git diff --check` passed.
- Screenshots prove layout/state, not animation frame rate. Browser-tool automation plus synthetic data does not substitute for physical-device profiling or a native-window FPS trace.

Plan: `docs/superpowers/plans/2026-11-15-ui-motion-performance.md`.
