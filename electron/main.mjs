import { TelemetryExportStreams, assertExportDestinationSafe } from './telemetry-export.mjs';
import { CaptureAnalysisReaders } from './capture-analysis.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  shell,
} from 'electron';

const require = createRequire(import.meta.url);
const {
  commands,
  events,
  invokeChannel,
  eventChannelPrefix,
  requestByteLimit,
} = require('./contract.cjs');

const electronDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(electronDirectory, '..');
const allowedCommands = new Set(commands);
const allowedEvents = new Set(events);
const electronOwnedCommands = new Set([
  'select_log_directory',
  'save_saved_log',
  'export_telemetry_data',
  'begin_telemetry_export',
  'append_telemetry_export',
  'finish_telemetry_export',
  'cancel_telemetry_export',
  'toggle_menu_bar',
]);
const APP_ID = 'com.basil.baudtide';
const APP_NAME = 'BaudTide';
const DEVELOPMENT_RESTART_EXIT_CODE = 86;
const APPLICATION_SCHEME = 'baudtide';
const APPLICATION_HOST = 'app';
const PRODUCTION_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'none'; worker-src 'none'";
const WINDOW_ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'icons', 'icon.png')
  : path.join(projectRoot, 'build', 'icons', 'icon.png');

protocol.registerSchemesAsPrivileged([{
  scheme: APPLICATION_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
  },
}]);

function linuxBackendDataPath() {
  const configuredDataHome = process.env.XDG_DATA_HOME;
  const dataHome = configuredDataHome && path.isAbsolute(configuredDataHome)
    ? configuredDataHome
    : path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, APP_ID);
}

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
if (process.platform === 'linux') app.setDesktopName(`${APP_ID}.desktop`);

// Keep Rust captures and preferences in the established Linux app-data path.
// Chromium cookies, cache, and session state remain isolated in Electron's own
// userData directory so they cannot collide with capture metadata.
const backendDataDirectory = process.platform === 'linux'
  ? linuxBackendDataPath()
  : path.join(app.getPath('appData'), APP_ID);

function backendExecutablePath() {
  const executableName = process.platform === 'win32'
    ? 'baudtide-backend.exe'
    : 'baudtide-backend';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', executableName);
  }
  return path.join(projectRoot, 'src-native', 'target', 'debug', executableName);
}

function errorMessage(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return error.message;
  }
  return 'The native backend returned an unknown error.';
}

class BackendProcess {
  constructor({ executable, appDataDirectory, onEvent, onUnexpectedExit }) {
    this.executable = executable;
    this.appDataDirectory = appDataDirectory;
    this.onEvent = onEvent;
    this.onUnexpectedExit = onUnexpectedExit;
    this.child = null;
    this.startPromise = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.stopping = false;
  }

  start() {
    if (this.child?.exitCode === null && !this.child.killed) {
      return Promise.resolve();
    }
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise((resolve, reject) => {
      const child = spawn(
        this.executable,
        ['--app-data-dir', this.appDataDirectory],
        {
          cwd: path.dirname(this.executable),
          env: {
            ...process.env,
            BAUDTIDE_APP_DATA_DIR: this.appDataDirectory,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      this.child = child;
      let started = false;

      const output = readline.createInterface({ input: child.stdout });
      output.on('line', (line) => this.handleLine(line));
      child.stderr.on('data', (chunk) => {
        process.stderr.write(`[baudtide-backend] ${chunk.toString()}`);
      });

      child.once('spawn', () => {
        started = true;
        this.startPromise = null;
        resolve();
      });
      child.once('error', (error) => {
        if (!started) {
          this.startPromise = null;
          reject(new Error(`Could not start the native backend at ${this.executable}: ${error.message}`));
        }
      });
      child.once('exit', (code, signal) => {
        output.close();
        if (this.child === child) this.child = null;
        this.startPromise = null;
        const reason = signal
          ? `signal ${signal}`
          : `exit code ${code ?? 'unknown'}`;
        this.rejectPending(new Error(`The native backend stopped (${reason}).`));
        if (!this.stopping) this.onUnexpectedExit(reason);
      });
    });
    return this.startPromise;
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      console.error('Ignored malformed JSON from the native backend:', errorMessage(error));
      return;
    }

    if (typeof message.event === 'string') {
      if (allowedEvents.has(message.event)) {
        this.onEvent(message.event, message.payload);
      }
      return;
    }

    if (!Object.hasOwn(message, 'id')) return;
    const request = this.pending.get(String(message.id));
    if (!request) return;
    this.pending.delete(String(message.id));
    if (Object.hasOwn(message, 'error') && message.error !== null) {
      request.reject(new Error(errorMessage(message.error)));
    } else {
      request.resolve(message.result);
    }
  }

  async invoke(method, params = {}) {
    await this.start();
    const child = this.child;
    if (!child?.stdin?.writable) {
      throw new Error('The native backend is not available.');
    }

    const id = String(this.nextRequestId++);
    let requestLine;
    try {
      requestLine = `${JSON.stringify({ id, method, params })}\n`;
    } catch (error) {
      throw new Error(`Could not serialize command ${method}: ${errorMessage(error)}`);
    }
    if (Buffer.byteLength(requestLine, 'utf8') > requestByteLimit) {
      throw new Error(`Desktop commands are limited to ${requestByteLimit} bytes.`);
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(requestLine, 'utf8', (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(new Error(`Could not send command ${method}: ${error.message}`));
      });
    });
  }

  rejectPending(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  async stop() {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;

    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      await Promise.race([
        this.invoke('shutdown', {}),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('Native backend shutdown timed out.')),
          4_000,
        )),
      ]);
    } catch (error) {
      console.warn(errorMessage(error));
    }

    // The backend writes its response immediately before returning from main;
    // allow that normal process exit to win before sending any signal.
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 750)),
    ]);
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 1_500)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

