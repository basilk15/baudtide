# BaudTide UI feature gap and implementation plan

## Project scope confirmed

BaudTide is intended to be a Linux-first desktop workspace for monitoring one or more serial devices. Its core promise is to connect to a serial port, stream and display every byte, and retain searchable local records. The current app is a React UI prototype: the Tauri backend only starts an empty application shell and has no serial-port, session, storage, or settings commands.

## UI-only implementation update — 17 July 2026

The frontend interactions described across Phases 1–3 now have an intentionally local/mock UI implementation. This includes the accessible connection dialog and monitor preview, dashboard/session/log screens, local-only multi-panel controls, navigation/mobile drawer, Preferences, Command-K, notifications, workspace menu, and Help & feedback.

No native serial, filesystem, account, port-discovery, export, or persistence backend has been added. Every surface that looks like it could change external state is labelled as a preview/mock or explains that it needs the backend.

## Original control audit (before the UI-only implementation)

### Implemented in the prototype

| Control | Current result | Notes |
| --- | --- | --- |
| **New connection** | Opens the connection dialog | Working UI interaction only. |
| **Start monitoring** (hero) | Opens the connection dialog | Working UI interaction only. |
| **Scan for ports** | Shows a spinner and “Scanning ports…” for 900 ms | Dummy scan: it neither queries nor updates ports. |
| **Connect** on each recent device | Prefills and opens the dialog | Working UI interaction only. |
| **Set up a new device** | Opens the connection dialog | Working UI interaction only. |
| Port, baud-rate, and session-name fields | Update local React state | The port list and availability message are hard-coded. |
| Dialog close, Cancel, and backdrop click | Close the dialog | Working. |
| **Start monitoring** (dialog) | Closes dialog and displays a temporary toast | Dummy: it does not open a port, create a session, show a terminal, or persist anything. |

### Present but currently non-functional

| Area | Controls needing behavior |
| --- | --- |
| Sidebar | Collapse sidebar; workspace selector; Dashboard, Sessions, Saved logs, Preferences, and Help & feedback navigation. |
| Top bar | Search / Command-K, notifications, and profile menu. |
| Recent connections | View all and the three per-device overflow menus. |
| Saved workspaces | Workspace overflow menu plus both **Open** actions. |
| Help | “Learn about panel controls.” |

### UI quality gaps

- The active page and breadcrumb are hard-coded to Dashboard / Overview; no routing or page state exists.
- The connection dialog should support Escape to close, initial focus, focus trapping, keyboard navigation, validation, and useful connection-error feedback.
- A scan needs empty, loading, permission-denied, and error states; the present “available and ready” claim must come from real discovery.
- Destructive or consequential actions (disconnect, clear panel, delete log/workspace) need confirmation where appropriate.
- The responsive mobile layout hides the entire sidebar without providing a replacement navigation control.
- Connection, saved-workspace, storage, date, badge, device, and notification values are mock data and should be labelled or replaced before release.

## Backend delivery plan (still outstanding)

### Phase 1 — make a real single-port monitor

1. Add Tauri commands for serial-port listing, opening, reading, writing, closing, and serial-port metadata. Use a native Rust serial library and return structured errors.
2. Replace mock port options with real scan results. Keep manual-port entry for uncommon devices; validate baud rate and prevent a blank session name.
3. On successful connection, create a session view with connection status, port/baud metadata, timestamped output, auto-scroll, pause display, reconnect, disconnect, clear-display, and send-text controls.
4. Keep logging independent of paused display, matching the product’s quick-tip promise. Show explicit connection/error/reconnect state in the UI.
5. Wire New connection, Start monitoring, device Connect, and Scan for ports to this flow. Disable repeat submission while opening a port.

### Phase 2 — usable session management and logs

1. Implement Dashboard, Sessions, and Saved logs pages/routes; turn dashboard cards into real data derived from sessions and storage.
2. Support multiple simultaneous sessions as panels/tabs, with independent pause, filters, encoding, send input, and connection state.
3. Persist session configuration, device history, workspaces, and log files locally. “Recent connections” must come from actual prior connections.
4. Add log search, timestamp/device filters, export (plain text/CSV), and safe log/workspace rename/delete actions.
5. Make Saved workspace **Open**, **View all**, and the overflow menus functional: open, rename, duplicate, remove, and reveal/export where relevant.

### Phase 3 — supporting controls

1. Add sidebar collapse with a compact icon-only mode and a mobile navigation drawer.
2. Build Preferences for default baud rate, line endings, encoding, timestamps, local storage path/limit, theme, and reconnect behavior.
3. Add Command-K search for sessions, devices, logs, and actions. Ship keyboard shortcuts with it (new connection, pause, clear display, find in output).
4. Implement a profile/workspace menu only if the product will support multiple local workspaces or accounts; otherwise remove this affordance for now.
5. Implement notifications for connection loss, device reconnects, storage warnings, and export completion. Keep an unread/read state.
6. Add contextual help/feedback: serial permissions, common Linux device paths, baud-rate guidance, and a way to copy diagnostics.

## Suggested delivery order

| Priority | Outcome | Dashboard controls completed |
| --- | --- | --- |
| P0 | Real scan → configure → connect → live single-port monitor | New connection, both Start monitoring buttons, Scan, all Connect buttons, dialog form and feedback. |
| P1 | Local history, logs, and multi-session workflow | Sessions, Saved logs, View all, workspace Open and device/workspace menus. |
| P2 | Navigation, discoverability, and polish | Sidebar collapse/mobile navigation, Preferences, search, notifications, profile/workspace menu, Help. |

## Acceptance checks for P0

- Scanning shows only ports supplied by the native backend and clearly handles no ports, permission failure, and scan failure.
- Starting a session either opens a live monitor or leaves the dialog open with an actionable error.
- Incoming data remains visible and timestamped; pausing the display does not stop logging.
- Disconnect and reconnect states are obvious, and no duplicate connection can be opened for the same active port without a deliberate user choice.
- A completed session is retained as a recent connection and can be reopened from the dashboard.

## Verification performed

The production frontend build (`npm run build`) completes successfully. This audit is based on the rendered component structure and its React handlers; interactive browser verification could not be completed because an in-app browser was unavailable in this environment.
