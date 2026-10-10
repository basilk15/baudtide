# BaudTide v0.5.0

Changes since v0.4.0.

## Added

- Full-capture analysis and replay with recorded receive timing, selectable ranges, elapsed/clock alignment, playback speeds, and custom chart windows.
- Saved analysis workspaces that retain signal selections, decoders, watches, capture ranges, and chart settings.
- Reusable decoder profiles for delimiter-separated numeric columns, signal names, units, and optional line prefixes.
- Live signal watches with above/below/range boundaries, sustained conditions, recovery margins, and stale-reading status.
- Persistent breach history with device and capture context, exportable to CSV or JSON while watches continue running.
- Bench setup restoration for connections, serial framing, display settings, decoders, terminal layouts, command presets, and linked analyses.
- Saved text/hex command presets and repeat sending with an explicit Stop control and no automatic restart after restoration.
- Mobile telemetry charts with signal selection, latest readings, pause/resume, and raw output on the same shared page.
- A Sage theme alongside Dark and Light, plus refreshed terminal, home, saved-log, and mobile-sharing interfaces.

## Improved

- Faster terminal rendering, chart resizing, and screen switching; hidden windows suspend display work while capture and watches continue.
- Safer USB reconnects across port-name changes, with explicit review for ambiguous identities and adapters without serial numbers.
- Port rescans preserve manual paths and selections, and ignore results from closed dialogs or superseded scans.
- Capture-storage warnings at 80% and 95%, with explicit reconnection after resolving the storage limit.
- Complete selected telemetry exports stream to CSV or JSON, support cancellation, and protect captures and existing destination files from interrupted exports.
- More reliable capture loading and linked-analysis restoration, with reader cleanup across renderer reloads and crashes.

[Full changelog](https://github.com/basilk15/baudtide/compare/v0.4.0...v0.5.0)