let mainWindow = null;
let shutdownStarted = false;
let shutdownComplete = false;
let crashDialogShown = false;

function sendBackendEvent(eventName, payload) {
  if (!allowedEvents.has(eventName)) return;
  const channel = `${eventChannelPrefix}${eventName}`;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

const backend = new BackendProcess({
  executable: backendExecutablePath(),
  appDataDirectory: backendDataDirectory,
  onEvent: sendBackendEvent,
  onUnexpectedExit(reason) {
    if (shutdownStarted || crashDialogShown) return;
    crashDialogShown = true;
    dialog.showErrorBox(
      `${APP_NAME} backend stopped`,
      `The native serial backend stopped unexpectedly (${reason}). ${APP_NAME} will close so active captures are not left in an uncertain state.`,
    );
    shutdownComplete = true;
    app.quit();
  },
});

function requirePlainArguments(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError('Desktop command arguments must be an object.');
  }
}

async function chooseLogDirectory() {
  const options = {
    title: `Choose ${APP_NAME} log folder`,
    buttonLabel: 'Choose folder',
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  const selectedPath = path.resolve(result.filePaths[0]);
  if (!path.isAbsolute(selectedPath)) {
    throw new Error('The selected log folder must be an absolute path.');
  }
  return selectedPath;
}

async function saveLogCopy(args) {
  if (typeof args.sourcePath !== 'string' || !path.isAbsolute(args.sourcePath)) {
    throw new TypeError('A valid absolute sourcePath is required to export a log.');
  }
  const options = {
    title: 'Save serial log copy',
    defaultPath: path.basename(args.sourcePath) || 'serial-capture.log',
    buttonLabel: 'Save copy',
    filters: [
      { name: 'Serial log', extensions: ['log', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  };
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  const destinationPath = path.extname(result.filePath)
    ? result.filePath
    : `${result.filePath}.log`;
  return backend.invoke('save_saved_log', {
    ...args,
    destinationPath: path.resolve(destinationPath),
  });
}

async function validateTelemetryDestination(destination) {
  const logs = await backend.invoke('list_saved_logs');
  await assertExportDestinationSafe(destination, {
    directories: [backendDataDirectory, app.getPath('userData')],
    files: logs.flatMap((log) => [log.path, `${log.path}.timing`]),
  });
}
const telemetryExports = new TelemetryExportStreams(validateTelemetryDestination);
const captureAnalyses = new CaptureAnalysisReaders((command, args) => backend.invoke(command, args));

async function disposeRendererResources() {
  const results = await Promise.allSettled([telemetryExports.dispose(), captureAnalyses.dispose()]);
  // Cleanup must not prevent backend shutdown when a native command fails.
  for (const result of results) {
    if (result.status === 'rejected') console.error('Could not clean up renderer resources:', errorMessage(result.reason));
  }
}

async function exportTelemetryData(args) {
  if (typeof args.contents !== 'string') {
    throw new TypeError('Telemetry export contents must be text.');
  }
  if (Buffer.byteLength(args.contents, 'utf8') > 64 * 1024 * 1024) {
    throw new Error('Telemetry exports are limited to 64 MB. Narrow the selected signals or display window and try again.');
  }
  const id = await telemetryExports.beginWithDestination(() => chooseTelemetryExportDestination(args));
  if (!id) return null;
  try {
    // Preserve the legacy command while using the same atomic publication path.
    let offset = 0;
    while (offset < args.contents.length) {
      let end = Math.min(args.contents.length, offset + 64 * 1024);
      const last = args.contents.charCodeAt(end - 1);
      if (end < args.contents.length && last >= 0xD800 && last <= 0xDBFF) end -= 1;
      await telemetryExports.append(id, args.contents.slice(offset, end)); offset = end;
    }
    return await telemetryExports.finish(id);
  } catch (error) { await telemetryExports.cancel(id).catch(() => undefined); throw error; }
}

async function chooseTelemetryExportDestination(args) {
  const format = args.format === 'json' ? 'json' : 'csv';
  const fallbackName = `baudtide-telemetry.${format}`;
  const requestedName = typeof args.defaultName === 'string' ? path.basename(args.defaultName) : fallbackName;
  const defaultName = requestedName && requestedName.length <= 160 ? requestedName : fallbackName;
  const options = {
    title: 'Export selected telemetry',
    defaultPath: defaultName,
    buttonLabel: 'Export data',
    filters: format === 'json'
      ? [{ name: 'JSON data', extensions: ['json'] }]
      : [{ name: 'CSV data', extensions: ['csv'] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  };
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  const destinationPath = path.extname(result.filePath)
    ? result.filePath
    : `${result.filePath}.${format}`;
  return path.resolve(destinationPath);
}

function toggleMenuBar(args) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const visible = typeof args.visible === 'boolean'
    ? args.visible
    : !mainWindow.isMenuBarVisible();
  mainWindow.setAutoHideMenuBar(!visible);
  mainWindow.setMenuBarVisibility(visible);
  return visible;
}

async function forceReload() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await disposeRendererResources();
  await backend.stop();
  shutdownComplete = true;

  // The development launcher owns Vite. Give it a restart-only exit code so
  // it can keep Vite alive while starting a fresh Electron process. Packaged
  // apps can use Electron's native relaunch path directly.
  if (!app.isPackaged && validatedDevelopmentUrl()) {
    app.exit(DEVELOPMENT_RESTART_EXIT_CODE);
    return;
  }
  app.relaunch();
  app.exit(0);
}

ipcMain.handle(invokeChannel, async (event, command, args = {}) => {
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Desktop commands are accepted only from the main application window.');
  }
  if (typeof command !== 'string' || !allowedCommands.has(command)) {
    throw new Error(`Unsupported desktop command: ${String(command)}`);
  }
  requirePlainArguments(args);

  if (command === 'open_capture_analysis') return captureAnalyses.open(args);
  if (command === 'read_capture_analysis_chunk') return captureAnalyses.read(args);
  if (command === 'close_capture_analysis') return captureAnalyses.close(args);

  if (electronOwnedCommands.has(command)) {
    if (command === 'select_log_directory') return chooseLogDirectory();
    if (command === 'save_saved_log') return saveLogCopy(args);
    if (command === 'export_telemetry_data') return exportTelemetryData(args);
    if (command === 'begin_telemetry_export') {
      return telemetryExports.beginWithDestination(() => chooseTelemetryExportDestination(args));
    }
    if (command === 'append_telemetry_export') return telemetryExports.append(args.id, args.contents);
    if (command === 'finish_telemetry_export') return telemetryExports.finish(args.id);
    if (command === 'cancel_telemetry_export') return telemetryExports.cancel(args.id);
    return toggleMenuBar(args);
  }
  return backend.invoke(command, args);
});

function buildApplicationMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        process.platform === 'darwin'
          ? { role: 'close' }
          : { role: 'quit', label: `Quit ${APP_NAME}` },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        {
          label: 'Force Reload (restart app)',
          accelerator: process.platform === 'darwin' ? 'Cmd+Shift+R' : 'Ctrl+Shift+R',
          click: () => { void forceReload(); },
        },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        {
          label: 'Toggle Menu Bar',
          accelerator: process.platform === 'linux' ? 'F10' : undefined,
          click: () => toggleMenuBar({}),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () => {
            const options = {
              type: 'info',
              title: `About ${APP_NAME}`,
              message: APP_NAME,
              detail: `Version ${app.getVersion()}\nA focused desktop serial monitor.`,
            };
            return mainWindow
              ? dialog.showMessageBox(mainWindow, options)
              : dialog.showMessageBox(options);
          },
        },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function validatedDevelopmentUrl() {
  const value = process.env.BAUDTIDE_DEV_SERVER_URL;
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('BAUDTIDE_DEV_SERVER_URL must point to a local HTTP server.');
  }
  return url.toString();
}

const packagedContentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function protocolResponse(body, status, contentType = 'text/plain; charset=utf-8') {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': contentType,
      'Content-Security-Policy': PRODUCTION_CSP,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function registerPackagedApplicationProtocol() {
  const contentRoot = path.resolve(projectRoot, 'dist');
  protocol.handle(APPLICATION_SCHEME, async (request) => {
    if (request.method !== 'GET') return protocolResponse('Method not allowed', 405);

    let url;
    let relativePath;
    try {
      url = new URL(request.url);
      if (url.host !== APPLICATION_HOST) return protocolResponse('Not found', 404);
      relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    } catch {
      return protocolResponse('Bad request', 400);
    }

    // Backslashes are separators on Windows and NUL is never valid in a path.
    // Reject both before resolving and then verify that traversal stayed below
    // the immutable packaged dist directory.
    if (relativePath.includes('\\') || relativePath.includes('\0')) {
      return protocolResponse('Bad request', 400);
    }
    const filePath = path.resolve(contentRoot, relativePath);
    const relationship = path.relative(contentRoot, filePath);
    if (relationship.startsWith('..') || path.isAbsolute(relationship)) {
      return protocolResponse('Not found', 404);
    }

    try {
      const contents = await fs.promises.readFile(filePath);
      const contentType = packagedContentTypes.get(path.extname(filePath).toLowerCase())
        ?? 'application/octet-stream';
      return protocolResponse(contents, 200, contentType);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EISDIR') {
        return protocolResponse('Not found', 404);
      }
      console.error(`Could not serve packaged application file ${filePath}:`, errorMessage(error));
      return protocolResponse('Internal error', 500);
    }
  });
}

async function createMainWindow() {
  const window = new BrowserWindow({
    title: APP_NAME,
    icon: WINDOW_ICON_PATH,
    width: 1320,
    height: 850,
    minWidth: 900,
    minHeight: 650,
    show: false,
    // Keep the native menu unobtrusive; Electron reveals it when the user
    // presses the single Alt key, while View > Toggle Menu Bar remains
    // available for an explicit persistent toggle.
    autoHideMenuBar: true,
    backgroundColor: '#0a0d14',
    webPreferences: {
      preload: path.join(electronDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  mainWindow = window;

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  const cleanRendererResources = () => { void disposeRendererResources().catch((error) => console.error('Could not clean up renderer resources:', errorMessage(error))); };
  window.webContents.on('render-process-gone', cleanRendererResources);
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) cleanRendererResources(); });
  window.once('ready-to-show', () => window.show());
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  const developmentUrl = validatedDevelopmentUrl();
  if (developmentUrl) {
    await window.loadURL(developmentUrl);
  } else {
    await window.loadURL(`${APPLICATION_SCHEME}://${APPLICATION_HOST}/index.html`);
  }
}

async function beginShutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await disposeRendererResources();
  await backend.stop();
  shutdownComplete = true;
  app.quit();
}

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  void beginShutdown();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && !shutdownStarted) {
    void createMainWindow();
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => app.quit());
}

app.whenReady().then(async () => {
  buildApplicationMenu();
  try {
    registerPackagedApplicationProtocol();
    fs.mkdirSync(backendDataDirectory, { recursive: true });
    await backend.start();
    await createMainWindow();
  } catch (error) {
    dialog.showErrorBox(
      `${APP_NAME} could not start`,
      errorMessage(error),
    );
    shutdownComplete = true;
    app.quit();
  }
});
