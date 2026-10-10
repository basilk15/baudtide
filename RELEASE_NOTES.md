# BaudTide 0.5.0

## Delivered

- Connection setup: scanning preserves manual paths and selected devices, and
  ignores results from closed dialogs or superseded scans.
- Live storage recovery: warnings at 80% and 95%, access to logs/settings, and
  an explicit reconnect action after resolving storage exhaustion. No captures
  are automatically removed.
- Command presets: locally saved text/hex payloads with line endings, included
  in saved bench setups. Repeat sending uses a fixed payload and serialized
  writes; explicit Stop, hiding the terminal, disconnects, reloads, and failures
  stop future writes. Restoring a setup never starts repeat sending.

- Reliability: full captures are indexed in chunks with recorded receive timing,
  cached analysis, saved analysis workspaces, safer device identity reconnects,
  and streamed CSV/JSON exports. Exports publish atomically and protect managed
  app data and raw captures, including paths through directory symlinks.
  Overviews preserve capture order within receive bursts. Renderer reloads and
  crashes release native analysis readers, including opens still in progress.
- Bench setups: save connections, serial framing, display settings, decoder
  profiles, terminal layout, and an optional saved analysis. Restore previews
  missing or ambiguous devices, allows explicit port selection, reuses open
  terminals, and reports individual failures without dropping successful ones.
  Existing layout-only workspaces remain supported.
  Saved setups retain the terminal's current send line ending, including a
  selection recovered after a renderer reload, without changing app defaults.
- Watches: optional sustained conditions, recovery margins, and stale-reading
  status reduce noisy triggers. History survives renderer restarts, retains
  source and capture context, and exports all saved events while monitoring
  continues. Storage failures are visible and exports use a consistent snapshot.

- Display performance: immutable readings and plot metadata are reused, terminal
  rows render in stable groups, charts survive screen navigation, and resize
  notifications are coalesced into animation frames. Hidden/minimized renderers
  suspend display work while capture, telemetry ingestion, and watches continue.
  Command repetition and replay keep their existing control rules. Data retention,
  chart point limits, rendering quality, and export content are unchanged.

## Validation

- `npm run check`: Rust formatting, Clippy with warnings denied, TypeScript,
  and production build passed.
- `npm test`: 136 frontend/Electron tests and 88 Rust tests passed. Coverage includes
  bench restoration conflicts, reviewed USB identity selection, watch timing,
  history persistence, export cancellation, interrupted exports, and PTY sessions.
  New regressions cover same-chunk reading order, equal-time extrema across disk
  pages, reader slot recovery, late opens/reads, overlapping reloads, and failed
  reader-close retries.
  Saved-analysis regressions cover removed captures staying removed, unavailable
  sources staying saved, re-added captures, and signal selections surviving a
  quiet device. Export regressions cover stale save dialogs during renderer
  cleanup, including the legacy export path, without leaking stream slots.
  Final-publication regressions cover cleanup during destination validation,
  finalization queued before or after cleanup starts, and completed exports.
  Review-fix regressions cover serialless adapters with model-only aliases,
  colliding aliases, fresh capture scans before linked-analysis restoration,
  superseded requests, failed-scan retry, and late restore completions.
- Desktop flow tested against the real native backend using an isolated PTY:
  connection, sustained watch trigger, saved bench and linked analysis,
  disconnect/restore, renderer reload, and persisted history CSV export.
  Follow-up checks verified CRLF save/restore and exact transmitted CRLF bytes,
  then abandoned four analysis readers on each of six renderer reloads. Capture
  analysis remained available and the same live serial session kept recording.
  A newly recorded capture opened on the first Logs → Visualize click after a
  previous visit. Opening another capture retained selected signals, and normal
  CSV export included all 327 selected readings from the new capture.
- A 25,428-record capture was finalized, indexed with recorded timing, and
  exported. All 25,428 selected recorded temperature readings were present.
- AppImage, DEB, and RPM generated under `release/0.5.0-validation/`; package
  metadata reports 0.5.0. Packaged Electron and native backend launched with
  isolated data/config directories. The local launch check used `--no-sandbox`
  for this host only; production launch configuration was unchanged.
  These packages precede the review fixes above and must be rebuilt before
  distributing the corrected version.

Additional bench-tools validation passed against an isolated native PTY:
manual path/name survived rescanning; repeat writes contained exact CRLF bytes;
Stop and navigation halted further writes; presets survived reload and setup
restore without automatic sends. A sparse capture fixture exercised the 85%
warning, storage-limit stop, disabled retry above the cap, and successful
reconnection after increasing the limit. Light/dark controls were inspected.

Display-performance QA used an isolated native PTY with 10,000 retained readings,
three signals, and 500 terminal rows in the same development browser. Click-to-two-
frames timing for repeated terminal/Visualize switches fell from approximately
1.0–2.0 seconds to 130–260 ms. The same chart instance survived navigation.
A 100-update snapshot benchmark dropped from 1,071 ms to 7.3 ms while retaining
all readings and identical latest values. These are local development measurements,
not a production frame-rate guarantee. Regression tests cover immutable snapshots,
ring ordering, plot cache invalidation, burst extrema/replay boundaries, stable
terminal groups, and canceled/coalesced resize frames. Manual checks covered
filter highlights, pause/resume, exact transmitted LF bytes, overlay/separate
plots, and themes. Temporary profiling code was moved outside the app.
Native window-manager minimize/restore timing still needs a desktop manual check;
the automated/browser checks exercise display scheduling and screen navigation.

## Remaining checks

Physical USB unplug/replug and ambiguous identical adapters still need a hardware
check. Their selection and retry rules have automated native coverage. No ESP32
firmware was compiled or uploaded. Existing captures and preferences were not
used for desktop smoke testing; test artifacts are retained in temporary folders.

The production build retains the existing Vite bundle-size warning. No remote
release was published.
