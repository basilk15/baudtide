'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preloads only receive Electron's restricted `require`. Keep this
// tiny contract self-contained instead of requiring a local CommonJS module.
const commands = Object.freeze([
  'list_serial_ports',
  'list_active_sessions',
  'take_pending_serial_data',
  'load_preferences',
  'save_preferences',
  'select_log_directory',
  'list_saved_logs',
  'get_capture_storage_usage',
  'search_saved_logs',
  'cancel_saved_log_search',
  'read_saved_log',
  'read_saved_log_telemetry',
  'open_capture_analysis',
  'read_capture_analysis_chunk',
  'close_capture_analysis',
  'delete_saved_log',
  'save_saved_log',
  'export_telemetry_data',
  'begin_telemetry_export',
  'append_telemetry_export',
  'finish_telemetry_export',
  'cancel_telemetry_export',
  'start_mobile_share',
  'get_mobile_share_status',
  'set_mobile_share_control',
  'stop_mobile_share',
  'start_mobile_workspace_share',
  'get_mobile_workspace_share_status',
  'stop_mobile_workspace_share',
  'start_serial_session',
  'send_serial_text',
  'send_serial_bytes',
  'disconnect_serial_session',
  'toggle_menu_bar',
]);
const events = Object.freeze(['serial-data', 'serial-status']);
const invokeChannel = 'baudtide:invoke';
const eventChannelPrefix = 'baudtide:event:';

const allowedCommands = new Set(commands);
const allowedEvents = new Set(events);

function requireAllowedCommand(command) {
  if (typeof command !== 'string' || !allowedCommands.has(command)) {
    throw new Error(`Unsupported desktop command: ${String(command)}`);
  }
}

function requireAllowedEvent(eventName) {
  if (typeof eventName !== 'string' || !allowedEvents.has(eventName)) {
    throw new Error(`Unsupported desktop event: ${String(eventName)}`);
  }
}

const desktopBridge = Object.freeze({
  platform: process.platform,

  invoke(command, args = {}) {
    requireAllowedCommand(command);
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return Promise.reject(new TypeError('Desktop command arguments must be an object.'));
    }
    return ipcRenderer.invoke(invokeChannel, command, args);
  },

  listen(eventName, callback) {
    requireAllowedEvent(eventName);
    if (typeof callback !== 'function') {
      throw new TypeError('Desktop event callback must be a function.');
    }

    const channel = `${eventChannelPrefix}${eventName}`;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);

    let listening = true;
    return () => {
      if (!listening) return;
      listening = false;
      ipcRenderer.removeListener(channel, listener);
    };
  },
});

contextBridge.exposeInMainWorld('baudtideDesktop', desktopBridge);
