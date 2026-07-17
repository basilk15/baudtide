# SignalDeck

SignalDeck is a Linux-first desktop serial-monitor workspace. The current milestone is an interactive UI prototype with mocked serial devices; native port discovery, streaming, and logging come next.

## Run the UI

```bash
npm install
npm run dev
```

To run it in the Tauri desktop shell once Linux desktop dependencies are available:

```bash
npm run tauri dev
```

## Current UI

- Dark-first workspace dashboard
- Recent serial-device cards and saved workspace previews
- Responsive layout
- Connection setup dialog with port, baud rate, and session-name controls
- Mock scan and connect interactions
