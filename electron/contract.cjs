'use strict';

// Keep this list deliberately small. The preload bridge and main process both
// enforce it so renderer code can never turn the sidecar into an arbitrary RPC
// endpoint.
const commands = Object.freeze([
  'list_serial_ports',
  'list_active_sessions',
  'take_pending_serial_data',
  'load_preferences',
  'save_preferences',
  'select_log_directory',
  'list_saved_logs',
  'search_saved_logs',
  'cancel_saved_log_search',
  'read_saved_log',
  'read_saved_log_telemetry',
  'delete_saved_log',
  'save_saved_log',
  'export_telemetry_data',
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

module.exports = Object.freeze({
  commands,
  events,
  invokeChannel: 'baudtide:invoke',
  eventChannelPrefix: 'baudtide:event:',
  requestByteLimit: 1024 * 1024,
});
