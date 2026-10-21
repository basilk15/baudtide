# Repository guide

## Source organization

`src/App.tsx` coordinates the app and `src/main.tsx` loads the global styles. Keep global stylesheet imports in their existing order: the theme and workbench layers intentionally override earlier styles.

Components live under `src/components/`, grouped by the workflow they serve:

| Folder | Responsibility |
| --- | --- |
| `app/` | Startup, navigation, home, command palette, notifications, and help |
| `connection/` | Device discovery and connection configuration |
| `terminal/` | Serial monitor, command presets/sequences, and log rules |
| `telemetry/` | Analysis, replay, comparison, event context, decoders, and charts |
| `captures/` | Saved capture library and storage warnings |
| `mobile/` | Mobile sharing controls and companion preview |
| `preferences/` | Application preferences screen |
| `workspaces/` | Saved terminal layouts and bench setup restoration |
| `ui/` | Reusable controls and chart primitives |

Keep feature styles beside their components. Shared bench controls and global themes belong in `src/styles/`; the canonical design tokens are in `src/styles/tokens.css`. See [Design system](design.md) and [Product principles](../PRODUCT.md).

`src/lib/` contains domain logic grouped into `captures/`, `serial/`, `telemetry/`, `preferences/`, and `workspaces/`. The desktop bridge, frame scheduler, and GitHub integration remain shared utilities at the library root. Shared React hooks live in `src/hooks/`.

Tests remain beside the source they exercise, including renderer integration tests, Electron service tests, and Rust unit/PTY tests. Moving tests into a separate tree would make the relationship harder to follow.

`electron/` owns the desktop bridge and background services. `src-native/` owns the Rust serial backend and its embedded mobile companion JS/CSS. `build/icons/` contains packaging inputs and must stay versioned.

## Scripts and checks

Run commands from the repository root:

| Command | Purpose |
| --- | --- |
| `npm run electron` | Build the backend and launch the development desktop app |
| `npm run dev` | Browser preview without native serial access |
| `npm test` | Frontend, Electron-service, and Rust regression tests |
| `npm run check` | Formatting, Clippy, type checking, and production build |
| `npm run test:telemetry` | Focused parser, chart, fixture, and decoder checks |
| `npm run simulate:serial -- 2` | PTY simulator emitting anonymous numeric columns |
| `npm run simulate:formats -- --help` | Options for the supported-format simulator |

Desktop startup helpers are in `scripts/desktop/`, Python device simulators in `scripts/fixtures/`, and smoke checks in `scripts/testing/`. The shared worker build remains `scripts/build-watch-runtime.mjs`; it bundles `src/lib/telemetry/desktopWatchRuntime.ts` for the Electron worker.

For a browser connected to the real backend with isolated test data, run `npm run dev` in one terminal and `npm run smoke:desktop` in another. Open `http://localhost:1421`, then connect to the PTY path printed by the smoke server. To exercise watch persistence without a renderer, run `npm run smoke:watches` against that server. Stop the test server with Ctrl-C; its fixture data is retained in the temporary directory printed at startup. These checks do not compile or upload ESP32 firmware.

## Tracked inputs and local output

Track source code, tests, build configuration, documentation, icons, and both dependency lockfiles. New source files should appear in `git status` without force-adding them.

The root `.gitignore` excludes these generated or machine-local files:

- `node_modules/`, `dist/`, `release/`, native `target/` directories, and the generated `electron/watch-runtime/` bundle.
- `.cache/`, TypeScript build metadata, Python bytecode, and legacy emitted Vite configuration files.
- `output/`, browser automation state, coverage, test results, and Playwright reports.
- Local design-tool reports/attachment state in `.hallmark/`, `.impeccable/`, and `.kanna/`.
- Local environment files, package-manager diagnostics, and editor/OS temporary files. `.env.example` and `.env.*.example` remain shareable.

TypeScript emits configuration output and incremental metadata under `.cache/typescript/`. Existing root-level generated copies were retained under `.cache/typescript/legacy/` during repository organization. The old `src-tauri/target/` directory, if present locally, is an ignored historical build cache; the current application uses Electron and `src-native/`.

Ignore rules deliberately do not hide all JSON, CSV, log, image, or database files: future fixtures and intentional assets should remain visible for review. Keep ad hoc screenshots, captures, exports, and review artifacts under `output/`.
