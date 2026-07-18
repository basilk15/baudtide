# SignalDeck

SignalDeck is a Linux-first desktop serial-monitor workspace. It has a native Tauri serial backend plus a browser-safe UI preview.

## Run the UI

```bash
npm install
npm run dev
```

To run it in the Tauri desktop shell once Linux desktop dependencies are available:

```bash
npm run tauri dev
```

## Native serial backend

When started through Tauri, SignalDeck can:

- discover Linux serial ports (`/dev/ttyUSB*`, `/dev/ttyACM*`, Bluetooth and PCI serial ports)
- open several distinct ports at once, with an independent reader thread per port
- emit session-tagged serial data and connection-status events to the UI
- send text or raw bytes back to an open session
- write every received byte directly to a raw log file, independent of display pause or scrollback
- disconnect a single session without affecting the others

Each session accepts an optional absolute `logPath`. When omitted, its raw log is stored in SignalDeck's Linux app-data directory under `logs/`.

The desktop runtime needs the standard GTK/WebKit Linux development libraries. On Ubuntu/Debian, SignalDeck's serial-port support additionally needs `libudev-dev` for device enumeration. If `npm run tauri dev` reports missing `glib`, `gio`, `gdk`, `webkit`, or `libudev` packages, install the corresponding development package before trying again.

## Current UI

- Dark-first workspace dashboard
- Recent serial-device cards and saved workspace previews
- Responsive layout
- Connection setup dialog with port, baud rate, and session-name controls
- Native discovery, connect, send, receive, and disconnect integration when launched with Tauri
- Browser-preview fallback data when launched only with `npm run dev`
