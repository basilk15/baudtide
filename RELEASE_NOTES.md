# Unreleased

- Zoom telemetry charts with the mouse wheel over a plot, keep the range navigator synchronized, and double-click to reset the view.
- Choose baseline and candidate captures directly from the saved library; selected captures open automatically with loading and retry guidance. Preserve both interval bounds when editing a new range.
- Give the empty terminal workspace a centered, readable connection prompt and a direct Connect a device action across themes and screen sizes.
- Inspect watch breaches directly from history or the event timeline, with configurable seconds before and after the event.
- Show breach and manual-note markers on telemetry charts in both elapsed and clock alignment.
- Read original serial output around an event, including nonnumeric lines, with bounded display, cancellation, and explicit approximate-timing labels for legacy captures.
- Save titled, timestamped markers and notes locally with a capture; notes remain available when the capture is reopened.
- Save per-device log event rules with plain-text matching, case sensitivity, cooldowns, and optional desktop alerts. Rules run independently of terminal visibility; events and notification links open capture context.
- Compare baseline and candidate captures with independently selected alignment events, signed relative intervals, compatible signal units, exact full-history statistics, and an original-unit overlay. Save comparison settings in analysis workspaces and export summaries to CSV.
- Save and run ordered text/hex command sequences with response checks, timeouts, and per-step delays. Runs stop on errors, disconnect, or hiding the terminal, and record their timestamped results with the capture. Saved sequences are included in bench setups and never start automatically.

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
