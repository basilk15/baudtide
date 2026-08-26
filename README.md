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
- Send text or hexadecimal data and keep connection settings separate for each device.
- Pause or filter noisy output without losing the raw log.
- Save named terminal layouts and return to them later.
- Keep logs on your computer; browse, search, preview, export, or delete them when needed.
- Share live output with a phone by scanning a QR code; remote control stays off unless you enable it.
- Send a raw mobile log through the phone's native share sheet when the browser supports file sharing, with download and excerpt-sharing fallbacks.
- Choose a dark or light workspace.

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
non-numeric text still need a device-specific decoder.

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

Create Linux AppImage and Debian packages under `release/` with:

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
