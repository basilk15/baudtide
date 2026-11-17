# Capture workflows review — 2026-11-17

## UI review
Reviewed the running React app in Chromium through the repository's isolated desktop smoke bridge to the real Rust backend. An isolated PTY generated a completed temperature/voltage recording; no physical board was required.

1. Dashboard: healthy hierarchy, obvious connection action, telemetry simulation clearly labeled.
2. Live terminal: healthy empty state, explicit connection action and disabled restore controls.
3. Visualize: healthy source selection, signal rail, chart canvas and event/comparison tools. Existing analysis behavior is covered by the frontend suite.
4. Saved logs: notebook editor, saved views, local metadata filter and CSV review follow the ruled instrument surfaces. Reduced excess toolbar width and verified Dark, Light and Sage at 1440, 760, 390 and 320px; no document horizontal overflow in that matrix.
5. Mobile share: healthy empty state, read-only default and network boundary clearly stated.
6. Preferences: healthy grouped serial defaults, appearance and storage controls.
7. Help and feedback: healthy separation of guidance, diagnostics and feedback; diagnostics explicitly exclude serial payloads.

The new forms have labels, visible focus, explicit cancel/save controls, inline error messages and 44px narrow-screen targets. A regression test reproduces and fixes focus loss when saving a notebook removes its filtered row. Saved view deletion requires inline confirmation and does not delete recordings.

## Code review
An independent read-only reviewer inspected the complete feature diff and ran 20 focused/existing capture tests. One P2 finding (notebook filter focus loss) was reproduced and fixed. Additional coverage checks failed view writes and complete saved-filter restoration. Self-review checked corruption preservation, metadata-only file boundaries, CSV escaping/formula handling and original recording identity.

## Validation
- Repository formatting, Clippy, typecheck and production build.
- Full frontend and native test suites.
- Production dependency audit.
- Native smoke bridge for capture creation, native content search and the new library flow.

## Limits
Screenshots establish visual behavior, not full accessibility certification. Physical ESP32/USB behavior, a screen-reader pass, real phone pairing and packaged Electron native file dialogs were not exercised. The existing Vite large-chunk warning remains; no new runtime dependency was added.
