<p align="center">
  <img src="src/assets/signaldeck-mark.png" width="160" alt="BaudTide logo" />
</p>

<h1 align="center">BaudTide</h1>

<p align="center">
  Serial monitoring and telemetry analysis for embedded development.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1f6f61?style=flat-square" alt="Linux" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1f6f61?style=flat-square" alt="MIT license" /></a>
</p>

BaudTide is an open-source Linux desktop app for monitoring ESP32, Arduino, and other serial devices. Capture serial output, visualize telemetry, and compare bench experiments locally.

## Features

- **Serial monitoring:** port discovery, multiple sessions, tabbed or split terminals, text/hex commands, presets, and repeat sending.
- **Command sequences:** reusable steps with response checks, timeouts, delays, and capture-linked results.
- **Telemetry:** JSON, key/value, CSV, and TSV parsing; custom decoder profiles; overlay or separate charts; time windows and recorded replay.
- **Capture library:** searchable raw logs, favorites, tags, experiment titles and notes, saved filter views, and CSV inventories.
- **Analysis:** timestamped markers, surrounding serial context, baseline/candidate comparisons, event alignment, interval statistics, acceptance checks, and saved results.
- **Alerts:** signal boundaries, sustained conditions, recovery margins, text-match rules, cooldowns, persistent event history, and optional desktop notifications.
- **Export and exchange:** selected telemetry as CSV/JSON, comparison summaries as CSV, and portable capture bundles with receive timing, event notes, and an optional decoder.
- **Saved setups:** restore device settings, terminal layouts, decoders, and analyses; reconnect identified USB devices across port-name changes.
- **LAN sharing:** QR pairing for phone access; read-only by default, with opt-in remote control.
- **Appearance:** Dark, Light, and Sage themes.

Try sample recordings without hardware: **Saved logs → Examples**.

## Download

Linux x86_64: **[AppImage, DEB, and RPM](https://github.com/basilk15/baudtide/releases/latest)**.

On Ubuntu/Debian, serial access may require membership in `dialout` and a new login.

## Data and sharing

Captures stay local. LAN sharing is opt-in. Review serial output and notes before sharing; exports are not automatically redacted.

Tags, favorites, experiment notebooks, and library views stay in the local installation and are excluded from portable bundles. Bundles include capture-event notes; replay timing is approximate when recorded timing is incomplete.

## Development

Requires **Node.js 22.13+**, **Rust** with `rustfmt` and `clippy`, and **`libudev-dev`** on Ubuntu/Debian.

```bash
git clone https://github.com/basilk15/baudtide.git
cd baudtide
npm ci
npm run electron
```

The launcher builds the Rust backend and starts Electron. `npm run dev` provides a browser preview without serial access. Build and upload firmware separately.

| Command | Purpose |
| --- | --- |
| `npm run check` | Formatting, linting, type checking, production build |
| `npm test` | Frontend, Electron-service, and Rust tests |
| `npm run audit:prod` | Production dependency audit |
| `npm run simulate:serial` | Serial simulator; connect to its printed PTY at 115200 baud |
| `npm run desktop:dist -- --publish never` | Build Linux packages in `release/` |

[Repository guide](docs/repository.md) · [Design system](docs/design.md) · [Release notes](RELEASE_NOTES.md)

Built with **Electron, React, TypeScript, and Rust**. Licensed under [MIT](LICENSE).
