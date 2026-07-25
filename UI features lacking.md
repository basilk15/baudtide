# BaudTide feature status

## Current product behavior

BaudTide is a Linux-first Tauri desktop serial monitor. The React interface is backed by Rust commands for serial-port discovery, session lifecycle, raw capture files, preferences, saved-log browsing, preview, search, and export.

### Implemented

| Area | Current behavior |
| --- | --- |
| Port discovery and connection | Lists ports from the native backend, supports a manual path, validates the connection form, and prevents opening an already-active port. |
| Live monitoring | Supports multiple independent native sessions, represented as terminal tabs. Each session has its own reader, output state, send control, pause/display tools, and reconnect/disconnect controls. |
| Capture and saved logs | Writes raw received bytes independently of display pause. Saved captures can be browsed, previewed, content-searched within the documented bounds, copied, and exported with the native file chooser. |
| Preferences | Persists baud defaults, line endings, display encoding, timestamps, reconnect preference, theme, and a log directory through the desktop backend. |
| Serial framing | The connection form configures data bits, parity, stop bits, and software or hardware flow control; reconnects preserve those settings. |
| Saved-log search | Quick search is bounded for responsiveness; users can explicitly select a complete-capture scan when they need exhaustive results. |
| Supporting UI | Navigation, responsive sidebar, command palette actions, notifications, diagnostics copying, and local feedback-draft copying are connected to real local behavior. |

## Deliberate scope limits

- Terminals are selectable tabs, not a split-pane or tiled terminal layout.
- BaudTide has one local application configuration. It does not offer account or workspace switching, and the top-bar Preferences control is intentionally not a workspace selector.
- Feedback stays local: it creates a copyable draft with a diagnostics snapshot rather than submitting data to an unconfigured external service.
- The browser development preview does not have serial access. Run through Tauri for native serial features.

## Remaining engineering work

1. Add integration coverage with pseudo-terminals or hardware for opening, reader failure, unplug/reconnect, writes, capture integrity, and frontend event timing. Current Rust tests focus on deterministic state and search helpers.
2. Consider indexed/cancellable full-text search if very large capture libraries make complete-capture scans too slow.
3. If tiled simultaneous terminal viewing or multi-workspace organization becomes a product requirement, design and implement it explicitly rather than implying it through navigation labels.

## Verification baseline

The project should be checked with:

```bash
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Hardware serial-device checks are still required for release confidence.
