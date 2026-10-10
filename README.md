<p align="center">
  <img src="src/assets/signaldeck-mark.png" width="220" alt="BaudTide logo" />
</p>

<h1 align="center">BaudTide</h1>

<p align="center">
  A calm Linux desktop serial monitor for ESP32, Arduino, and USB/TTY devices.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1f6f61?style=flat-square" alt="Linux" />
  <img src="https://img.shields.io/badge/runtime-Electron%20%2B%20React-1f6f61?style=flat-square" alt="Electron and React" />
  <img src="https://img.shields.io/badge/status-active%20development-5ac8ae?style=flat-square" alt="Active development" />
</p>

BaudTide is an open-source serial terminal and monitor built for embedded development. Discover local ports, work with several devices at once, capture every received byte locally, and export logs when you need them.

## Current features

- Find available serial ports automatically, or enter a port path yourself.
- Open several devices at once in tabs or side-by-side terminal views.
- Detect structured telemetry from live serial output and visualize selected sessions.
- Define reusable custom line decoder profiles for delimiter-separated numeric telemetry.
- Keep armed signal watches and loaded comparisons while navigating between pages.
- Evaluate watches before chart history is overwritten, with waiting/stale/disconnected status and reconnect gaps in plots.
- Analyze complete captures in chunks, inspect any capture time range, and stream every selected record to CSV or JSON.
- Save analysis workspaces with signals, decoder assignments, boundaries, capture ranges, and chart settings; identified devices keep their assignments across port changes.
- Reconnect identified USB devices even when their Linux port name changes; ambiguous devices require a device check.
- Send text or hexadecimal data and keep connection settings separate for each device.
- Save named text/hex commands with their line ending, include them in bench setups, and repeat a fixed command with an explicit Stop control.
- See capture-storage warnings in the live workspace before the quota is reached, then reconnect stopped terminals after raising the limit or reviewing logs.
- Pause or filter noisy output without losing the raw log.
- Save named terminal layouts and return to them later.
- Restore a full bench setup after reviewing devices: connections, serial and display settings, decoder assignments, layout, and a linked saved analysis.
- Tune watches with sustained breach durations, recovery margins, and stale timeouts; keep breach history across restarts and export all saved events.
- Keep logs on your computer; browse, search, preview, export, or delete them when needed.
- Share live output with a phone by scanning a QR code; remote control stays off unless you enable it.
- Send a raw mobile log through the phone's native share sheet when the browser supports file sharing, with download and excerpt-sharing fallbacks.
- Choose a Dark, Light, or muted Sage workspace in Preferences.

### Telemetry input formats

The Visualize screen keeps the raw serial stream unchanged, then detects repeated
numeric records from these common shapes:

- JSON objects, including nested objects, numeric strings, values with units,
  `{ "value": ..., "unit": ... }` measurements, text prefixes, and JSON arrays
  or `data`/`readings` batches.
- Key/value lines such as `temperature=20.9 C humidity:43.0 %`, with `=`, `:`,
  comma, semicolon, pipe, or whitespace separators.
- Header-based CSV and TSV, including units in headers such as `temp (°C)` or
  `pressure [hPa]`.

BaudTide waits for two records with the same field schema before plotting, so
ordinary diagnostic lines containing an isolated number do not become signals.
Delimiter-free numeric columns without a header, binary packets, and arbitrary
non-numeric text still need a device-specific decoder. For delimiter-separated
numeric lines, open **Visualize → Decoder** to map columns to named signals,
optionally match a literal line prefix, and save the profile locally for reuse.
The decoder only changes the analysis view; terminal output and raw captures
remain unchanged.

New captures store receive timestamps and byte offsets in a compact `.log.timing`
companion file. Replay and telemetry exports use those recorded receive times,
preserving pauses and bursts at the serial-read level. Raw `.log` files, previews,
raw exports, and mobile downloads still contain only the original device bytes.
Older captures, or captures with unavailable/incomplete timing, continue to open
with an explicit **Approximate timing** label. Timing files count toward the
capture storage limit and are removed by the existing confirmed **Delete log**
action together with their raw capture.

