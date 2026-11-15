# UI motion and responsiveness

Continue on the existing feature branch. Preserve the visual style, session state, native readers and captures.

Motion intent: routine navigation must expose the new content immediately, without moving the terminal output after selection. Launch should acknowledge actual setup, with a short exit instead of a fixed promotional delay. Decorative loops should sleep when users cannot see them or request reduced motion.

Measured baseline: four synthetic native sessions, 500 retained terminal rows each, actual App in the browser with React Profiler. Six warm tab switches each had a nonzero follow-up render from the 32ms nudge reset; the panel also had a 240ms transform transition. Page switch samples were roughly 7–18ms per primary React commit, with additional initialization work on first Visualize use. This is development-render work, not an FPS or production-latency measurement.

1. Add failing tests for setup-gated startup, prompt completion/reduced motion and cleanup; add visibility/reduced-motion coverage for the home demo.
2. Remove the 5px terminal tab nudge and its timer/state/CSS; retain immediate selection, focus, preserved mounted monitors and display activation.
3. Dismiss startup after settings/session recovery finishes, using a 140ms exit (immediate for reduced motion). Allow a one-second escape from the splash if setup stalls, preserving the independent native recovery guard. Shorten the associated entrance; keep progress indeterminate while setup is pending.
4. Pause the welcome demo outside a visible document and for reduced motion. Keep its existing bounded update rate when active.
5. Repeat the same populated-terminal sample, inspect actual navigation and motion states, run frontend/build checks, request independent review, push and verify exact-commit CI.

Do not change sidebar/chart internals based on suspected cost alone. The current browser host cannot support a reliable physical-device frame-rate claim; record those limits alongside before/after render evidence.
