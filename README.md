<p align="center">
  <img src="src-tauri/icons/icon.svg" width="128" alt="BaudTide logo" />
</p>

<h1 align="center">BaudTide</h1>

<p align="center">
  BaudTide is a Linux desktop serial monitor for ESP32, Arduino, USB/TTY devices, and multi-port serial logging.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1f6f61?style=flat-square" alt="Linux" />
  <img src="https://img.shields.io/badge/runtime-Tauri%20%2B%20React-1f6f61?style=flat-square" alt="Tauri and React" />
  <img src="https://img.shields.io/badge/status-active%20development-5ac8ae?style=flat-square" alt="Active development" />
</p>

BaudTide is an open-source Linux serial monitor and serial terminal. It replaces the clipped, single-device serial-monitor experience with a calm local workspace: discover USB and TTY ports, open several live terminals in tabs, retain complete raw captures, and export a log whenever you need it. It is useful for ESP32 and Arduino development, embedded debugging, UART/USB serial communication, and monitoring serial data streams.

## Highlights

- Discover Linux serial ports, including `/dev/ttyUSB*`, `/dev/ttyACM*`, Bluetooth, and PCI serial devices.
- Monitor multiple distinct ports concurrently, each with its own reader and live terminal.
- Set common baud rates, send data back to the device, pause rendering without pausing capture, and jump straight to the latest output.
- Write every received byte to a raw local log from the moment monitoring begins.
- Browse saved captures, preview them, copy their contents, or save a copy with the native file chooser.
- Choose a polished dark or light workspace theme.

## Run locally

Install dependencies and start the browser preview:

```bash
npm install
npm run dev
```

Run the complete desktop app with native serial-port access:

```bash
npm run tauri dev
```

## View a live capture on a phone

BaudTide can share one live terminal with a phone on the same local network.
Open the terminal's **Mobile sharing** panel, choose **Start sharing**, and scan
the displayed QR code from the phone. The phone view is read-only: it shows the
live output and lets the paired device download the active raw capture. It
cannot send data to the serial device.

Each share gets a new unguessable pairing URL. Stop sharing to immediately
revoke it; sharing also stops automatically when its serial session disconnects
or BaudTide exits. Only use the feature on a network you trust.

## Native serial backend

When launched through Tauri, BaudTide can:

- discover local serial ports
- open several distinct ports at once with independent reader threads
- emit session-tagged serial data and connection-status events to the UI
- send text or raw bytes to an open session
- write received bytes directly to a raw log file, independent of display pause or scrollback
- disconnect one live terminal without affecting the others

Each session accepts an optional absolute `logPath`. When one is not supplied, BaudTide saves the raw capture beneath its Linux app-data `logs/` directory. The Saved logs page makes those files easy to browse and export.

Existing captures from the previous SignalDeck-branded build remain available in Saved logs; they are kept in place while new captures are written under the BaudTide identity.

## Linux prerequisites

BaudTide needs the normal GTK/WebKit development libraries for the Tauri desktop shell. On Ubuntu/Debian, serial-port discovery also requires `libudev-dev`.

If `npm run tauri dev` reports missing `glib`, `gio`, `gdk`, `webkit`, or `libudev` packages, install the matching development package and run it again. Your user account may also need to be in the `dialout` group to access USB serial devices.

## Stack

- Tauri v2 desktop shell
- Rust + `serialport` for native Linux serial access
- React + TypeScript + Vite UI
- Local file-based raw capture library

## Search terms

**BaudTide / Baud Tide** is a Linux serial monitor, UART terminal, USB serial terminal, and multi-port serial logger for ESP32, Arduino, and embedded-device development.