The analysis screen indexes the complete capture into a derived local disk cache,
then displays a bounded overview that preserves selected-signal minima and maxima.
**Capture range** selects elapsed seconds anywhere in the capture; **Full capture**
restores the complete range. CSV and JSON exports stream all selected values in
that range (and respect replay position and the chart time window), including
records omitted from the overview. Loading and export can be cancelled. Export
publishes a completed temporary file atomically, preserving the previous
destination if cancelled or interrupted. The derived analysis cache requires
free disk space and is rebuilt after restarting the renderer; raw logs and
capture quotas remain separate.

Use **Saved analysis → Save as…** to retain an investigation, or **Update saved
analysis** to update it. The last selected saved analysis restores on startup.
Saved watches observe future readings; existing history does not trigger an
alert. Missing devices stay disconnected and ambiguous matches remain unassigned.
Devices without a unique USB identity use their manually selected port and serial
settings. Existing terminal layouts remain readable through their legacy port
identities. A watch shows **Stale** after its configured timeout (ten seconds by default) without a matching reading;
disconnecting or changing a decoder re-arms it for the next stream.

USB reconnect uses the adapter's vendor/product IDs, serial number, and a stable
`/dev/serial/by-id` alias when available. A reused `ttyUSB`/`ttyACM` name is not
enough to select a known device. If multiple ports match, or an adapter has no
unique identity, automatic retries pause and connection setup remains available.
An adapter without a serial number requires review even if Linux provides a
`/dev/serial/by-id` alias; a model-only alias can move to an identical adapter.
Manual reconnect still works for an unidentified adapter at its original port
after checking its USB model. Manually entered non-USB ports and PTYs keep their
existing path-based reconnect behavior.

### Restoring a bench setup

**Live terminal → Save workspace** saves connection settings, display settings,
and decoder profiles as well as the layout. Choose a saved analysis in the save
form to associate its signals, watches, chart settings, and capture ranges.
Selecting a saved workspace continues to apply only its layout. **Restore setup**
opens a device review: identified devices follow their current port, existing open
terminals keep their settings, and missing devices are skipped. Duplicate or
unidentified USB adapters and manually entered PTYs require an explicit port
selection. The backend rechecks a reviewed USB identity at connection time.
Successful devices stay open if another device fails; per-device errors are shown.

Legacy layouts remain readable. Open their terminals and use **Update setup** to
retain the existing saved ID while adding connection details. Restore does not
start on app launch; only the associated saved analysis restores automatically.

### Command presets and repeat sending

Below the terminal composer, open **Command presets**, enter a name, and use
**Save current command**. Selecting a preset loads its payload, text/hex mode,
and line ending; press **Send** to transmit it. Presets follow the terminal's
stable device/settings identity and survive renderer reloads. Saving or updating
a bench setup includes its command presets. Restoring a setup restores presets
for newly opened/reconnected terminals; already open terminals keep their presets.
No command is sent automatically during restore.

**Start repeating** sends the current fixed command immediately and repeats after
each completed write and the chosen delay (0.1–3,600 seconds). **Stop repeating**
and **Stop command repeat** cancel future writes; a write already submitted to the
backend can finish. Disconnecting, hiding the terminal (including switching tabs
or pages), reloading, or a send failure stops the loop. Changing the composer does
not alter a running loop. Repeat execution is never saved or automatically resumed.

Capture storage is checked every five seconds. The live workspace warns at 80%
and marks usage critical at 95%; notifications remain available while on another
page. At the configured hard cap, capture, monitoring, and watches stop as before.
Use **Storage settings** to raise the limit or **Review saved logs** to inspect
captures; deletion still requires confirmation. **Reconnect stopped terminals**
becomes available after usage falls below the cap. Existing captures are preserved.

### Watches during long runs

Open **Signal watch → Timing and recovery** before adding a watch. Defaults stay
immediate with no recovery margin and a ten-second stale timeout. A sustained
breach requires continuing matching readings across the chosen duration; silence,
stale gaps, reconnects, and decoder changes break that evidence. A recovery margin
(hysteresis) requires a high-limit watch to drop to the limit minus the margin,
a low-limit watch to rise to the limit plus the margin, or a range watch to return
that far inside both limits before re-arming. Zero margin preserves the previous
boundary behavior. The form accepts seconds to millisecond precision.

The newest 100 breaches are displayed; all successfully saved breaches remain in
a separate local IndexedDB journal in Electron's user-data directory. Each stores
its receive time, source/device identity, capture path when available, value,
boundary, and watch options. **Export saved history** streams a fixed snapshot to
CSV or JSON while watches continue. History remains accessible from Visualize
without an active device. Disk/write failures are visible and never stop serial
capture. This journal is separate from raw-capture quotas and is not cleared with
the derived analysis cache. Development browser history and packaged-app history
use their own origins.

