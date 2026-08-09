<p align="center">
  <img src="src/assets/signaldeck-mark.png" width="220" alt="BaudTide logo" />
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

- Discover Linux serial ports, including `/dev/ttyUSB*`, `/dev/ttyACM*`, Bluetooth, and PCI serial devices, with visibility-aware automatic hot-plug scans.
- Monitor multiple distinct ports concurrently in tabs or a responsive tiled workspace.
- Set common baud rates, send text with a per-session line ending or exact hexadecimal bytes, retain bounded mode-specific command history through frontend reloads, pause rendering without pausing capture, filter noisy output, and jump straight to the latest data.
- Write every received byte to a raw local log from the moment monitoring begins.
- Browse saved captures, filter them by lifecycle state, sort them deterministically, preview them, copy their contents, save a copy with the native file chooser, reopen their saved serial setup for review before explicitly starting it, or safely delete captures that are no longer active.
- Recover native terminal tabs after a frontend reload without reopening their serial ports.
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

## View active sessions on a phone

BaudTide can share one live terminal with a phone on the same local network.
Open the terminal's **Mobile sharing** panel, choose **Create mobile link**, and
scan the displayed QR code from the phone. The phone view starts
with a bounded recent tail, continues with live output, reconnects from its
last event sequence after a brief network interruption, and lets the paired
device download the active raw capture. Search, pause/resume, auto-follow, and
high-signal Error/Wi-Fi filters operate on the retained mobile tail. Every link
starts **read-only**.

The desktop operator may deliberately choose **Enable remote control** for an
active link. While that permission is enabled, the phone can send either UTF-8
text or exact hexadecimal bytes to that selected serial session. Mobile writes
are authenticated with the current pairing capability, limited to 4 KiB per
write, and rate-limited to 10 writes / 16 KiB per second. Text is sent exactly
as entered; no line ending is added. Disable control to return the link to
read-only, or revoke the link to invalidate the pairing capability entirely.

The companion remains an IPv4 local-network HTTP/WebSocket service protected by
an unguessable bearer token in the pairing URL. It is not encrypted, so anyone
who can observe or obtain the URL can use the capability while it is valid;
only use it on a trusted LAN and do not treat it as an internet-facing service.
The control permission applies to every write request, but an in-flight write
may finish if it races with a disable/revoke action. The feature exposes no
arbitrary file, shell, or system actions.

BaudTide can create one read-only mobile dashboard for all native serial
sessions that are active when the link is created. Open **Live terminal**, use
the **Mobile workspace** panel, and scan its QR code from a phone on the same
local network. The phone can switch between the included session names and
ports while receiving their live, session-tagged output. It cannot send data,
control a serial device, or browse arbitrary files.

Each workspace dashboard gets a new unguessable bearer URL. Its session scope
is a snapshot: later terminals and reconnects are not added automatically.
Included sessions remain visible when they disconnect or hit an `error` or
`storage-limit` state, so the phone can explain why a stream stopped. Revoke
the workspace link to close it immediately; it also ends when BaudTide exits.
The dashboard accepts at most 32 scoped sessions and 8 simultaneous viewers,
with bounded per-viewer event queues and phone-side output buffers.

The per-terminal **Mobile companion** panel and `/share/<token>` URL remain
available for backward compatibility. Those links show one session and retain
the existing active-capture download behavior. Only use either feature on a
network you trust: the listener is IPv4 local-network-only and the URL token is
the sole phone authentication credential.

## Native serial backend

When launched through Tauri, BaudTide can:

- discover local serial ports
- open several distinct ports at once with independent reader threads
- emit session-tagged serial data and connection-status events to the UI
- reattach the frontend to native sessions that survive a WebView reload
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
