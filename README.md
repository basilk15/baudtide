<p align="center">
  <img src="src/assets/signaldeck-mark.png" width="220" alt="BaudTide logo" />
</p>

<h1 align="center">BaudTide</h1>

<p align="center">
  A calm Linux desktop serial monitor for ESP32, Arduino, and USB/TTY devices.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1f6f61?style=flat-square" alt="Linux" />
  <img src="https://img.shields.io/badge/runtime-Tauri%20%2B%20React-1f6f61?style=flat-square" alt="Tauri and React" />
  <img src="https://img.shields.io/badge/status-active%20development-5ac8ae?style=flat-square" alt="Active development" />
</p>

BaudTide is an open-source serial terminal and monitor built for embedded development. Discover local ports, work with several devices at once, capture every received byte locally, and export logs when you need them.

## Current features

- Find available serial ports automatically, or enter a port path yourself.
- Open several devices at once in tabs or side-by-side terminal views.
- Send text or hexadecimal data and keep connection settings separate for each device.
- Pause or filter noisy output without losing the raw log.
- Save named terminal layouts and return to them later.
- Keep logs on your computer; browse, search, preview, export, or delete them when needed.
- Share live output with a phone by scanning a QR code; remote control stays off unless you enable it.
- Choose a dark or light workspace.

## Quick start

```bash
npm install
npm run tauri dev
```

For a browser-only UI preview without native serial access:

```bash
npm run dev
```

## Mobile sharing

Share an active terminal—or a read-only snapshot of multiple terminals—with a phone on the same local network. Create a link from the relevant **Mobile sharing** panel and scan its QR code.

Links are read-only by default. Remote control is an explicit opt-in for one active terminal; it can send text or hexadecimal bytes, is rate-limited, and can be disabled or revoked at any time.

> **Security:** mobile links are bearer URLs on your local IPv4 network. They are not encrypted, so only use them on a trusted LAN and revoke them when finished.

## Linux requirements

BaudTide uses the normal Tauri GTK/WebKit development libraries. On Ubuntu/Debian, install `libudev-dev` for serial-port discovery. If access to a USB serial device is denied, add your user to the `dialout` group and sign in again.

## Stack

- Tauri v2 desktop shell
- Rust + `serialport` for native Linux serial access
- React + TypeScript + Vite UI
- Local file-based raw capture library