## Quick start

```bash
npm install
npm run electron
```

The Electron development command builds the Rust sidecar, starts Vite on
`127.0.0.1:1420`, and opens the desktop window. Node.js 22.12 or newer and a
Rust toolchain compatible with Rust 1.77.2 are required.

Some Linux development hosts restrict Chromium user namespaces and require a
properly installed setuid sandbox helper. Configure that sandbox for normal
development. For a temporary local test only, Electron's documented fallback
can be passed explicitly:

```bash
npm run electron -- --no-sandbox
```

Never use `--no-sandbox` for a production launch.

For a browser-only UI preview without native serial access:

```bash
npm run dev
```

## Test monitor

Generate repeatable JSON telemetry without connecting physical hardware:

```bash
python3 scripts/test-monitor.py
```

Copy the printed `/dev/pts/N` path into the connection dialog and use 115200
baud. The helper also prints bytes sent back from BaudTide. If the installed
`baudtide-demo-data` command is available, it can be used in the same way.

For anonymous numeric columns that require a custom decoder profile, run mode
2 instead:

```bash
python3 scripts/test-monitor.py 2
```

It streams comma-separated temperature, humidity, voltage, RPM, and tick
values with no prefix or header. In **Visualize → Decoder**, choose **Comma**
and map columns 1–5 to those signals.

To exercise every supported telemetry shape through a virtual serial port:

```
python3 scripts/test-telemetry-formats.py --format all
```

Use `--format json-prefixed`, `--format json-measurements`, `--format csv-header`,
or any other format listed by `--help` to check one shape at a time. Connect the
printed PTY path, open **Visualize**, and confirm the detected fields and traces.

Run the automated checks with:

```bash
npm run check
npm test
```

For a repeatable desktop flow check against the real Rust backend, keep
`npm run dev` running in one terminal and start `npm run smoke:desktop` in another.
Open the printed loopback URL. This development-only bridge creates its own PTY
and temporary app-data directory; connections are restricted to that PTY and
log deletion is disabled. The original captures and preferences are untouched.
Test artifacts are retained in the printed directory when the server stops.

Create Linux AppImage, Debian, and RPM packages under `release/` with:

```bash
npm run desktop:dist
```

## Mobile sharing

Share an active terminal—or a read-only snapshot of multiple terminals—with a phone on the same local network. Create a link from the relevant **Mobile sharing** panel and scan its QR code. When repeated numeric telemetry is detected, the phone shows a **Signal canvas** with selectable traces, latest readings, bounded history, and pause/resume controls; raw output remains available below it. On the live terminal page, **Send logs** shares the raw capture through the iOS Share Sheet or Android Sharesheet when available; otherwise it keeps the existing download path (or shares the visible excerpt when only text sharing is supported).

Links are read-only by default. Remote control is an explicit opt-in for one active terminal; it can send text or hexadecimal bytes, is rate-limited, and can be disabled or revoked at any time.

> **Security:** mobile links are bearer URLs on your local IPv4 network. They are not encrypted, so only use them on a trusted LAN and revoke them when finished.

## Linux requirements

Install `libudev-dev` on Ubuntu/Debian before compiling the Rust serial
backend. If access to a USB serial device is denied, add your user to the
`dialout` group and sign in again.

## Desktop architecture

Electron's sandboxed renderer receives a narrow, allowlisted API from the
preload script. The Electron main process owns windows, menus, native dialogs,
and application lifecycle. It starts `baudtide-backend` and exchanges
newline-delimited JSON requests, responses, and serial events over private
standard-I/O pipes.

The native sidecar in `src-native` owns serial sessions, log indexing and
search, capture quotas, mobile sharing, validation, and PTY coverage. On Linux
it continues to use `$XDG_DATA_HOME/com.basil.baudtide`, or
`~/.local/share/com.basil.baudtide`, preserving existing preferences and saved
captures.

## Stack

- Electron desktop shell with a context-isolated, sandboxed renderer
- Rust NDJSON sidecar using the shared native backend
- Rust + `serialport` for native Linux serial access
- React + TypeScript + Vite UI
- Local file-based raw capture library
