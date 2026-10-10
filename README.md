<p align="center">
  <img src="src/assets/signaldeck-mark.png" width="160" alt="BaudTide logo" />
</p>

<h1 align="center">BaudTide</h1>

<p align="center">
  Your serial bench, in one place.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1f6f61?style=flat-square" alt="Linux" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1f6f61?style=flat-square" alt="MIT license" /></a>
</p>

BaudTide is an open-source Linux desktop serial monitor for ESP32, Arduino, and other serial devices. Connect multiple boards, turn serial output into charts, and save your setup for the next debugging session.

## Made for the bench

- **Multiple devices, one workspace.** Discover ports and monitor boards in tabs or side-by-side terminals. Send text or hex, save command presets, and repeat commands with an explicit Stop control.
- **Signals from serial output.** Plot JSON, key/value, CSV, and TSV telemetry. Map custom numeric columns with reusable decoder profiles.
- **Capture now, investigate later.** Keep searchable raw logs locally, replay recordings, inspect time ranges, and export selected telemetry to CSV or JSON.
- **Watches for long runs.** Set signal boundaries, sustained conditions, and recovery margins. Keep breach history across restarts and export it when needed.
- **A setup worth saving.** Restore reviewed device connections, terminal layouts, decoders, and saved analyses. Identified USB devices can reconnect across port-name changes; ambiguous devices require review.
- **Your bench on your phone.** Scan a QR code to view output on a trusted local network. Sharing is read-only by default; remote control is opt-in.

Dark, Light, and Sage themes let you choose the workspace that suits your bench.

## Download

Get the **AppImage, DEB, or RPM** for Linux x86_64 from the [latest release](https://github.com/basilk15/baudtide/releases/latest).

On Ubuntu/Debian, serial-device access may require membership in the `dialout` group and a new login.

## Development

Requires **Node.js 22.12+**, **Rust**, and **`libudev-dev`** on Ubuntu/Debian.

```bash
git clone https://github.com/basilk15/baudtide.git
cd baudtide
npm ci
npm run electron
```

The launcher builds the native backend and starts the desktop app. `npm run dev` opens a browser preview without native serial access.

| Task | Command |
| --- | --- |
| Formatting, linting, and production build | `npm run check` |
| Frontend and native tests | `npm test` |
| Production dependency audit | `npm run audit:prod` |
| Linux release packages in `release/` | `npm run desktop:dist -- --publish never` |
| Simulated serial device | `python3 scripts/test-monitor.py` |

For the simulated device, enter the printed `/dev/pts/N` path in BaudTide and use 115200 baud.

Built with **Electron, React, TypeScript, and Rust**. [Release notes](RELEASE_NOTES.md) · [MIT license](LICENSE).
