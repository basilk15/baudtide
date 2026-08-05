#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(clippy::items_after_test_module)]

use std::{
    collections::{hash_map::DefaultHasher, BTreeMap, HashMap, HashSet},
    fs::{create_dir_all, read_dir, File, OpenOptions},
    hash::{Hash, Hasher},
    io::{self, BufReader, BufWriter, Read, Write},
    net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortType, StopBits};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const READ_TIMEOUT: Duration = Duration::from_millis(100);
const READ_BUFFER_SIZE: usize = 4096;
/// Flushing hands bytes to the operating system, but does not make them
/// crash-durable. Bound the amount of an active raw capture that can remain
/// only in filesystem caches while avoiding an expensive sync for every UART
/// read chunk.
const CAPTURE_DURABILITY_SYNC_INTERVAL: Duration = Duration::from_secs(1);
/// Startup data is normally drained as soon as the React monitor subscribes.
/// This cap prevents a disconnected/failed WebView from retaining an
/// unbounded device stream; raw logging continues even if it is reached.
const STARTUP_EVENT_BUFFER_BYTE_LIMIT: usize = 4 * 1024 * 1024;
const SETTINGS_VERSION: u32 = 1;
const GIBIBYTE: u64 = 1024 * 1024 * 1024;
/// The default search reads at most this many bytes from one raw capture, and
/// no more than `SEARCH_TOTAL_BYTE_LIMIT` across a request. The UI can opt in
/// to a full scan for an exact result across complete captures.
const SEARCH_PER_LOG_BYTE_LIMIT: u64 = 256 * 1024;
const SEARCH_TOTAL_BYTE_LIMIT: u64 = 4 * 1024 * 1024;
const SEARCH_RESULT_LIMIT: usize = 100;
const SEARCH_SNIPPET_LIMIT: usize = 3;
const SEARCH_QUERY_BYTE_LIMIT: usize = 256;
const SEARCH_READ_BUFFER_SIZE: usize = 16 * 1024;
/// Complete-capture search maintains a separate text cache. Keep
/// each refresh bounded: an unusually large capture still has an exact raw
/// fallback, but cannot turn one UI request into an unbounded cache write.
const SEARCH_INDEX_PER_LOG_BYTE_LIMIT: u64 = 32 * 1024 * 1024;
const SEARCH_INDEX_TOTAL_BYTE_LIMIT: u64 = 128 * 1024 * 1024;
const SEARCH_INDEX_MAGIC: &[u8] = b"BTSEARCH1";
// Version 2 stores the original capture bytes so indexed snippets retain the
// exact casing users saw in the raw log. Version 1 normalized bytes are not
// safe to reuse for display and are treated as stale.
const SEARCH_INDEX_SCHEMA_VERSION: u8 = 2;
const SEARCH_ID_BYTE_LIMIT: usize = 128;
const SEARCH_CANCELLED_MESSAGE: &str = "Saved-log search was cancelled.";
const SERIAL_WRITE_BYTE_LIMIT: usize = 64 * 1024;
const SESSION_NAME_BYTE_LIMIT: usize = 120;
const PORT_PATH_BYTE_LIMIT: usize = 256;
const MOBILE_SHARE_REQUEST_BYTE_LIMIT: usize = 16 * 1024;
const MOBILE_SHARE_CLIENT_LIMIT: usize = 8;
const MOBILE_SHARE_ACCEPT_POLL: Duration = Duration::from_millis(100);
const MOBILE_SHARE_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const MOBILE_SHARE_HEARTBEAT: Duration = Duration::from_secs(20);

type CommandResult<T> = Result<T, String>;
type SerialWriter = Arc<Mutex<Option<Box<dyn SerialPort>>>>;
type SavedLogContentSearch = (u32, Vec<SavedLogSearchMatch>, u64, bool);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AvailablePort {
    path: String,
    label: String,
    manufacturer: Option<String>,
    product: Option<String>,
    serial_number: Option<String>,
    transport: String,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct StartSessionRequest {
    port: String,
    baud_rate: u32,
    session_name: String,
    #[serde(default)]
    settings: SerialSettings,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct ApplicationSettings {
    version: u32,
    serial: SerialPreferenceSettings,
    storage: StoragePreferenceSettings,
    appearance: AppearancePreferenceSettings,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct SerialPreferenceSettings {
    baud_rate: u32,
    line_ending: String,
    display_encoding: String,
    show_timestamps: bool,
    reconnect_when_device_returns: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct StoragePreferenceSettings {
    log_directory: String,
    storage_limit_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct AppearancePreferenceSettings {
    theme: String,
}

impl Default for ApplicationSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            serial: SerialPreferenceSettings::default(),
            storage: StoragePreferenceSettings::default(),
            appearance: AppearancePreferenceSettings::default(),
        }
    }
}

impl Default for SerialPreferenceSettings {
    fn default() -> Self {
        Self {
            baud_rate: 115_200,
            line_ending: "lf".into(),
            display_encoding: "utf8".into(),
            show_timestamps: true,
            reconnect_when_device_returns: true,
        }
    }
}

impl Default for StoragePreferenceSettings {
    fn default() -> Self {
        Self {
            log_directory: String::new(),
            storage_limit_bytes: 10 * GIBIBYTE,
        }
    }
}

impl Default for AppearancePreferenceSettings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialSettings {
    #[serde(default = "default_data_bits")]
    data_bits: u8,
    #[serde(default)]
    parity: ParitySetting,
    #[serde(default)]
    stop_bits: StopBitsSetting,
    #[serde(default)]
    flow_control: FlowControlSetting,
}

impl Default for SerialSettings {
    fn default() -> Self {
        Self {
            data_bits: default_data_bits(),
            parity: ParitySetting::None,
            stop_bits: StopBitsSetting::One,
            flow_control: FlowControlSetting::None,
        }
    }
}

fn default_data_bits() -> u8 {
    8
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ParitySetting {
    #[default]
    None,
    Odd,
    Even,
}

impl From<ParitySetting> for Parity {
    fn from(value: ParitySetting) -> Self {
        match value {
            ParitySetting::None => Parity::None,
            ParitySetting::Odd => Parity::Odd,
            ParitySetting::Even => Parity::Even,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum StopBitsSetting {
    #[default]
    One,
    Two,
}

impl From<StopBitsSetting> for StopBits {
    fn from(value: StopBitsSetting) -> Self {
        match value {
            StopBitsSetting::One => StopBits::One,
            StopBitsSetting::Two => StopBits::Two,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum FlowControlSetting {
    #[default]
    None,
    Software,
    Hardware,
}

impl From<FlowControlSetting> for FlowControl {
    fn from(value: FlowControlSetting) -> Self {
        match value {
            FlowControlSetting::None => FlowControl::None,
            FlowControlSetting::Software => FlowControl::Software,
            FlowControlSetting::Hardware => FlowControl::Hardware,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    id: String,
    port: String,
    baud_rate: u32,
    session_name: String,
    log_path: String,
    state: &'static str,
    settings: SerialSettings,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialDataEvent {
    session_id: String,
    port: String,
    /// Monotonic within one native session. The UI uses this to merge the
    /// startup replay with live events without reordering or duplication.
    sequence: u64,
    timestamp: String,
    text: String,
    bytes: Vec<u8>,
}

/// A serial reader begins as soon as a port opens, but the WebView cannot
/// subscribe until the start command has returned its session ID. Keep the
/// short startup window in-process, then atomically hand it to the UI.
enum SerialEventDelivery {
    Buffering {
        events: Vec<SerialDataEvent>,
        buffered_bytes: usize,
        dropped_event_count: u64,
        next_sequence: u64,
    },
    Live {
        next_sequence: u64,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingSerialData {
    events: Vec<SerialDataEvent>,
    /// Count of startup chunks that remained safely captured in the raw log
    /// but could not fit in the short-lived display handoff buffer.
    dropped_event_count: u64,
    /// First serial-event sequence after the atomic handoff snapshot.
    next_sequence: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialStatusEvent {
    session_id: String,
    port: String,
    status: &'static str,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedLog {
    path: String,
    file_name: String,
    session_name: String,
    port: Option<String>,
    baud_rate: Option<u32>,
    settings: Option<SerialSettings>,
    size_bytes: u64,
    modified_at: String,
    session_id: Option<String>,
    started_at: Option<String>,
    ended_at: Option<String>,
    metadata_available: bool,
    state: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedLogContent {
    path: String,
    text: String,
    truncated: bool,
}

/// One record is written before BaudTide opens a serial port. Index records are
/// intentionally stored separately from raw captures, so capture files are
/// never renamed, replaced, or otherwise disturbed by library bookkeeping.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogIndexRecord {
    schema_version: u8,
    session_id: String,
    session_name: String,
    port: String,
    baud_rate: u32,
    #[serde(default)]
    settings: Option<SerialSettings>,
    started_at: String,
    updated_at: String,
    ended_at: Option<String>,
    log_path: String,
    state: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedLogSearchMatch {
    source: String,
    byte_offset: Option<u64>,
    snippet: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedLogSearchResult {
    log: SavedLog,
    metadata_match: bool,
    content_match_count: u32,
    content_matches: Vec<SavedLogSearchMatch>,
    content_search_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedLogSearchResponse {
    results: Vec<SavedLogSearchResult>,
    scanned_log_count: usize,
    scanned_bytes: u64,
    full_search: bool,
    truncated: bool,
    result_limit_reached: bool,
    per_log_byte_limit: Option<u64>,
    total_byte_limit: Option<u64>,
    result_limit: usize,
    indexed_log_count: usize,
    index_rebuilt_log_count: usize,
    index_fallback_log_count: usize,
    index_update_limited: bool,
}

/// Header for a text cache containing original capture bytes. The raw capture remains authoritative:
/// this header is only valid while its source fingerprint still matches.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedLogTextIndexHeader {
    schema_version: u8,
    log_path: String,
    source_size: u64,
    modified_seconds: u64,
    modified_nanos: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct SavedLogFingerprint {
    size: u64,
    modified_seconds: u64,
    modified_nanos: u32,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedLogSearchOptions {
    /// Full scans are explicitly requested from the Saved logs screen because
    /// a library may contain very large, raw serial captures.
    #[serde(default)]
    full_search: bool,
    /// An opaque identifier supplied by the UI so it can stop an in-flight
    /// complete-capture search without affecting any capture files.
    #[serde(default)]
    search_id: Option<String>,
}

struct ActiveSession {
    info: SessionInfo,
    stop: Arc<AtomicBool>,
    writer: SerialWriter,
    event_delivery: Arc<Mutex<SerialEventDelivery>>,
    reader_thread: JoinHandle<()>,
}

struct ReaderContext {
    app: AppHandle,
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
    event_delivery: Arc<Mutex<SerialEventDelivery>>,
    quota: Arc<Mutex<CaptureQuota>>,
    mobile_shares: Arc<Mutex<HashMap<String, ActiveMobileShare>>>,
}

struct CaptureQuota {
    used_bytes: u64,
    limit_bytes: u64,
}

impl Default for CaptureQuota {
    fn default() -> Self {
        Self {
            used_bytes: 0,
            limit_bytes: ApplicationSettings::default().storage.storage_limit_bytes,
        }
    }
}

#[derive(Default)]
struct SerialState {
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
    closing_log_paths: Arc<Mutex<HashSet<String>>>,
    mobile_shares: Arc<Mutex<HashMap<String, ActiveMobileShare>>>,
    saved_log_searches: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    capture_quota: Arc<Mutex<CaptureQuota>>,
    shutting_down: Arc<AtomicBool>,
}

/// Only the desktop UI can create a share. The opaque token lives solely in
/// the QR-compatible URL, and every HTTP/WebSocket request must present it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileShareInfo {
    session_id: String,
    url: String,
    host: String,
    port: u16,
    client_count: usize,
    enabled: bool,
}

struct ActiveMobileShare {
    token: String,
    host: String,
    port: u16,
    stop: Arc<AtomicBool>,
    clients: Arc<Mutex<HashMap<u64, std::sync::mpsc::SyncSender<String>>>>,
    server_thread: JoinHandle<()>,
}

/// Removes its cancellation flag when the matching search completes. Matching
/// the Arc identity avoids an old search removing a newer request that happens
/// to reuse the same opaque identifier.
struct ActiveSavedLogSearch {
    id: String,
    cancelled: Arc<AtomicBool>,
    searches: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

struct ClosingLogGuard {
    key: String,
    paths: Arc<Mutex<HashSet<String>>>,
}

impl Drop for ClosingLogGuard {
    fn drop(&mut self) {
        if let Ok(mut paths) = self.paths.lock() {
            paths.remove(&self.key);
        }
    }
}

fn mark_log_closing(
    paths: &Arc<Mutex<HashSet<String>>>,
    key: String,
) -> CommandResult<ClosingLogGuard> {
    paths.lock().map_err(lock_error)?.insert(key.clone());
    Ok(ClosingLogGuard {
        key,
        paths: Arc::clone(paths),
    })
}

impl Drop for ActiveSavedLogSearch {
    fn drop(&mut self) {
        if let Ok(mut searches) = self.searches.lock() {
            let is_current = searches
                .get(&self.id)
                .is_some_and(|current| Arc::ptr_eq(current, &self.cancelled));
            if is_current {
                searches.remove(&self.id);
            }
        }
    }
}

#[tauri::command]
fn list_serial_ports() -> CommandResult<Vec<AvailablePort>> {
    serialport::available_ports()
        .map_err(|error| format!("Could not list serial ports: {error}"))
        .map(|ports| ports.into_iter().map(port_metadata).collect())
}

#[tauri::command]
fn list_active_sessions(state: State<'_, SerialState>) -> CommandResult<Vec<SessionInfo>> {
    let sessions = state.sessions.lock().map_err(lock_error)?;
    let mut active = Vec::with_capacity(sessions.len());
    for session in sessions.values() {
        // A WebView reload drops its event listeners while the native reader
        // keeps running. Discovery is the recovery boundary: bytes received
        // after this point use the same bounded replay handoff as a new
        // session, while the on-disk raw capture remains authoritative for the
        // earlier listener gap.
        let mut delivery = session.event_delivery.lock().map_err(lock_error)?;
        if let SerialEventDelivery::Live { next_sequence } = &*delivery {
            *delivery = SerialEventDelivery::Buffering {
                events: Vec::new(),
                buffered_bytes: 0,
                dropped_event_count: 0,
                next_sequence: *next_sequence,
            };
        }
        active.push(session.info.clone());
    }
    Ok(active)
}

/// Atomically returns bytes received before the WebView registered its event
/// listener, then switches this session to direct event delivery. The sequence
/// field on each event lets the frontend safely merge these with any event that
/// reaches it immediately after the switch.
#[tauri::command]
fn take_pending_serial_data(
    state: State<'_, SerialState>,
    session_id: String,
) -> CommandResult<PendingSerialData> {
    let delivery = {
        let sessions = state.sessions.lock().map_err(lock_error)?;
        sessions
            .get(&session_id)
            .ok_or_else(|| "This serial session is no longer active.".to_string())?
            .event_delivery
            .clone()
    };
    let mut delivery = delivery.lock().map_err(lock_error)?;
    Ok(activate_serial_event_delivery(&mut delivery))
}

fn activate_serial_event_delivery(delivery: &mut SerialEventDelivery) -> PendingSerialData {
    match delivery {
        SerialEventDelivery::Buffering {
            events,
            dropped_event_count,
            next_sequence,
            ..
        } => {
            let buffered = std::mem::take(events);
            let dropped_event_count = *dropped_event_count;
            let next_sequence = *next_sequence;
            *delivery = SerialEventDelivery::Live { next_sequence };
            PendingSerialData {
                events: buffered,
                dropped_event_count,
                next_sequence,
            }
        }
        SerialEventDelivery::Live { next_sequence } => PendingSerialData {
            events: Vec::new(),
            dropped_event_count: 0,
            next_sequence: *next_sequence,
        },
    }
}

#[tauri::command]
fn load_preferences(app: AppHandle) -> CommandResult<ApplicationSettings> {
    load_application_settings(&app)
}

#[tauri::command]
fn save_preferences(
    app: AppHandle,
    state: State<'_, SerialState>,
    settings: ApplicationSettings,
) -> CommandResult<ApplicationSettings> {
    validate_preference_log_directory(&settings.storage.log_directory)?;
    let settings = normalize_application_settings(settings);
    let current = load_application_settings(&app)?;
    if !settings.storage.log_directory.is_empty()
        && settings.storage.log_directory != current.storage.log_directory
    {
        return Err("Choose a log folder with the native folder picker.".into());
    }
    save_application_settings(&app, &settings)?;
    state.capture_quota.lock().map_err(lock_error)?.limit_bytes =
        settings.storage.storage_limit_bytes;
    Ok(settings)
}

fn validate_preference_log_directory(directory: &str) -> CommandResult<()> {
    let directory = directory.trim();
    if directory.is_empty() || Path::new(directory).is_absolute() {
        Ok(())
    } else {
        Err("Log folder must be an absolute path. Choose a folder or enter a full path.".into())
    }
}

#[tauri::command]
async fn select_log_directory(app: AppHandle) -> CommandResult<Option<String>> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.dialog()
        .file()
        .set_title("Choose BaudTide log folder")
        .pick_folder(move |selection| {
            let _ = sender.send(selection.and_then(|path| path.into_path().ok()));
        });
    let selected = tauri::async_runtime::spawn_blocking(move || receiver.recv().ok().flatten())
        .await
        .map_err(|error| format!("Could not receive the selected log folder: {error}"))?;
    let Some(directory) = selected else {
        return Ok(None);
    };
    let directory = directory
        .canonicalize()
        .map_err(|error| format!("Could not use the selected log folder: {error}"))?;
    if !directory.is_dir() {
        return Err("Choose an existing log folder.".into());
    }
    let mut settings = load_application_settings(&app)?;
    settings.storage.log_directory = directory.display().to_string();
    save_application_settings(&app, &settings)?;
    Ok(Some(settings.storage.log_directory))
}

#[tauri::command]
fn list_saved_logs(app: AppHandle, state: State<'_, SerialState>) -> CommandResult<Vec<SavedLog>> {
    collect_saved_logs(&app, &state.sessions)
}

#[tauri::command]
async fn search_saved_logs(
    app: AppHandle,
    state: State<'_, SerialState>,
    query: String,
    options: Option<SavedLogSearchOptions>,
) -> CommandResult<SavedLogSearchResponse> {
    let options = options.unwrap_or_default();
    let full_search = options.full_search;
    let query = query.trim().to_owned();
    if query.is_empty() {
        return Ok(SavedLogSearchResponse {
            results: Vec::new(),
            scanned_log_count: 0,
            scanned_bytes: 0,
            full_search,
            truncated: false,
            result_limit_reached: false,
            per_log_byte_limit: (!full_search).then_some(SEARCH_PER_LOG_BYTE_LIMIT),
            total_byte_limit: (!full_search).then_some(SEARCH_TOTAL_BYTE_LIMIT),
            result_limit: SEARCH_RESULT_LIMIT,
            indexed_log_count: 0,
            index_rebuilt_log_count: 0,
            index_fallback_log_count: 0,
            index_update_limited: false,
        });
    }
    if query.len() > SEARCH_QUERY_BYTE_LIMIT {
        return Err(format!(
            "Search terms are limited to {SEARCH_QUERY_BYTE_LIMIT} bytes so local log search stays responsive."
        ));
    }

    let active_search = if full_search {
        options
            .search_id
            .as_deref()
            .map(str::trim)
            .filter(|search_id| !search_id.is_empty())
            .map(|search_id| begin_saved_log_search(&state, search_id))
            .transpose()?
    } else {
        None
    };
    let sessions = Arc::clone(&state.sessions);
    tauri::async_runtime::spawn_blocking(move || {
        let cancellation = active_search
            .as_ref()
            .map(|search| search.cancelled.as_ref());
        run_saved_log_search(&app, &sessions, query, full_search, cancellation)
    })
    .await
    .map_err(|error| format!("Saved-log search worker stopped unexpectedly: {error}"))?
}

fn run_saved_log_search(
    app: &AppHandle,
    sessions: &Arc<Mutex<HashMap<String, ActiveSession>>>,
    query: String,
    full_search: bool,
    cancellation: Option<&AtomicBool>,
) -> CommandResult<SavedLogSearchResponse> {
    let query_bytes = query.as_bytes().to_ascii_lowercase();
    let mut total_remaining = SEARCH_TOTAL_BYTE_LIMIT;
    let mut scanned_bytes: u64 = 0;
    let mut scanned_log_count = 0;
    let mut truncated = false;
    let mut result_limit_reached = false;
    let mut results = Vec::new();
    let mut indexed_log_count = 0;
    let mut index_rebuilt_log_count = 0;
    let mut index_fallback_log_count = 0;
    let mut index_update_budget = SEARCH_INDEX_TOTAL_BYTE_LIMIT;
    let mut index_update_limited = false;

    for log in collect_saved_logs(app, sessions)? {
        ensure_search_not_cancelled(cancellation)?;
        let metadata_match = saved_log_metadata(&log)
            .to_ascii_lowercase()
            .contains(&query.to_ascii_lowercase());
        let scan_limit = if full_search {
            log.size_bytes
        } else {
            total_remaining.min(SEARCH_PER_LOG_BYTE_LIMIT)
        };
        let (content_match_count, content_matches, _bytes_scanned, content_search_truncated) =
            if scan_limit == 0 {
                if !full_search && log.size_bytes > 0 {
                    truncated = true;
                }
                (0, Vec::new(), 0, log.size_bytes > 0)
            } else if full_search && log.state != "capturing" {
                match search_fresh_log_text_index(
                    app,
                    Path::new(&log.path),
                    &query_bytes,
                    cancellation,
                ) {
                    Ok(Some(search)) => {
                        indexed_log_count += 1;
                        scanned_log_count += 1;
                        scanned_bytes = scanned_bytes.saturating_add(search.2);
                        search
                    }
                    Ok(None) => {
                        index_fallback_log_count += 1;
                        let search = search_raw_log(
                            Path::new(&log.path),
                            &query_bytes,
                            scan_limit,
                            cancellation,
                        )?;
                        scanned_log_count += 1;
                        scanned_bytes = scanned_bytes.saturating_add(search.2);
                        let index_limit = index_update_budget.min(SEARCH_INDEX_PER_LOG_BYTE_LIMIT);
                        if index_limit < log.size_bytes {
                            index_update_limited = true;
                        } else {
                            match rebuild_log_text_index(
                                app,
                                Path::new(&log.path),
                                index_limit,
                                cancellation,
                            ) {
                                Ok(true) => {
                                    index_rebuilt_log_count += 1;
                                    index_update_budget =
                                        index_update_budget.saturating_sub(log.size_bytes);
                                }
                                Ok(false) => {}
                                Err(error) if error == SEARCH_CANCELLED_MESSAGE => {
                                    return Err(error)
                                }
                                // Index files are derived data. Disk damage or a concurrent
                                // cache cleanup must not hide a successful raw fallback.
                                Err(_) => {}
                            }
                        }
                        search
                    }
                    Err(error) if is_missing_search_path_error(&error) => continue,
                    Err(error) => return Err(error),
                }
            } else {
                let search = match search_raw_log(
                    Path::new(&log.path),
                    &query_bytes,
                    scan_limit,
                    cancellation,
                ) {
                    Ok(search) => search,
                    Err(error) if is_missing_search_path_error(&error) => continue,
                    Err(error) => return Err(error),
                };
                scanned_log_count += 1;
                scanned_bytes = scanned_bytes.saturating_add(search.2);
                if !full_search {
                    total_remaining = total_remaining.saturating_sub(search.2);
                }
                if search.3 {
                    truncated = true;
                }
                search
            };
        // A deletion can race an index lookup or raw scan. Do the final
        // authority check against the raw path before returning a match.
        if (metadata_match || content_match_count > 0) && Path::new(&log.path).is_file() {
            if results.len() == SEARCH_RESULT_LIMIT {
                // Keep scanning after the result list fills so an explicitly
                // requested full scan still examines every capture. The UI
                // reports that only the first matching logs are displayed.
                result_limit_reached = true;
                continue;
            }
            results.push(SavedLogSearchResult {
                log,
                metadata_match,
                content_match_count,
                content_matches,
                content_search_truncated,
            });
        }
    }
    Ok(SavedLogSearchResponse {
        results,
        scanned_log_count,
        scanned_bytes,
        full_search,
        truncated,
        result_limit_reached,
        per_log_byte_limit: (!full_search).then_some(SEARCH_PER_LOG_BYTE_LIMIT),
        total_byte_limit: (!full_search).then_some(SEARCH_TOTAL_BYTE_LIMIT),
        result_limit: SEARCH_RESULT_LIMIT,
        indexed_log_count,
        index_rebuilt_log_count,
        index_fallback_log_count,
        index_update_limited,
    })
}

#[tauri::command]
fn cancel_saved_log_search(state: State<'_, SerialState>, search_id: String) -> CommandResult<()> {
    let search_id = search_id.trim();
    if search_id.is_empty() {
        return Ok(());
    }
    if search_id.len() > SEARCH_ID_BYTE_LIMIT {
        return Err(format!(
            "Search identifiers are limited to {SEARCH_ID_BYTE_LIMIT} bytes."
        ));
    }
    if let Some(cancelled) = state
        .saved_log_searches
        .lock()
        .map_err(lock_error)?
        .get(search_id)
    {
        cancelled.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
fn read_saved_log(app: AppHandle, path: String) -> CommandResult<SavedLogContent> {
    let path = resolve_saved_log_path(&app, &path)?;
    const PREVIEW_LIMIT: u64 = 1_000_000;
    let metadata = path
        .metadata()
        .map_err(|error| format!("Could not inspect the saved log: {error}"))?;
    let file =
        File::open(&path).map_err(|error| format!("Could not open the saved log: {error}"))?;
    let mut bytes = Vec::new();
    file.take(PREVIEW_LIMIT)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read the saved log: {error}"))?;
    Ok(SavedLogContent {
        path: path.display().to_string(),
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated: metadata.len() > PREVIEW_LIMIT,
    })
}

#[tauri::command]
fn delete_saved_log(
    app: AppHandle,
    state: State<'_, SerialState>,
    path: String,
) -> CommandResult<()> {
    let path = resolve_saved_log_path(&app, &path)?;
    let key = path_key(&path);
    let deleted_bytes = path
        .metadata()
        .map_err(|error| format!("Could not inspect the saved log: {error}"))?
        .len();
    // Keep the session lock through removal so a newly starting capture cannot
    // race the active-path check. The start path uses the same lock through
    // capture creation and insertion.
    let sessions = state.sessions.lock().map_err(lock_error)?;
    let is_active = sessions
        .values()
        .any(|session| path_key(Path::new(&session.info.log_path)) == key);
    let is_closing = state
        .closing_log_paths
        .lock()
        .map_err(lock_error)?
        .contains(&key);
    if is_active || is_closing {
        return Err(
            "This capture is still recording. Disconnect the serial session before deleting it."
                .into(),
        );
    }
    let mut quota = state.capture_quota.lock().map_err(lock_error)?;
    std::fs::remove_file(&path)
        .map_err(|error| format!("Could not delete the saved log: {error}"))?;
    release_capture_quota(&mut quota, deleted_bytes);
    drop(quota);
    drop(sessions);

    // The raw capture is the source of truth. A stale sidecar is harmless and
    // must not make the UI report that deletion failed after the file is gone.
    if let Err(error) = remove_log_index_records_for_path(&app, &key) {
        eprintln!("{error}");
    }
    if let Err(error) = remove_log_text_indexes_for_path(&app, &key) {
        eprintln!("{error}");
    }
    Ok(())
}

fn release_capture_quota(quota: &mut CaptureQuota, deleted_bytes: u64) {
    quota.used_bytes = quota.used_bytes.saturating_sub(deleted_bytes);
}

#[tauri::command]
async fn save_saved_log(app: AppHandle, source_path: String) -> CommandResult<Option<String>> {
    let source = resolve_saved_log_path(&app, &source_path)?;
    let default_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("serial-capture.log")
        .to_owned();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.dialog()
        .file()
        .set_title("Save serial log copy")
        .set_file_name(default_name)
        .add_filter("Serial log", &["log", "txt"])
        .save_file(move |selection| {
            let _ = sender.send(selection.and_then(|path| path.into_path().ok()));
        });
    let destination = tauri::async_runtime::spawn_blocking(move || receiver.recv().ok().flatten())
        .await
        .map_err(|error| format!("Could not receive the export destination: {error}"))?;
    let Some(destination) = destination else {
        return Ok(None);
    };
    let destination = if destination.extension().is_none() {
        destination.with_extension("log")
    } else {
        destination
    };
    if destination == source {
        return Err("Choose a different location for the saved copy.".into());
    }
    std::fs::copy(&source, &destination)
        .map_err(|error| format!("Could not save a copy of the log: {error}"))?;
    Ok(Some(destination.display().to_string()))
}

/// Enables an explicitly requested, read-only companion page for one live
/// serial session. The listener is IPv4 LAN-only and exposes no route capable
/// of writing to the serial device.
#[tauri::command]
fn start_mobile_share(
    state: State<'_, SerialState>,
    session_id: String,
) -> CommandResult<MobileShareInfo> {
    let session_id = require_mobile_share_session_id(&session_id)?;
    let session = {
        let sessions = state.sessions.lock().map_err(lock_error)?;
        sessions
            .get(&session_id)
            .map(|session| session.info.clone())
            .ok_or_else(|| "This serial session is no longer active.".to_string())?
    };

    let mut shares = state.mobile_shares.lock().map_err(lock_error)?;
    if let Some(share) = shares.get(&session_id) {
        return Ok(active_mobile_share_info(&session_id, share));
    }

    let host = local_lan_ipv4()?;
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| format!("Could not start local mobile sharing: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not configure local mobile sharing: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not inspect local mobile sharing: {error}"))?
        .port();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let stop = Arc::new(AtomicBool::new(false));
    let clients = Arc::new(Mutex::new(HashMap::new()));
    let next_client_id = Arc::new(AtomicU64::new(1));
    let server_stop = Arc::clone(&stop);
    let server_clients = Arc::clone(&clients);
    let server_client_ids = Arc::clone(&next_client_id);
    let server_token = token.clone();
    let server_thread = thread::Builder::new()
        .name(format!("mobile-share-{}", &session_id[..8]))
        .spawn(move || {
            run_mobile_share_server(
                listener,
                session,
                server_token,
                server_stop,
                server_clients,
                server_client_ids,
            )
        })
        .map_err(|error| format!("Could not start local mobile sharing: {error}"))?;

    shares.insert(
        session_id.clone(),
        ActiveMobileShare {
            token: token.clone(),
            host: host.clone(),
            port,
            stop,
            clients,
            server_thread,
        },
    );
    Ok(MobileShareInfo {
        session_id,
        url: mobile_share_url(&host, port, &token),
        host,
        port,
        client_count: 0,
        enabled: true,
    })
}

#[tauri::command]
fn get_mobile_share_status(
    state: State<'_, SerialState>,
    session_id: String,
) -> CommandResult<MobileShareInfo> {
    let session_id = require_mobile_share_session_id(&session_id)?;
    {
        let sessions = state.sessions.lock().map_err(lock_error)?;
        if !sessions.contains_key(&session_id) {
            return Err("This serial session is no longer active.".into());
        }
    }
    let shares = state.mobile_shares.lock().map_err(lock_error)?;
    Ok(shares
        .get(&session_id)
        .map(|share| active_mobile_share_info(&session_id, share))
        .unwrap_or(MobileShareInfo {
            session_id,
            url: String::new(),
            host: String::new(),
            port: 0,
            client_count: 0,
            enabled: false,
        }))
}

#[tauri::command]
fn stop_mobile_share(
    state: State<'_, SerialState>,
    session_id: String,
) -> CommandResult<MobileShareInfo> {
    let session_id = require_mobile_share_session_id(&session_id)?;
    stop_mobile_share_for_session(&state.mobile_shares, &session_id);
    Ok(MobileShareInfo {
        session_id,
        url: String::new(),
        host: String::new(),
        port: 0,
        client_count: 0,
        enabled: false,
    })
}

fn require_mobile_share_session_id(session_id: &str) -> CommandResult<String> {
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id.len() > 128 {
        Err("Choose an active serial session first.".into())
    } else {
        Ok(session_id.into())
    }
}

fn active_mobile_share_info(session_id: &str, share: &ActiveMobileShare) -> MobileShareInfo {
    MobileShareInfo {
        session_id: session_id.into(),
        url: mobile_share_url(&share.host, share.port, &share.token),
        host: share.host.clone(),
        port: share.port,
        client_count: share
            .clients
            .lock()
            .map(|clients| clients.len())
            .unwrap_or(0),
        enabled: !share.stop.load(Ordering::Acquire),
    }
}

fn mobile_share_url(host: &str, port: u16, token: &str) -> String {
    format!("http://{host}:{port}/share/{token}")
}

/// Finds the interface selected by the operating system's default route. UDP
/// connect does not send a packet, but gives a dependable Wi-Fi/Ethernet LAN
/// address to encode in the QR URL.
fn local_lan_ipv4() -> CommandResult<String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| format!("Could not find a local network address: {error}"))?;
    socket
        .connect((Ipv4Addr::new(8, 8, 8, 8), 80))
        .map_err(|error| format!("Could not find a local network address: {error}"))?;
    match socket
        .local_addr()
        .map_err(|error| format!("Could not find a local network address: {error}"))?
        .ip()
    {
        IpAddr::V4(ip) if !ip.is_unspecified() && !ip.is_loopback() => Ok(ip.to_string()),
        _ => Err("Connect this computer to Wi-Fi or Ethernet before sharing with a phone.".into()),
    }
}

fn stop_mobile_share_for_session(
    shares: &Arc<Mutex<HashMap<String, ActiveMobileShare>>>,
    session_id: &str,
) {
    let share = shares
        .lock()
        .ok()
        .and_then(|mut shares| shares.remove(session_id));
    if let Some(share) = share {
        share.stop.store(true, Ordering::Release);
        let _ = share.server_thread.join();
    }
}

fn shutdown_mobile_shares(shares: &Arc<Mutex<HashMap<String, ActiveMobileShare>>>) {
    let shares = match shares.lock() {
        Ok(mut shares) => shares.drain().map(|(_, share)| share).collect::<Vec<_>>(),
        Err(_) => return,
    };
    for share in shares {
        share.stop.store(true, Ordering::Release);
        let _ = share.server_thread.join();
    }
}

fn run_mobile_share_server(
    listener: TcpListener,
    session: SessionInfo,
    token: String,
    stop: Arc<AtomicBool>,
    clients: Arc<Mutex<HashMap<u64, std::sync::mpsc::SyncSender<String>>>>,
    next_client_id: Arc<AtomicU64>,
) {
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, address)) => {
                if !is_local_network_peer(address) {
                    let _ = write_http_response(
                        &stream,
                        "403 Forbidden",
                        "text/plain; charset=utf-8",
                        b"Local network access only.\n",
                        &[],
                    );
                    let _ = stream.shutdown(Shutdown::Both);
                    continue;
                }
                let request_session = session.clone();
                let request_token = token.clone();
                let request_stop = Arc::clone(&stop);
                let request_clients = Arc::clone(&clients);
                let request_client_ids = Arc::clone(&next_client_id);
                let _ = thread::Builder::new()
                    .name("mobile-share-client".into())
                    .spawn(move || {
                        handle_mobile_share_connection(
                            stream,
                            request_session,
                            request_token,
                            request_stop,
                            request_clients,
                            request_client_ids,
                        )
                    });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(MOBILE_SHARE_ACCEPT_POLL)
            }
            Err(_) => break,
        }
    }
}

fn is_local_network_peer(address: SocketAddr) -> bool {
    match address.ip() {
        IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        IpAddr::V6(_) => false,
    }
}

fn handle_mobile_share_connection(
    mut stream: TcpStream,
    session: SessionInfo,
    token: String,
    stop: Arc<AtomicBool>,
    clients: Arc<Mutex<HashMap<u64, std::sync::mpsc::SyncSender<String>>>>,
    next_client_id: Arc<AtomicU64>,
) {
    let request = match read_mobile_share_request(&mut stream) {
        Ok(request) => request,
        Err(_) => {
            let _ = write_http_response(
                &stream,
                "400 Bad Request",
                "text/plain; charset=utf-8",
                b"Bad request.\n",
                &[],
            );
            return;
        }
    };
    let (method, path, headers) = request;
    let page_path = format!("/share/{token}");
    if method != "GET"
        || !constant_time_eq(path.as_bytes(), page_path.as_bytes())
            && !constant_time_eq(path.as_bytes(), format!("{page_path}/download").as_bytes())
            && !constant_time_eq(path.as_bytes(), format!("{page_path}/events").as_bytes())
    {
        let _ = write_http_response(
            &stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not found.\n",
            &[],
        );
        return;
    }
    if constant_time_eq(path.as_bytes(), page_path.as_bytes()) {
        let _ = write_http_response(
            &stream,
            "200 OK",
            "text/html; charset=utf-8",
            MOBILE_SHARE_PAGE.as_bytes(),
            &[
                ("Cache-Control", "no-store"),
                ("Referrer-Policy", "no-referrer"),
                ("X-Content-Type-Options", "nosniff"),
            ],
        );
    } else if path.ends_with("/download") {
        serve_mobile_share_download(&mut stream, &session.log_path);
    } else {
        serve_mobile_share_websocket(&mut stream, &headers, stop, clients, next_client_id);
    }
}

fn read_mobile_share_request(
    stream: &mut TcpStream,
) -> io::Result<(String, String, HashMap<String, String>)> {
    stream.set_read_timeout(Some(MOBILE_SHARE_WRITE_TIMEOUT))?;
    let mut bytes = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 1024];
    while bytes.len() < MOBILE_SHARE_REQUEST_BYTE_LIMIT {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "request ended",
            ));
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let request = std::str::from_utf8(&bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "request is not UTF-8"))?;
    let mut lines = request.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request line"))?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing method"))?
        .to_owned();
    let path = request_parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing path"))?
        .to_owned();
    if request_parts.next().is_none() || path.len() > MOBILE_SHARE_REQUEST_BYTE_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid request line",
        ));
    }
    let mut headers = HashMap::new();
    for line in lines.take_while(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid header"));
        };
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
    }
    Ok((method, path, headers))
}

fn write_http_response(
    stream: &TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    headers: &[(&str, &str)],
) -> io::Result<()> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        response.push_str(name);
        response.push_str(": ");
        response.push_str(value);
        response.push_str("\r\n");
    }
    response.push_str("\r\n");
    let mut stream = stream;
    stream.write_all(response.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn serve_mobile_share_download(stream: &mut TcpStream, log_path: &str) {
    let path = Path::new(log_path);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.contains('"') && !name.contains('\r') && !name.contains('\n'))
        .unwrap_or("serial-capture.log");
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            let _ = write_http_response(
                stream,
                "404 Not Found",
                "text/plain; charset=utf-8",
                b"Capture is no longer available.\n",
                &[],
            );
            return;
        }
    };
    let size = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(_) => {
            let _ = write_http_response(
                stream,
                "500 Internal Server Error",
                "text/plain; charset=utf-8",
                b"Could not read capture.\n",
                &[],
            );
            return;
        }
    };
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {size}\r\nContent-Disposition: attachment; filename=\"{file_name}\"\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(header.as_bytes()).is_err() {
        return;
    }
    let mut reader = BufReader::new(file);
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) if stream.write_all(&buffer[..count]).is_err() => break,
            Ok(_) => {}
        }
    }
    let _ = stream.flush();
}

fn serve_mobile_share_websocket(
    stream: &mut TcpStream,
    headers: &HashMap<String, String>,
    stop: Arc<AtomicBool>,
    clients: Arc<Mutex<HashMap<u64, std::sync::mpsc::SyncSender<String>>>>,
    next_client_id: Arc<AtomicU64>,
) {
    let key = headers
        .get("sec-websocket-key")
        .filter(|key| key.len() <= 128);
    let upgrade = headers
        .get("upgrade")
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let connection_upgrade = headers.get("connection").is_some_and(|value| {
        value
            .split(',')
            .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
    });
    if !upgrade || !connection_upgrade || key.is_none() {
        let _ = write_http_response(
            stream,
            "400 Bad Request",
            "text/plain; charset=utf-8",
            b"WebSocket upgrade required.\n",
            &[],
        );
        return;
    }
    let accept = websocket_accept_key(key.expect("checked above"));
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nCache-Control: no-store\r\n\r\n"
    );
    if stream.write_all(response.as_bytes()).is_err() || stream.flush().is_err() {
        return;
    }
    let client_id = next_client_id.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = std::sync::mpsc::sync_channel(128);
    let inserted = clients.lock().ok().and_then(|mut clients| {
        if clients.len() >= MOBILE_SHARE_CLIENT_LIMIT {
            None
        } else {
            clients.insert(client_id, sender);
            Some(())
        }
    });
    if inserted.is_none() {
        let _ = write_websocket_close(stream, 1013, "Too many viewers");
        return;
    }
    let _ = stream.set_write_timeout(Some(MOBILE_SHARE_WRITE_TIMEOUT));
    let mut last_heartbeat = Instant::now();
    while !stop.load(Ordering::Acquire) {
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(message) if write_websocket_text(stream, &message).is_err() => break,
            Ok(_) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                if last_heartbeat.elapsed() >= MOBILE_SHARE_HEARTBEAT =>
            {
                if write_websocket_frame(stream, 0x9, &[]).is_err() {
                    break;
                }
                last_heartbeat = Instant::now();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    if let Ok(mut clients) = clients.lock() {
        clients.remove(&client_id);
    }
    let _ = write_websocket_close(stream, 1000, "Sharing ended");
}

fn write_websocket_text(stream: &mut TcpStream, message: &str) -> io::Result<()> {
    write_websocket_frame(stream, 0x1, message.as_bytes())
}

fn write_websocket_close(stream: &mut TcpStream, code: u16, reason: &str) -> io::Result<()> {
    let mut payload = code.to_be_bytes().to_vec();
    payload.extend_from_slice(reason.as_bytes());
    write_websocket_frame(stream, 0x8, &payload)
}

fn write_websocket_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> io::Result<()> {
    let mut header = vec![0x80 | opcode];
    match payload.len() {
        length @ 0..=125 => header.push(length as u8),
        length @ 126..=65_535 => {
            header.push(126);
            header.extend_from_slice(&(length as u16).to_be_bytes());
        }
        length => {
            header.push(127);
            header.extend_from_slice(&(length as u64).to_be_bytes());
        }
    }
    stream.write_all(&header)?;
    stream.write_all(payload)?;
    stream.flush()
}

fn broadcast_mobile_serial_data(
    shares: &Arc<Mutex<HashMap<String, ActiveMobileShare>>>,
    event: &SerialDataEvent,
) {
    let payload = match serde_json::to_string(event) {
        Ok(payload) => payload,
        Err(_) => return,
    };
    let clients = match shares.lock() {
        Ok(shares) => shares
            .get(&event.session_id)
            .map(|share| Arc::clone(&share.clients)),
        Err(_) => None,
    };
    let Some(clients) = clients else {
        return;
    };
    if let Ok(mut clients) = clients.lock() {
        clients.retain(|_, sender| sender.try_send(payload.clone()).is_ok());
    };
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(*left.get(index).unwrap_or(&0) ^ *right.get(index).unwrap_or(&0));
    }
    difference == 0
}

fn websocket_accept_key(key: &str) -> String {
    let mut input = key.as_bytes().to_vec();
    input.extend_from_slice(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    base64_encode(&sha1_digest(&input))
}

// WebSocket's RFC 6455 handshake requires SHA-1. Keeping this tiny,
// self-contained implementation avoids pulling an HTTP server into the native
// desktop binary solely for this intentionally small, local-only endpoint.
fn sha1_digest(input: &[u8]) -> [u8; 20] {
    let bit_length = (input.len() as u64).wrapping_mul(8);
    let mut bytes = input.to_vec();
    bytes.push(0x80);
    while (bytes.len() + 8) % 64 != 0 {
        bytes.push(0);
    }
    bytes.extend_from_slice(&bit_length.to_be_bytes());
    let mut state = [
        0x6745_2301_u32,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    for chunk in bytes.chunks_exact(64) {
        let mut words = [0_u32; 80];
        for (index, word) in words.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes(
                chunk[index * 4..index * 4 + 4]
                    .try_into()
                    .expect("SHA-1 block"),
            );
        }
        for index in 16..80 {
            words[index] =
                (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16])
                    .rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) =
            (state[0], state[1], state[2], state[3], state[4]);
        for (index, word) in words.iter().enumerate() {
            let (function, constant) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let next = a
                .rotate_left(5)
                .wrapping_add(function)
                .wrapping_add(e)
                .wrapping_add(constant)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = next;
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
    }
    let mut output = [0_u8; 20];
    for (index, word) in state.iter().enumerate() {
        output[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    output
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        output.push(ALPHABET[(first >> 2) as usize] as char);
        output.push(ALPHABET[((first & 0x03) << 4 | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[((second & 0x0f) << 2 | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

const MOBILE_SHARE_PAGE: &str = r##"<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#111827"><title>BaudTide live log</title><style>body{margin:0;background:#111827;color:#e5e7eb;font:16px system-ui,sans-serif}main{max-width:900px;margin:auto;padding:16px}header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}h1{font-size:1.2rem;margin:0}#state{color:#93c5fd}a{color:#bfdbfe}pre{box-sizing:border-box;min-height:70vh;max-height:70vh;overflow:auto;white-space:pre-wrap;word-break:break-word;padding:14px;border:1px solid #374151;border-radius:8px;background:#030712;line-height:1.45}button{border:1px solid #4b5563;border-radius:6px;color:#e5e7eb;background:#1f2937;padding:8px 10px}</style><main><header><div><h1>BaudTide · live serial log</h1><span id="state">Connecting…</span></div><div><button id="pause">Pause</button> <a id="download" download>Download capture</a></div></header><pre id="log" aria-live="polite"></pre></main><script>(()=>{const log=document.querySelector('#log'),state=document.querySelector('#state'),pause=document.querySelector('#pause'),download=document.querySelector('#download');const base=location.pathname.replace(/\/$/,'');download.href=base+'/download';let paused=false;pause.onclick=()=>{paused=!paused;pause.textContent=paused?'Resume':'Pause'};const ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+base+'/events');ws.onopen=()=>state.textContent='Live · read-only';ws.onclose=()=>state.textContent='Disconnected · sharing ended';ws.onerror=()=>state.textContent='Connection error';ws.onmessage=e=>{if(paused)return;try{const item=JSON.parse(e.data);log.textContent+=item.text??'';if(log.textContent.length>500000)log.textContent=log.textContent.slice(-400000);log.scrollTop=log.scrollHeight}catch{}}})();</script>"##;

#[tauri::command]
fn start_serial_session(
    app: AppHandle,
    state: State<'_, SerialState>,
    request: StartSessionRequest,
) -> CommandResult<SessionInfo> {
    validate_request(&request)?;
    let configured_limit = load_application_settings(&app)?.storage.storage_limit_bytes;
    let current_library_bytes = capture_library_usage(&app)?;

    // Keep this lock through insertion. A reader can fail immediately after it starts;
    // holding the lock makes its failure cleanup wait until its own entry exists.
    let mut sessions = state.sessions.lock().map_err(lock_error)?;
    {
        let mut quota = state.capture_quota.lock().map_err(lock_error)?;
        quota.limit_bytes = configured_limit;
        if sessions.is_empty() {
            quota.used_bytes = current_library_bytes;
        }
        if quota.used_bytes >= quota.limit_bytes {
            return Err(format!(
                "Capture library is at its configured {} GiB limit. Move or remove saved logs, or raise the limit.",
                quota.limit_bytes / GIBIBYTE
            ));
        }
    }
    if sessions
        .values()
        .any(|session| session.info.port == request.port)
    {
        return Err(format!(
            "{} is already being monitored by BaudTide.",
            request.port
        ));
    }

    let configured_data_bits = data_bits(request.settings.data_bits)?;
    // Prove the physical port can be opened before creating any capture or
    // sidecar. Automatic reconnect may make many failed attempts while a cable
    // is unplugged; those attempts must not pollute the saved-log library.
    let port = serialport::new(&request.port, request.baud_rate)
        .timeout(READ_TIMEOUT)
        .data_bits(configured_data_bits)
        .parity(request.settings.parity.clone().into())
        .stop_bits(request.settings.stop_bits.clone().into())
        .flow_control(request.settings.flow_control.clone().into())
        .open()
        .map_err(|error| format!("Could not open {}: {error}", request.port))?;

    let reader = match port.try_clone() {
        Ok(reader) => reader,
        Err(error) => {
            return Err(format!(
                "Could not create a reader for {}: {error}",
                request.port
            ))
        }
    };
    let id = Uuid::new_v4().to_string();
    let log_path = resolve_log_path(&app, &request.session_name, &id)?;
    let info = SessionInfo {
        id: id.clone(),
        port: request.port.clone(),
        baud_rate: request.baud_rate,
        session_name: request.session_name.clone(),
        log_path: log_path.display().to_string(),
        state: "connected",
        settings: request.settings.clone(),
    };
    let mut index_record = LogIndexRecord::new(&info);
    let log_file = open_log_file(&log_path)?;
    // The port is opened, but no reader has started. Report the metadata
    // failure directly rather than creating a misleading error capture.
    write_log_index_record(&app, &index_record)?;
    update_log_index_state(&app, &mut index_record, "capturing", false)?;
    let stop = Arc::new(AtomicBool::new(false));
    let reader_stop = Arc::clone(&stop);
    let event_delivery = Arc::new(Mutex::new(SerialEventDelivery::Buffering {
        events: Vec::new(),
        buffered_bytes: 0,
        dropped_event_count: 0,
        next_sequence: 1,
    }));
    let reader_event_delivery = Arc::clone(&event_delivery);
    let reader_info = info.clone();
    let reader_app = app.clone();
    let reader_sessions = Arc::clone(&state.sessions);
    let reader_quota = Arc::clone(&state.capture_quota);
    let reader_mobile_shares = Arc::clone(&state.mobile_shares);
    let reader_thread = match thread::Builder::new()
        .name(format!("serial-reader-{}", &id[..8]))
        .spawn(move || {
            read_serial_loop(
                reader,
                log_file,
                reader_info,
                reader_stop,
                ReaderContext {
                    app: reader_app,
                    sessions: reader_sessions,
                    event_delivery: reader_event_delivery,
                    quota: reader_quota,
                    mobile_shares: reader_mobile_shares,
                },
            )
        }) {
        Ok(thread) => thread,
        Err(error) => {
            let _ = update_log_index_state(&app, &mut index_record, "error", true);
            return Err(format!("Could not start serial reader: {error}"));
        }
    };

    sessions.insert(
        id,
        ActiveSession {
            info: info.clone(),
            stop,
            writer: Arc::new(Mutex::new(Some(port))),
            event_delivery,
            reader_thread,
        },
    );
    emit_status(
        &app,
        &info,
        "connected",
        "Port opened and raw logging started.",
    );
    Ok(info)
}

#[tauri::command]
fn send_serial_text(
    state: State<'_, SerialState>,
    session_id: String,
    text: String,
) -> CommandResult<usize> {
    send_serial_bytes(state, session_id, text.into_bytes())
}

#[tauri::command]
fn send_serial_bytes(
    state: State<'_, SerialState>,
    session_id: String,
    bytes: Vec<u8>,
) -> CommandResult<usize> {
    let (port, stop, writer) = {
        let sessions = state.sessions.lock().map_err(lock_error)?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| "This serial session is no longer active.".to_string())?;
        (
            session.info.port.clone(),
            Arc::clone(&session.stop),
            Arc::clone(&session.writer),
        )
    };
    write_serial_bytes(writer.as_ref(), stop.as_ref(), &port, &bytes)
}

fn write_serial_bytes<W: Write>(
    writer: &Mutex<Option<W>>,
    stop: &AtomicBool,
    port: &str,
    bytes: &[u8],
) -> CommandResult<usize> {
    if bytes.len() > SERIAL_WRITE_BYTE_LIMIT {
        return Err(format!(
            "Serial writes are limited to {SERIAL_WRITE_BYTE_LIMIT} bytes."
        ));
    }
    let mut writer = writer.lock().map_err(lock_error)?;
    if stop.load(Ordering::Acquire) {
        return Err("This serial session is no longer active.".into());
    }
    let writer = writer
        .as_mut()
        .ok_or_else(|| "This serial session is no longer active.".to_string())?;
    writer
        .write_all(bytes)
        .and_then(|()| writer.flush())
        .map_err(|error| format!("Could not write to {port}: {error}"))?;
    Ok(bytes.len())
}

fn close_serial_writer<W>(writer: &Mutex<Option<W>>) -> CommandResult<()> {
    drop(writer.lock().map_err(lock_error)?.take());
    Ok(())
}

#[tauri::command]
fn disconnect_serial_session(
    app: AppHandle,
    state: State<'_, SerialState>,
    session_id: String,
) -> CommandResult<SessionInfo> {
    let (session, _closing_log) = {
        let mut sessions = state.sessions.lock().map_err(lock_error)?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| "This serial session is no longer active.".to_string())?;
        // Set this before removing the entry so a concurrent reader failure knows this
        // is a user-requested shutdown and must not emit a terminal error.
        session.stop.store(true, Ordering::Release);
        let closing_log = mark_log_closing(
            &state.closing_log_paths,
            path_key(Path::new(&session.info.log_path)),
        )?;
        let session = sessions
            .remove(&session_id)
            .expect("session existed while its state lock was held");
        (session, closing_log)
    };
    let info = session.info.clone();
    let ActiveSession {
        writer,
        reader_thread,
        ..
    } = session;
    let join_result = reader_thread
        .join()
        .map_err(|_| format!("Serial reader for {} stopped unexpectedly.", info.port));
    join_result?;
    stop_mobile_share_for_session(&state.mobile_shares, &info.id);
    // Wait for an in-flight write, then invalidate stale writer handles before
    // finalizing metadata and releasing the port.
    close_serial_writer(writer.as_ref())?;
    let message =
        disconnect_status_message(finalize_log_index_state(&app, &info.id, "disconnected"));
    emit_status(&app, &info, "disconnected", &message);
    Ok(info)
}

/// The serial handle is already released when this runs. Metadata is useful for
/// the saved-log library, but a corrupt or unwritable sidecar must never turn a
/// successful disconnect into a failed command or leave the UI reserving a port.
fn disconnect_status_message(finalization: CommandResult<()>) -> String {
    match finalization {
        Ok(()) => "Disconnected by user. The saved raw log was kept.".into(),
        Err(error) => format!(
            "Disconnected by user. The saved raw log was kept, but its metadata could not be finalized: {error}"
        ),
    }
}

fn read_serial_loop(
    reader: Box<dyn SerialPort>,
    log_file: File,
    info: SessionInfo,
    stop: Arc<AtomicBool>,
    context: ReaderContext,
) {
    let terminal_status = run_serial_capture_loop(
        reader,
        log_file,
        &info,
        stop.as_ref(),
        &context.quota,
        |event| {
            broadcast_mobile_serial_data(&context.mobile_shares, &event);
            deliver_serial_data(&context.app, &context.event_delivery, event);
        },
    );
    if let Some((status, message)) = terminal_status {
        if remove_failed_session(&context.sessions, &info) {
            stop_mobile_share_for_session(&context.mobile_shares, &info.id);
            let index_state = if status == "storage-limit" {
                "quota-reached"
            } else {
                "error"
            };
            let _ = finalize_log_index_state(&context.app, &info.id, index_state);
            emit_status(&context.app, &info, status, &message);
        }
    }
}

/// Reads one physical serial capture until the port fails, storage is exhausted,
/// or its owner requests shutdown. Keeping the kernel I/O, raw persistence, and
/// event ordering here makes the lifecycle independently testable with a PTY;
/// the caller owns UI delivery and terminal-session cleanup.
fn run_serial_capture_loop<F>(
    mut reader: Box<dyn SerialPort>,
    log_file: File,
    info: &SessionInfo,
    stop: &AtomicBool,
    quota: &Arc<Mutex<CaptureQuota>>,
    mut on_event: F,
) -> Option<(&'static str, String)>
where
    F: FnMut(SerialDataEvent),
{
    let mut log = BufWriter::new(log_file);
    let mut buffer = [0_u8; READ_BUFFER_SIZE];
    let mut terminal_status: Option<(&'static str, String)> = None;
    let mut next_sequence = 1_u64;
    let mut last_durable_sync = Instant::now();

    while !stop.load(Ordering::Acquire) {
        match reader.read(&mut buffer) {
            Ok(0) => continue,
            Ok(count) => {
                let bytes = &buffer[..count];
                let allowed = match quota.lock() {
                    Ok(mut quota) if quota.used_bytes < quota.limit_bytes => {
                        let allowed = bytes
                            .len()
                            .min((quota.limit_bytes - quota.used_bytes) as usize);
                        if allowed == 0 {
                            terminal_status = Some((
                                "storage-limit",
                                "Storage limit reached; logging stopped before exceeding the configured capture-library limit.".into(),
                            ));
                            break;
                        }
                        match log.write_all(&bytes[..allowed]).and_then(|()| log.flush()) {
                            Ok(())
                                if !capture_durability_sync_is_due(last_durable_sync.elapsed()) =>
                            {
                                quota.used_bytes = quota.used_bytes.saturating_add(allowed as u64);
                                allowed
                            }
                            Ok(()) => match log.get_ref().sync_data() {
                                Ok(()) => {
                                    last_durable_sync = Instant::now();
                                    quota.used_bytes =
                                        quota.used_bytes.saturating_add(allowed as u64);
                                    allowed
                                }
                                Err(error) => {
                                    // A failed sync can still have committed some or all
                                    // bytes. Reserve the full admission before stopping
                                    // so another session cannot exceed the shared limit.
                                    quota.used_bytes =
                                        quota.used_bytes.saturating_add(allowed as u64);
                                    if !stop.load(Ordering::Acquire) {
                                        terminal_status = Some((
                                            "error",
                                            format!("Could not durably sync the raw log: {error}"),
                                        ));
                                    }
                                    break;
                                }
                            },
                            Err(error) => {
                                // A failed flush can still have committed some or all
                                // bytes. Account for the whole admission so another
                                // session cannot exceed the shared hard limit.
                                quota.used_bytes = quota.used_bytes.saturating_add(allowed as u64);
                                if !stop.load(Ordering::Acquire) {
                                    terminal_status =
                                        Some(("error", format!("Logging failed: {error}")));
                                }
                                break;
                            }
                        }
                    }
                    Ok(_) => {
                        terminal_status = Some((
                            "storage-limit",
                            "Storage limit reached; logging stopped before exceeding the configured capture-library limit.".into(),
                        ));
                        break;
                    }
                    Err(_) => {
                        if !stop.load(Ordering::Acquire) {
                            terminal_status =
                                Some(("error", "Capture quota state is unavailable.".into()));
                        }
                        break;
                    }
                };
                let bytes = &bytes[..allowed];
                if allowed < count {
                    terminal_status = Some((
                        "storage-limit",
                        "Storage limit reached; logging stopped before exceeding the configured capture-library limit.".into(),
                    ));
                }
                if bytes.is_empty() {
                    if !stop.load(Ordering::Acquire) {
                        terminal_status =
                            Some(("error", "No serial bytes could be persisted.".into()));
                    }
                    break;
                }
                let event = SerialDataEvent {
                    session_id: info.id.clone(),
                    port: info.port.clone(),
                    sequence: next_sequence,
                    timestamp: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    text: String::from_utf8_lossy(bytes).into_owned(),
                    bytes: bytes.to_vec(),
                };
                next_sequence += 1;
                on_event(event);
                if terminal_status.is_some() {
                    break;
                }
            }
            Err(error)
                if error.kind() == io::ErrorKind::TimedOut
                    || error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => {
                if !stop.load(Ordering::Acquire) {
                    terminal_status = Some(("error", format!("Serial read failed: {error}")));
                }
                break;
            }
        }
    }
    if let Err(error) = log.flush().and_then(|()| log.get_ref().sync_data()) {
        if !stop.load(Ordering::Acquire) && terminal_status.is_none() {
            terminal_status = Some(("error", format!("Could not finalize the raw log: {error}")));
        }
    }

    // Close the reader and log before publishing a terminal failure. The state cleanup
    // below drops the writer held by the active session as well.
    drop(log);
    drop(reader);
    terminal_status
}

fn capture_durability_sync_is_due(elapsed_since_last_sync: Duration) -> bool {
    elapsed_since_last_sync >= CAPTURE_DURABILITY_SYNC_INTERVAL
}

fn deliver_serial_data(
    app: &AppHandle,
    event_delivery: &Arc<Mutex<SerialEventDelivery>>,
    event: SerialDataEvent,
) {
    if let Some(event) = buffer_serial_event(event_delivery, event) {
        let _ = app.emit("serial-data", event);
    }
}

/// Atomically either holds a serial event for the initial WebView handoff or
/// returns it for immediate delivery to a live listener.
fn buffer_serial_event(
    event_delivery: &Arc<Mutex<SerialEventDelivery>>,
    event: SerialDataEvent,
) -> Option<SerialDataEvent> {
    match event_delivery.lock() {
        Ok(mut delivery) => match &mut *delivery {
            SerialEventDelivery::Buffering {
                events,
                buffered_bytes,
                dropped_event_count,
                next_sequence,
            } => {
                *next_sequence = event.sequence.saturating_add(1);
                if buffered_bytes.saturating_add(event.bytes.len())
                    <= STARTUP_EVENT_BUFFER_BYTE_LIMIT
                {
                    *buffered_bytes += event.bytes.len();
                    events.push(event);
                } else {
                    *dropped_event_count += 1;
                }
                None
            }
            SerialEventDelivery::Live { next_sequence } => {
                *next_sequence = event.sequence.saturating_add(1);
                Some(event)
            }
        },
        // The reader must continue capturing even if an in-memory display
        // handoff lock is poisoned. The raw log remains the source of truth.
        Err(_) => None,
    }
}

/// Removes an entry only when its map key and embedded identity still agree. This
/// prevents an old reader from affecting a later session on the same port.
fn remove_session_by_identity<T>(
    sessions: &mut HashMap<String, T>,
    session_id: &str,
    is_current: impl FnOnce(&T) -> bool,
) -> Option<T> {
    let session = sessions.get(session_id)?;
    if !is_current(session) {
        return None;
    }
    sessions.remove(session_id)
}

/// Returns true only when this reader still owns the active entry. Dropping the
/// returned session releases its writer and detaches this reader's now-finished
/// join handle without touching any newer session.
fn remove_failed_session(
    sessions: &Arc<Mutex<HashMap<String, ActiveSession>>>,
    info: &SessionInfo,
) -> bool {
    let removed = match sessions.lock() {
        Ok(mut sessions) => remove_session_by_identity(&mut sessions, &info.id, |session| {
            session.info.id == info.id && !session.stop.load(Ordering::Acquire)
        }),
        Err(_) => None,
    };
    let Some(session) = removed else {
        return false;
    };
    // A sender can hold a writer Arc obtained before the map entry was
    // removed. Marking it stopped and taking the writer closes that race.
    session.stop.store(true, Ordering::Release);
    let _ = close_serial_writer(session.writer.as_ref());
    true
}

#[cfg(all(test, target_os = "linux"))]
mod pty_tests;

#[cfg(test)]
mod tests {
    use super::{
        activate_serial_event_delivery, capture_durability_sync_is_due, remove_session_by_identity,
        SerialDataEvent, SerialEventDelivery,
    };
    use super::{
        begin_saved_log_search, data_bits, disconnect_status_message, ensure_search_not_cancelled,
        generated_log_path, index_records_by_path, mark_log_closing,
        normalize_application_settings, rebuild_log_text_index_in_directory, release_capture_quota,
        remove_log_text_indexes_for_path_in_directory, saved_log_text_index_path,
        search_fresh_log_text_index_in_directory, search_raw_log,
        validate_preference_log_directory, websocket_accept_key, ApplicationSettings, CaptureQuota,
        FlowControlSetting, LogIndexRecord, ParitySetting, SavedLogTextIndexHeader, SerialSettings,
        SerialState, StartSessionRequest, StopBitsSetting, CAPTURE_DURABILITY_SYNC_INTERVAL,
        GIBIBYTE, SEARCH_CANCELLED_MESSAGE, SEARCH_INDEX_MAGIC, SEARCH_INDEX_SCHEMA_VERSION,
        SEARCH_PER_LOG_BYTE_LIMIT, SEARCH_READ_BUFFER_SIZE,
    };
    use std::{
        collections::HashMap,
        fs::File,
        io::Write,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };
    use uuid::Uuid;

    #[derive(Debug, PartialEq)]
    struct TestSession {
        id: String,
        port: String,
    }

    #[test]
    fn active_capture_sync_cadence_is_bounded_to_the_configured_interval() {
        assert!(!capture_durability_sync_is_due(
            CAPTURE_DURABILITY_SYNC_INTERVAL.saturating_sub(Duration::from_millis(1))
        ));
        assert!(capture_durability_sync_is_due(
            CAPTURE_DURABILITY_SYNC_INTERVAL
        ));
        assert!(capture_durability_sync_is_due(
            CAPTURE_DURABILITY_SYNC_INTERVAL.saturating_add(Duration::from_secs(1))
        ));
    }

    #[test]
    fn completed_or_cancelled_saved_log_searches_remove_their_cancellation_state() {
        let state = SerialState::default();

        let completed = begin_saved_log_search(&state, "completed-search").unwrap();
        assert_eq!(state.saved_log_searches.lock().unwrap().len(), 1);
        drop(completed);
        assert!(state.saved_log_searches.lock().unwrap().is_empty());

        let cancelled = begin_saved_log_search(&state, "cancelled-search").unwrap();
        cancelled.cancelled.store(true, Ordering::Release);
        assert_eq!(
            ensure_search_not_cancelled(Some(cancelled.cancelled.as_ref())),
            Err(SEARCH_CANCELLED_MESSAGE.into())
        );
        drop(cancelled);
        assert!(state.saved_log_searches.lock().unwrap().is_empty());
    }

    #[test]
    fn deleting_a_capture_releases_only_its_bytes_from_the_live_quota() {
        let mut quota = CaptureQuota {
            used_bytes: 1_024,
            limit_bytes: 4_096,
        };

        release_capture_quota(&mut quota, 256);
        assert_eq!(quota.used_bytes, 768);
        assert_eq!(quota.limit_bytes, 4_096);

        release_capture_quota(&mut quota, 2_048);
        assert_eq!(quota.used_bytes, 0);
    }

    #[test]
    fn disconnecting_capture_remains_protected_until_shutdown_finishes() {
        let paths = Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
        let guard = mark_log_closing(&paths, "/tmp/capture.log".into()).unwrap();

        assert!(paths.lock().unwrap().contains("/tmp/capture.log"));
        drop(guard);
        assert!(!paths.lock().unwrap().contains("/tmp/capture.log"));
    }

    #[test]
    fn completed_search_does_not_remove_a_replacement_with_the_same_identifier() {
        let state = SerialState::default();
        let original = begin_saved_log_search(&state, "reused-search-id").unwrap();
        let replacement = begin_saved_log_search(&state, "reused-search-id").unwrap();

        drop(original);
        let registered = state
            .saved_log_searches
            .lock()
            .unwrap()
            .get("reused-search-id")
            .cloned()
            .unwrap();
        assert!(Arc::ptr_eq(&registered, &replacement.cancelled));

        drop(replacement);
        assert!(state.saved_log_searches.lock().unwrap().is_empty());
    }

    #[test]
    fn failed_reader_cleanup_only_removes_its_own_session_identity() {
        let mut sessions = HashMap::from([
            (
                "old-session".into(),
                TestSession {
                    id: "old-session".into(),
                    port: "/dev/ttyUSB0".into(),
                },
            ),
            (
                "reconnected-session".into(),
                TestSession {
                    id: "reconnected-session".into(),
                    port: "/dev/ttyUSB0".into(),
                },
            ),
        ]);

        let removed = remove_session_by_identity(&mut sessions, "old-session", |session| {
            session.id == "old-session"
        });

        assert_eq!(removed.unwrap().port, "/dev/ttyUSB0");
        assert!(!sessions.contains_key("old-session"));
        assert_eq!(
            sessions.get("reconnected-session").unwrap().id,
            "reconnected-session"
        );
    }

    #[test]
    fn cleanup_does_not_remove_an_entry_with_a_mismatched_identity() {
        let mut sessions = HashMap::from([(
            "session-key".into(),
            TestSession {
                id: "replacement-session".into(),
                port: "/dev/ttyUSB0".into(),
            },
        )]);

        let removed = remove_session_by_identity(&mut sessions, "session-key", |session| {
            session.id == "session-key"
        });

        assert!(removed.is_none());
        assert!(sessions.contains_key("session-key"));
    }

    #[test]
    fn startup_serial_events_are_replayed_once_before_live_delivery() {
        let event = |sequence| SerialDataEvent {
            session_id: "session-1".into(),
            port: "/dev/ttyUSB0".into(),
            sequence,
            timestamp: "2026-07-20T10:00:00.000Z".into(),
            text: sequence.to_string(),
            bytes: vec![sequence as u8],
        };
        let mut delivery = SerialEventDelivery::Buffering {
            events: vec![event(1), event(2)],
            buffered_bytes: 2,
            dropped_event_count: 0,
            next_sequence: 3,
        };

        let replay = activate_serial_event_delivery(&mut delivery);

        assert_eq!(
            replay
                .events
                .iter()
                .map(|item| item.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(replay.next_sequence, 3);
        assert_eq!(replay.dropped_event_count, 0);
        assert!(matches!(
            delivery,
            SerialEventDelivery::Live { next_sequence: 3 }
        ));
        let second_handoff = activate_serial_event_delivery(&mut delivery);
        assert!(second_handoff.events.is_empty());
        assert_eq!(second_handoff.next_sequence, 3);
    }

    #[test]
    fn preference_normalization_repairs_invalid_fields_without_losing_valid_ones() {
        let settings = serde_json::from_str::<ApplicationSettings>(r#"{
          "version": 1,
          "serial": { "baudRate": 57600, "lineEnding": "invalid", "displayEncoding": "hex", "showTimestamps": false, "reconnectWhenDeviceReturns": false },
          "storage": { "logDirectory": "relative/logs", "storageLimitBytes": 7 },
          "appearance": { "theme": "light" }
        }"#).unwrap();

        let normalized = normalize_application_settings(settings);
        assert_eq!(normalized.serial.baud_rate, 57_600);
        assert_eq!(normalized.serial.line_ending, "lf");
        assert_eq!(normalized.serial.display_encoding, "hex");
        assert!(!normalized.serial.show_timestamps);
        assert!(!normalized.serial.reconnect_when_device_returns);
        assert_eq!(normalized.storage.log_directory, "");
        assert_eq!(normalized.storage.storage_limit_bytes, 10 * GIBIBYTE);
        assert_eq!(normalized.appearance.theme, "light");
    }

    #[test]
    fn preference_log_directory_validation_rejects_relative_paths() {
        assert!(validate_preference_log_directory("").is_ok());
        assert!(validate_preference_log_directory("/var/log/baudtide").is_ok());
        assert!(validate_preference_log_directory("relative/logs").is_err());
    }

    #[test]
    fn unknown_preference_schema_version_uses_safe_defaults() {
        let settings = serde_json::from_str::<ApplicationSettings>(r#"{ "version": 99 }"#).unwrap();
        assert_eq!(
            normalize_application_settings(settings),
            ApplicationSettings::default()
        );
    }

    #[test]
    fn index_record_round_trip_preserves_completed_session_metadata() {
        let record = LogIndexRecord {
            schema_version: 1,
            session_id: "session-42".into(),
            session_name: "Motor bench".into(),
            port: "/dev/ttyUSB0".into(),
            baud_rate: 115_200,
            settings: Some(SerialSettings::default()),
            started_at: "2026-07-20T10:00:00.000Z".into(),
            updated_at: "2026-07-20T10:01:00.000Z".into(),
            ended_at: Some("2026-07-20T10:01:00.000Z".into()),
            log_path: "/tmp/motor-bench.log".into(),
            state: "disconnected".into(),
        };

        let restored: LogIndexRecord =
            serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(restored.session_name, "Motor bench");
        assert_eq!(restored.port, "/dev/ttyUSB0");
        assert_eq!(restored.baud_rate, 115_200);
        assert_eq!(
            restored
                .settings
                .as_ref()
                .map(|settings| settings.data_bits),
            Some(8)
        );
        assert!(matches!(
            restored.settings.as_ref().map(|settings| &settings.parity),
            Some(ParitySetting::None)
        ));
        assert_eq!(restored.ended_at, record.ended_at);
        assert_eq!(restored.state, "disconnected");

        let mut legacy_json = serde_json::to_value(&record).unwrap();
        legacy_json
            .as_object_mut()
            .expect("metadata serializes to an object")
            .remove("settings");
        let legacy: LogIndexRecord = serde_json::from_value(legacy_json).unwrap();
        assert!(legacy.settings.is_none());
    }

    #[test]
    fn reconnection_uses_a_unique_log_and_sidecar_record_for_each_capture() {
        let directory = std::env::temp_dir();
        let first_id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
        let second_id = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
        let first_path = generated_log_path(&directory, "Motor bench", first_id);
        let second_path = generated_log_path(&directory, "Motor bench", second_id);

        assert_ne!(first_path, second_path);

        let records = vec![
            LogIndexRecord {
                schema_version: 1,
                session_id: first_id.into(),
                session_name: "Motor bench".into(),
                port: "/dev/ttyUSB0".into(),
                baud_rate: 115_200,
                settings: None,
                started_at: "2026-07-20T10:00:00.000Z".into(),
                updated_at: "2026-07-20T10:01:00.000Z".into(),
                ended_at: Some("2026-07-20T10:01:00.000Z".into()),
                log_path: first_path.display().to_string(),
                state: "disconnected".into(),
            },
            LogIndexRecord {
                schema_version: 1,
                session_id: second_id.into(),
                session_name: "Motor bench".into(),
                port: "/dev/ttyUSB0".into(),
                baud_rate: 115_200,
                settings: None,
                started_at: "2026-07-20T10:02:00.000Z".into(),
                updated_at: "2026-07-20T10:02:00.000Z".into(),
                ended_at: None,
                log_path: second_path.display().to_string(),
                state: "capturing".into(),
            },
        ];

        let indexed = index_records_by_path(records);
        assert_eq!(indexed.len(), 2);
        assert!(indexed
            .values()
            .any(|(_, record)| record.state == "disconnected"));
        assert!(indexed
            .values()
            .any(|(_, record)| record.state == "capturing"));
    }

    #[test]
    fn generated_capture_names_use_the_entire_session_uuid() {
        let directory = std::env::temp_dir();
        // These IDs share their first eight characters, which used to produce
        // the same filename and fail the second capture.
        let first = generated_log_path(
            &directory,
            "Motor bench",
            "aaaaaaaa-0000-4000-8000-000000000001",
        );
        let second = generated_log_path(
            &directory,
            "Motor bench",
            "aaaaaaaa-0000-4000-8000-000000000002",
        );

        assert_ne!(first, second);
        assert!(second
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("aaaaaaaa-0000-4000-8000-000000000002"));
    }

    #[test]
    fn serial_framing_request_deserializes_and_rejects_invalid_data_bits() {
        let request = serde_json::from_str::<StartSessionRequest>(
            r#"{
          "port": "/dev/ttyUSB0",
          "baudRate": 57600,
          "sessionName": "Sensor",
          "settings": {
            "dataBits": 7,
            "parity": "even",
            "stopBits": "two",
            "flowControl": "hardware"
          }
        }"#,
        )
        .unwrap();

        assert_eq!(request.settings.data_bits, 7);
        assert_eq!(request.settings.parity, ParitySetting::Even);
        assert_eq!(request.settings.stop_bits, StopBitsSetting::Two);
        assert_eq!(request.settings.flow_control, FlowControlSetting::Hardware);
        assert!(data_bits(request.settings.data_bits).is_ok());
        assert!(data_bits(9).is_err());
    }

    #[test]
    fn legacy_duplicate_sidecars_have_a_deterministic_latest_state() {
        let older = LogIndexRecord {
            schema_version: 1,
            session_id: "old-session".into(),
            session_name: "Motor bench".into(),
            port: "/dev/ttyUSB0".into(),
            baud_rate: 115_200,
            settings: None,
            started_at: "2026-07-20T10:00:00.000Z".into(),
            updated_at: "2026-07-20T10:00:00.000Z".into(),
            ended_at: None,
            log_path: "/tmp/legacy-capture.log".into(),
            state: "capturing".into(),
        };
        let newer = LogIndexRecord {
            updated_at: "2026-07-20T10:01:00.000Z".into(),
            ended_at: Some("2026-07-20T10:01:00.000Z".into()),
            session_id: "new-session".into(),
            state: "disconnected".into(),
            ..older.clone()
        };

        for records in [
            vec![older.clone(), newer.clone()],
            vec![newer.clone(), older.clone()],
        ] {
            let indexed = index_records_by_path(records);
            let (_, selected) = indexed.values().next().unwrap();
            assert_eq!(selected.session_id, "new-session");
            assert_eq!(selected.state, "disconnected");
        }
    }

    #[test]
    fn failed_sidecar_finalization_does_not_turn_disconnect_into_an_error() {
        let message = disconnect_status_message(Err("Could not decode saved-log metadata".into()));
        assert!(message.starts_with("Disconnected by user."));
        assert!(message.contains("metadata could not be finalized"));
    }

    #[test]
    fn bounded_raw_search_finds_case_insensitive_matches_across_read_boundaries() {
        let path = std::env::temp_dir().join(format!("baudtide-search-{}.log", Uuid::new_v4()));
        let mut file = File::create(&path).unwrap();
        file.write_all(&vec![b'x'; SEARCH_READ_BUFFER_SIZE - 3])
            .unwrap();
        file.write_all(b"NEEDLE after-boundary").unwrap();
        file.flush().unwrap();

        let (count, matches, scanned, truncated) =
            search_raw_log(&path, b"needle", SEARCH_READ_BUFFER_SIZE as u64 + 32, None).unwrap();
        std::fs::remove_file(&path).unwrap();

        assert_eq!(count, 1);
        assert_eq!(
            matches[0].byte_offset,
            Some((SEARCH_READ_BUFFER_SIZE - 3) as u64)
        );
        assert!(matches[0].snippet.as_deref().unwrap().contains("NEEDLE"));
        assert!(scanned <= SEARCH_READ_BUFFER_SIZE as u64 + 32);
        assert!(!truncated);
    }

    #[test]
    fn raw_search_reports_when_a_file_was_only_partially_scanned() {
        let path =
            std::env::temp_dir().join(format!("baudtide-search-limit-{}.log", Uuid::new_v4()));
        let mut file = File::create(&path).unwrap();
        file.write_all(b"needle").unwrap();
        file.write_all(&[b'x'; 64]).unwrap();
        file.flush().unwrap();

        let (count, _, scanned, truncated) = search_raw_log(&path, b"needle", 6, None).unwrap();
        std::fs::remove_file(&path).unwrap();

        assert_eq!(count, 1);
        assert_eq!(scanned, 6);
        assert!(truncated);
    }

    #[test]
    fn full_raw_search_scans_beyond_the_quick_search_limit() {
        let path =
            std::env::temp_dir().join(format!("baudtide-full-search-{}.log", Uuid::new_v4()));
        let mut file = File::create(&path).unwrap();
        file.write_all(&vec![b'x'; (SEARCH_READ_BUFFER_SIZE * 20) + 17])
            .unwrap();
        file.write_all(b"needle at the end").unwrap();
        file.flush().unwrap();

        let (count, matches, scanned, truncated) =
            search_raw_log(&path, b"needle", u64::MAX, None).unwrap();
        std::fs::remove_file(&path).unwrap();

        assert_eq!(count, 1);
        assert!(scanned > SEARCH_PER_LOG_BYTE_LIMIT);
        assert!(!truncated);
        assert!(matches[0].snippet.as_deref().unwrap().contains("needle"));
    }

    #[test]
    fn raw_search_stops_when_cancelled_without_writing_the_capture() {
        let path =
            std::env::temp_dir().join(format!("baudtide-search-cancel-{}.log", Uuid::new_v4()));
        let original = vec![b'x'; SEARCH_READ_BUFFER_SIZE * 2];
        std::fs::write(&path, &original).unwrap();
        let cancelled = Arc::new(AtomicBool::new(true));

        let error = match search_raw_log(&path, b"needle", u64::MAX, Some(&cancelled)) {
            Ok(_) => panic!("a cancelled search should not return results"),
            Err(error) => error,
        };

        assert_eq!(error, super::SEARCH_CANCELLED_MESSAGE);
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn text_index_rebuild_is_fresh_then_falls_back_when_source_changes() {
        let root = std::env::temp_dir().join(format!("baudtide-text-index-{}", Uuid::new_v4()));
        let index_directory = root.join("index");
        std::fs::create_dir_all(&root).unwrap();
        let log = root.join("capture.log");
        std::fs::write(&log, b"Boot: NEEDLE\n").unwrap();

        assert!(
            rebuild_log_text_index_in_directory(&index_directory, &log, u64::MAX, None).unwrap()
        );
        let fresh =
            search_fresh_log_text_index_in_directory(&index_directory, &log, b"needle", None)
                .unwrap()
                .expect("a newly built index should be usable");
        assert_eq!(fresh.0, 1);
        assert!(!fresh.3);
        assert!(fresh.1[0].snippet.as_deref().unwrap().contains("NEEDLE"));

        std::fs::write(&log, b"changed capture").unwrap();
        assert!(
            search_fresh_log_text_index_in_directory(&index_directory, &log, b"needle", None)
                .unwrap()
                .is_none()
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn corrupt_or_missing_text_index_safely_falls_back_and_cleanup_removes_matching_cache() {
        let root =
            std::env::temp_dir().join(format!("baudtide-text-index-cleanup-{}", Uuid::new_v4()));
        let index_directory = root.join("index");
        std::fs::create_dir_all(&root).unwrap();
        let log = root.join("capture.log");
        std::fs::write(&log, b"indexed text").unwrap();
        let key = super::path_key(&log);
        let index = saved_log_text_index_path(&index_directory, &key);

        assert!(
            search_fresh_log_text_index_in_directory(&index_directory, &log, b"indexed", None)
                .unwrap()
                .is_none()
        );
        std::fs::create_dir_all(&index_directory).unwrap();
        std::fs::write(&index, b"damaged cache").unwrap();
        assert!(
            search_fresh_log_text_index_in_directory(&index_directory, &log, b"indexed", None)
                .unwrap()
                .is_none()
        );
        assert!(
            rebuild_log_text_index_in_directory(&index_directory, &log, u64::MAX, None).unwrap()
        );
        remove_log_text_indexes_for_path_in_directory(&index_directory, &key).unwrap();
        assert!(!index.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn deleting_a_capture_cleans_up_a_parseable_prior_schema_text_index() {
        let root =
            std::env::temp_dir().join(format!("baudtide-text-index-upgrade-{}", Uuid::new_v4()));
        let index_directory = root.join("index");
        std::fs::create_dir_all(&index_directory).unwrap();
        let log = root.join("capture.log");
        std::fs::write(&log, b"old index format").unwrap();
        let key = super::path_key(&log);
        let index = saved_log_text_index_path(&index_directory, &key);
        let header = SavedLogTextIndexHeader {
            schema_version: SEARCH_INDEX_SCHEMA_VERSION - 1,
            log_path: log.display().to_string(),
            source_size: 0,
            modified_seconds: 0,
            modified_nanos: 0,
        };
        let encoded_header = serde_json::to_vec(&header).unwrap();
        let mut file = File::create(&index).unwrap();
        file.write_all(SEARCH_INDEX_MAGIC).unwrap();
        file.write_all(&(encoded_header.len() as u64).to_le_bytes())
            .unwrap();
        file.write_all(&encoded_header).unwrap();
        file.write_all(b"obsolete derived bytes").unwrap();
        file.flush().unwrap();

        remove_log_text_indexes_for_path_in_directory(&index_directory, &key).unwrap();
        assert!(!index.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn cancelling_text_index_rebuild_leaves_the_raw_capture_untouched() {
        let root =
            std::env::temp_dir().join(format!("baudtide-text-index-cancel-{}", Uuid::new_v4()));
        let index_directory = root.join("index");
        std::fs::create_dir_all(&root).unwrap();
        let log = root.join("capture.log");
        let original = vec![b'x'; SEARCH_READ_BUFFER_SIZE * 2];
        std::fs::write(&log, &original).unwrap();
        let cancelled = AtomicBool::new(true);

        assert_eq!(
            rebuild_log_text_index_in_directory(&index_directory, &log, u64::MAX, Some(&cancelled))
                .unwrap_err(),
            SEARCH_CANCELLED_MESSAGE,
        );
        assert_eq!(std::fs::read(&log).unwrap(), original);
        assert!(
            !index_directory.exists()
                || std::fs::read_dir(&index_directory)
                    .unwrap()
                    .next()
                    .is_none()
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn websocket_handshake_accept_key_matches_rfc_6455() {
        assert_eq!(
            websocket_accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }
}

fn port_metadata(port: serialport::SerialPortInfo) -> AvailablePort {
    let mut label = port.port_name.clone();
    let mut manufacturer = None;
    let mut product = None;
    let mut serial_number = None;
    let transport = match port.port_type {
        SerialPortType::UsbPort(info) => {
            manufacturer = info.manufacturer;
            product = info.product;
            serial_number = info.serial_number;
            label = product
                .clone()
                .or(manufacturer.clone())
                .unwrap_or_else(|| "USB serial device".into());
            "usb"
        }
        SerialPortType::BluetoothPort => "bluetooth",
        SerialPortType::PciPort => "pci",
        SerialPortType::Unknown => "unknown",
    };
    AvailablePort {
        path: port.port_name,
        label,
        manufacturer,
        product,
        serial_number,
        transport: transport.into(),
    }
}

fn validate_request(request: &StartSessionRequest) -> CommandResult<()> {
    let port = request.port.trim();
    if port.is_empty() {
        return Err("Choose a serial port first.".into());
    }
    if port.len() > PORT_PATH_BYTE_LIMIT || !valid_serial_port(port) {
        return Err("Choose a valid serial-port device path.".into());
    }
    if !(300..=4_000_000).contains(&request.baud_rate) {
        return Err("Baud rate must be between 300 and 4,000,000.".into());
    }
    if request.session_name.trim().is_empty()
        || request.session_name.len() > SESSION_NAME_BYTE_LIMIT
    {
        return Err("Give the serial session a name.".into());
    }
    Ok(())
}

fn valid_serial_port(port: &str) -> bool {
    if serialport::available_ports()
        .ok()
        .is_some_and(|ports| ports.iter().any(|candidate| candidate.port_name == port))
    {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        return [
            "/dev/tty",
            "/dev/rfcomm",
            "/dev/serial/by-id/",
            "/dev/serial/by-path/",
        ]
        .iter()
        .any(|prefix| port.starts_with(prefix))
            && !Path::new(port)
                .components()
                .any(|component| component == std::path::Component::ParentDir);
    }
    #[cfg(target_os = "macos")]
    {
        return port.starts_with("/dev/tty.") || port.starts_with("/dev/cu.");
    }
    #[cfg(target_os = "windows")]
    {
        return port.len() <= 7 && port.to_ascii_uppercase().starts_with("COM");
    }
    #[allow(unreachable_code)]
    false
}

fn data_bits(value: u8) -> CommandResult<DataBits> {
    match value {
        5 => Ok(DataBits::Five),
        6 => Ok(DataBits::Six),
        7 => Ok(DataBits::Seven),
        8 => Ok(DataBits::Eight),
        _ => Err("Data bits must be 5, 6, 7, or 8.".into()),
    }
}

fn resolve_log_path(app: &AppHandle, session_name: &str, id: &str) -> CommandResult<PathBuf> {
    let directory = saved_log_directory_for_capture(app)?;
    Ok(generated_log_path(&directory, session_name, id))
}

fn generated_log_path(directory: &Path, session_name: &str, id: &str) -> PathBuf {
    let safe_name: String = session_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect();
    let safe_name = safe_name.trim_matches('-');
    let safe_name = if safe_name.is_empty() {
        "serial-capture"
    } else {
        safe_name
    };
    // A full UUID keeps the human-readable session name while guaranteeing
    // that separate captures cannot collide on their generated filename.
    directory.join(format!("{safe_name}-{id}.log"))
}

fn saved_log_directory_for_capture(app: &AppHandle) -> CommandResult<PathBuf> {
    let configured = load_application_settings(app)?.storage.log_directory;
    if configured.is_empty() {
        return log_directory(app);
    }
    let directory = PathBuf::from(configured)
        .canonicalize()
        .map_err(|error| format!("Could not use the selected log folder: {error}"))?;
    if directory.is_dir() {
        Ok(directory)
    } else {
        Err(
            "The selected log folder is no longer available. Choose another folder in Preferences."
                .into(),
        )
    }
}

fn log_directory(app: &AppHandle) -> CommandResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Could not find the app-data directory: {error}"))
        .map(|directory| directory.join("logs"))
}

fn settings_path(app: &AppHandle) -> CommandResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Could not find the app-data directory: {error}"))
        .map(|directory| directory.join("preferences-v1.json"))
}

fn load_application_settings(app: &AppHandle) -> CommandResult<ApplicationSettings> {
    let path = settings_path(app)?;
    match std::fs::read(&path) {
        Ok(contents) => Ok(serde_json::from_slice::<ApplicationSettings>(&contents)
            .map(normalize_application_settings)
            .unwrap_or_default()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(ApplicationSettings::default()),
        // Preferences must never prevent the serial workspace from starting. A damaged or
        // unreadable settings file safely falls back to the versioned defaults.
        Err(_) => Ok(ApplicationSettings::default()),
    }
}

fn save_application_settings(app: &AppHandle, settings: &ApplicationSettings) -> CommandResult<()> {
    let path = settings_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not find the application settings folder.".to_string())?;
    create_dir_all(parent)
        .map_err(|error| format!("Could not create the application settings folder: {error}"))?;
    let temporary = parent.join(format!(".preferences-v1-{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Could not encode preferences: {error}"))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Could not write preferences: {error}"))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("Could not finish writing preferences: {error}"))?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not publish preferences: {error}"))
}

fn normalize_application_settings(mut settings: ApplicationSettings) -> ApplicationSettings {
    if settings.version != SETTINGS_VERSION {
        return ApplicationSettings::default();
    }
    let defaults = ApplicationSettings::default();
    if ![9_600, 57_600, 115_200, 230_400].contains(&settings.serial.baud_rate) {
        settings.serial.baud_rate = defaults.serial.baud_rate;
    }
    if !matches!(
        settings.serial.line_ending.as_str(),
        "lf" | "crlf" | "cr" | "none"
    ) {
        settings.serial.line_ending = defaults.serial.line_ending;
    }
    if !matches!(
        settings.serial.display_encoding.as_str(),
        "utf8" | "ascii" | "hex"
    ) {
        settings.serial.display_encoding = defaults.serial.display_encoding;
    }
    let directory = settings.storage.log_directory.trim();
    settings.storage.log_directory = if directory.is_empty() || Path::new(directory).is_absolute() {
        directory.into()
    } else {
        String::new()
    };
    if ![2 * GIBIBYTE, 5 * GIBIBYTE, 10 * GIBIBYTE, 25 * GIBIBYTE]
        .contains(&settings.storage.storage_limit_bytes)
    {
        settings.storage.storage_limit_bytes = defaults.storage.storage_limit_bytes;
    }
    if !matches!(settings.appearance.theme.as_str(), "dark" | "light") {
        settings.appearance.theme = defaults.appearance.theme;
    }
    settings
}

fn log_index_directory(app: &AppHandle) -> CommandResult<PathBuf> {
    log_directory(app).map(|directory| directory.join("index"))
}

impl LogIndexRecord {
    fn new(info: &SessionInfo) -> Self {
        let now = now_timestamp();
        Self {
            // The added framing field is optional, so this remains compatible
            // with existing version-1 sidecars and their index readers.
            schema_version: 1,
            session_id: info.id.clone(),
            session_name: info.session_name.clone(),
            port: info.port.clone(),
            baud_rate: info.baud_rate,
            settings: Some(info.settings.clone()),
            started_at: now.clone(),
            updated_at: now,
            ended_at: None,
            log_path: info.log_path.clone(),
            state: "starting".into(),
        }
    }
}

fn now_timestamp() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn log_index_path(app: &AppHandle, session_id: &str) -> CommandResult<PathBuf> {
    if !session_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Invalid saved-log session identifier.".into());
    }
    Ok(log_index_directory(app)?.join(format!("{session_id}.json")))
}

/// Atomically replaces only the small metadata sidecar. It never moves or
/// changes the raw capture file, which may still be open by the serial reader.
fn write_log_index_record(app: &AppHandle, record: &LogIndexRecord) -> CommandResult<()> {
    let path = log_index_path(app, &record.session_id)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not find the saved-log index folder.".to_string())?;
    create_dir_all(parent)
        .map_err(|error| format!("Could not create the saved-log index folder: {error}"))?;
    let temporary = parent.join(format!(".{}-{}.tmp", record.session_id, Uuid::new_v4()));
    let serialized = serde_json::to_vec_pretty(record)
        .map_err(|error| format!("Could not encode saved-log metadata: {error}"))?;
    let result = (|| -> CommandResult<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Could not write saved-log metadata: {error}"))?;
        file.write_all(&serialized)
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("Could not finish saved-log metadata: {error}"))?;
        std::fs::rename(&temporary, &path)
            .map_err(|error| format!("Could not publish saved-log metadata: {error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn update_log_index_state(
    app: &AppHandle,
    record: &mut LogIndexRecord,
    state: &str,
    ended: bool,
) -> CommandResult<()> {
    record.state = state.into();
    record.updated_at = now_timestamp();
    if ended {
        record.ended_at = Some(record.updated_at.clone());
    }
    write_log_index_record(app, record)
}

fn finalize_log_index_state(app: &AppHandle, session_id: &str, state: &str) -> CommandResult<()> {
    let path = log_index_path(app, session_id)?;
    let contents = std::fs::read(&path)
        .map_err(|error| format!("Could not read saved-log metadata: {error}"))?;
    let mut record: LogIndexRecord = serde_json::from_slice(&contents)
        .map_err(|error| format!("Could not decode saved-log metadata: {error}"))?;
    update_log_index_state(app, &mut record, state, true)
}

fn read_log_index_records(app: &AppHandle) -> CommandResult<Vec<LogIndexRecord>> {
    let directory = log_index_directory(app)?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for entry in read_dir(&directory)
        .map_err(|error| format!("Could not read the saved-log index: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Could not read saved-log metadata: {error}"))?;
        let path = entry.path();
        if !path.is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("json")
        {
            continue;
        }
        // A corrupt sidecar must not hide other captures or make raw logs unusable.
        if let Ok(contents) = std::fs::read(&path) {
            if let Ok(record) = serde_json::from_slice::<LogIndexRecord>(&contents) {
                if record.schema_version == 1 {
                    records.push(record);
                }
            }
        }
    }
    Ok(records)
}

/// Delete only metadata records that belong to a raw capture just removed from
/// the managed library. A corrupt or unrelated sidecar is deliberately left
/// alone; it cannot make arbitrary files deletable.
fn remove_log_index_records_for_path(app: &AppHandle, log_key: &str) -> CommandResult<()> {
    let directory = log_index_directory(app)?;
    if !directory.exists() {
        return Ok(());
    }
    for entry in read_dir(&directory)
        .map_err(|error| format!("Could not read the saved-log index: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Could not read saved-log metadata: {error}"))?;
        let sidecar_path = entry.path();
        if !sidecar_path.is_file()
            || sidecar_path
                .extension()
                .and_then(|extension| extension.to_str())
                != Some("json")
        {
            continue;
        }
        let Ok(contents) = std::fs::read(&sidecar_path) else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<LogIndexRecord>(&contents) else {
            continue;
        };
        if record.schema_version == 1 && path_key(Path::new(&record.log_path)) == log_key {
            std::fs::remove_file(&sidecar_path).map_err(|error| {
                format!(
                    "The capture was deleted, but its saved-log metadata could not be removed: {error}"
                )
            })?;
        }
    }
    Ok(())
}

/// Text indexes live under BaudTide's app data, never in a user-selected
/// capture folder. They are disposable derived data, unlike the metadata
/// sidecars which describe a session lifecycle.
fn saved_log_text_index_directory(app: &AppHandle) -> CommandResult<PathBuf> {
    log_directory(app).map(|directory| directory.join("search-index"))
}

fn saved_log_text_index_path(directory: &Path, log_key: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    log_key.hash(&mut hasher);
    directory.join(format!("{:016x}.idx", hasher.finish()))
}

fn saved_log_fingerprint(path: &Path) -> io::Result<SavedLogFingerprint> {
    let metadata = path.metadata()?;
    let modified = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    Ok(SavedLogFingerprint {
        size: metadata.len(),
        modified_seconds: modified.as_secs(),
        modified_nanos: modified.subsec_nanos(),
    })
}

fn text_index_header_matches(
    header: &SavedLogTextIndexHeader,
    path: &Path,
    fingerprint: SavedLogFingerprint,
) -> bool {
    header.schema_version == SEARCH_INDEX_SCHEMA_VERSION
        && path_key(Path::new(&header.log_path)) == path_key(path)
        && header.source_size == fingerprint.size
        && header.modified_seconds == fingerprint.modified_seconds
        && header.modified_nanos == fingerprint.modified_nanos
}

fn read_saved_log_text_index_header(file: &mut File) -> io::Result<SavedLogTextIndexHeader> {
    let mut magic = vec![0_u8; SEARCH_INDEX_MAGIC.len()];
    file.read_exact(&mut magic)?;
    if magic != SEARCH_INDEX_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unknown search-index format",
        ));
    }
    let mut length = [0_u8; 8];
    file.read_exact(&mut length)?;
    let length = u64::from_le_bytes(length);
    if length > 64 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "search-index header is too large",
        ));
    }
    let mut header = vec![0_u8; length as usize];
    file.read_exact(&mut header)?;
    serde_json::from_slice(&header)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn search_fresh_log_text_index(
    app: &AppHandle,
    path: &Path,
    needle: &[u8],
    cancellation: Option<&AtomicBool>,
) -> CommandResult<Option<SavedLogContentSearch>> {
    search_fresh_log_text_index_in_directory(
        &saved_log_text_index_directory(app)?,
        path,
        needle,
        cancellation,
    )
}

fn search_fresh_log_text_index_in_directory(
    directory: &Path,
    path: &Path,
    needle: &[u8],
    cancellation: Option<&AtomicBool>,
) -> CommandResult<Option<SavedLogContentSearch>> {
    let fingerprint = match saved_log_fingerprint(path) {
        Ok(fingerprint) => fingerprint,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not inspect {} for search: {error}",
                path.display()
            ))
        }
    };
    let index_path = saved_log_text_index_path(directory, &path_key(path));
    let mut file = match File::open(index_path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        // A damaged cache is disposable. Fall back to the raw capture.
        Err(_) => return Ok(None),
    };
    let header = match read_saved_log_text_index_header(&mut file) {
        Ok(header) => header,
        Err(_) => return Ok(None),
    };
    if !text_index_header_matches(&header, path, fingerprint) {
        return Ok(None);
    }
    let search = search_log_reader(
        BufReader::with_capacity(SEARCH_READ_BUFFER_SIZE, file),
        header.source_size,
        needle,
        header.source_size,
        cancellation,
    )?;
    // Short/corrupt cache data is never authoritative, even if it happened to
    // contain a match. Recheck the raw fingerprint so a concurrent change or
    // deletion cannot return an obsolete path.
    if search.3 || saved_log_fingerprint(path).ok() != Some(fingerprint) {
        return Ok(None);
    }
    Ok(Some(search))
}

/// Rebuilds only derived data. A false result means the source moved, changed,
/// or exceeded this request's update budget; the caller already searched the
/// raw capture and can safely continue.
fn rebuild_log_text_index(
    app: &AppHandle,
    path: &Path,
    byte_limit: u64,
    cancellation: Option<&AtomicBool>,
) -> CommandResult<bool> {
    rebuild_log_text_index_in_directory(
        &saved_log_text_index_directory(app)?,
        path,
        byte_limit,
        cancellation,
    )
}

fn rebuild_log_text_index_in_directory(
    directory: &Path,
    path: &Path,
    byte_limit: u64,
    cancellation: Option<&AtomicBool>,
) -> CommandResult<bool> {
    let fingerprint = match saved_log_fingerprint(path) {
        Ok(fingerprint) => fingerprint,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Could not inspect {} for indexing: {error}",
                path.display()
            ))
        }
    };
    if fingerprint.size > byte_limit {
        return Ok(false);
    }
    create_dir_all(directory)
        .map_err(|error| format!("Could not create saved-log search index: {error}"))?;
    let final_path = saved_log_text_index_path(directory, &path_key(path));
    let temporary = directory.join(format!(".{}-{}.tmp", Uuid::new_v4(), "search"));
    let result = (|| -> CommandResult<bool> {
        let mut source = BufReader::with_capacity(
            SEARCH_READ_BUFFER_SIZE,
            File::open(path).map_err(|error| {
                format!("Could not open {} for indexing: {error}", path.display())
            })?,
        );
        let header = SavedLogTextIndexHeader {
            schema_version: SEARCH_INDEX_SCHEMA_VERSION,
            log_path: path.display().to_string(),
            source_size: fingerprint.size,
            modified_seconds: fingerprint.modified_seconds,
            modified_nanos: fingerprint.modified_nanos,
        };
        let encoded_header = serde_json::to_vec(&header)
            .map_err(|error| format!("Could not encode saved-log search index: {error}"))?;
        let mut output = BufWriter::with_capacity(
            SEARCH_READ_BUFFER_SIZE,
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| format!("Could not write saved-log search index: {error}"))?,
        );
        output
            .write_all(SEARCH_INDEX_MAGIC)
            .and_then(|()| output.write_all(&(encoded_header.len() as u64).to_le_bytes()))
            .and_then(|()| output.write_all(&encoded_header))
            .map_err(|error| format!("Could not initialize saved-log search index: {error}"))?;
        let mut remaining = fingerprint.size;
        let mut buffer = vec![0_u8; SEARCH_READ_BUFFER_SIZE];
        while remaining > 0 {
            ensure_search_not_cancelled(cancellation)?;
            let read_limit = remaining.min(buffer.len() as u64) as usize;
            let count = source.read(&mut buffer[..read_limit]).map_err(|error| {
                format!("Could not read {} for indexing: {error}", path.display())
            })?;
            if count == 0 {
                return Ok(false);
            }
            output
                .write_all(&buffer[..count])
                .map_err(|error| format!("Could not write saved-log search index: {error}"))?;
            remaining -= count as u64;
        }
        output
            .flush()
            .and_then(|()| output.get_ref().sync_all())
            .map_err(|error| format!("Could not finish saved-log search index: {error}"))?;
        if saved_log_fingerprint(path).ok() != Some(fingerprint) {
            return Ok(false);
        }
        if let Err(first_error) = std::fs::rename(&temporary, &final_path) {
            // Windows does not replace an existing file with rename. The
            // existing target is disposable cache data and has already been
            // proven stale or unreadable by the caller.
            if !final_path.is_file() {
                return Err(format!(
                    "Could not publish saved-log search index: {first_error}"
                ));
            }
            std::fs::remove_file(&final_path)
                .and_then(|()| std::fs::rename(&temporary, &final_path))
                .map_err(|error| format!("Could not publish saved-log search index: {error}"))?;
        }
        Ok(true)
    })();
    if result.is_err() || !result.as_ref().is_ok_and(|rebuilt| *rebuilt) {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// Best-effort cleanup for disposable caches. Corrupt cache files are left
/// alone here; they are ignored and rebuilt on demand.
fn remove_log_text_indexes_for_path(app: &AppHandle, log_key: &str) -> CommandResult<()> {
    remove_log_text_indexes_for_path_in_directory(&saved_log_text_index_directory(app)?, log_key)
}

fn remove_log_text_indexes_for_path_in_directory(
    directory: &Path,
    log_key: &str,
) -> CommandResult<()> {
    if !directory.exists() {
        return Ok(());
    }
    for entry in read_dir(directory)
        .map_err(|error| format!("Could not read saved-log search index: {error}"))?
    {
        let entry = entry
            .map_err(|error| format!("Could not read saved-log search index entry: {error}"))?;
        let path = entry.path();
        if !path.is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("idx")
        {
            continue;
        }
        let Ok(mut file) = File::open(&path) else {
            continue;
        };
        let Ok(header) = read_saved_log_text_index_header(&mut file) else {
            continue;
        };
        // Cache schema versions can change independently of a raw capture.
        // Once the header is parseable and names this exact capture, deleting
        // it should clean up every disposable cache revision—including a
        // cache written by the immediately preceding app version.
        if path_key(Path::new(&header.log_path)) == log_key {
            std::fs::remove_file(&path).map_err(|error| {
                format!(
                    "The capture was deleted, but its search index could not be removed: {error}"
                )
            })?;
        }
    }
    Ok(())
}

fn path_key(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}

/// Old versions could write more than one sidecar for a raw capture. New
/// sessions always receive a unique filename, but retain a deterministic view
/// of an old library by selecting the newest record (then the highest session
/// ID as a stable tie-breaker) for each raw path.
fn index_records_by_path(
    records: impl IntoIterator<Item = LogIndexRecord>,
) -> BTreeMap<String, (PathBuf, LogIndexRecord)> {
    let mut indexed = BTreeMap::new();
    for record in records {
        let path = PathBuf::from(&record.log_path);
        let key = path_key(&path);
        match indexed.get_mut(&key) {
            Some((existing_path, existing_record))
                if log_index_record_is_newer(&record, existing_record) =>
            {
                *existing_path = path;
                *existing_record = record;
            }
            Some(_) => {}
            None => {
                indexed.insert(key, (path, record));
            }
        }
    }
    indexed
}

fn log_index_record_is_newer(candidate: &LogIndexRecord, existing: &LogIndexRecord) -> bool {
    (candidate.updated_at.as_str(), candidate.session_id.as_str())
        > (existing.updated_at.as_str(), existing.session_id.as_str())
}

fn collect_saved_logs(
    app: &AppHandle,
    sessions: &Arc<Mutex<HashMap<String, ActiveSession>>>,
) -> CommandResult<Vec<SavedLog>> {
    let active_sessions: HashMap<String, SessionInfo> = sessions
        .lock()
        .map_err(lock_error)?
        .values()
        .map(|session| {
            (
                path_key(Path::new(&session.info.log_path)),
                session.info.clone(),
            )
        })
        .collect();
    let indexed_paths: BTreeMap<_, _> = index_records_by_path(read_log_index_records(app)?)
        .into_iter()
        .filter(|(_, (path, _))| path.is_file())
        .collect();

    let mut logs = Vec::new();
    for (key, (path, record)) in &indexed_paths {
        logs.push(saved_log_from_path(
            path,
            Some(record),
            active_sessions.get(key),
        )?);
    }
    // Logs created before index support remain discoverable with intentionally
    // unavailable metadata rather than guessed port/baud values.
    for directory in saved_log_directories(app)? {
        if !directory.exists() {
            continue;
        }
        for entry in read_dir(&directory)
            .map_err(|error| format!("Could not read {}: {error}", directory.display()))?
        {
            let entry =
                entry.map_err(|error| format!("Could not read a saved log entry: {error}"))?;
            let path = entry.path();
            if !path.is_file()
                || path.extension().and_then(|extension| extension.to_str()) != Some("log")
            {
                continue;
            }
            let key = path_key(&path);
            if !indexed_paths.contains_key(&key) {
                logs.push(saved_log_from_path(&path, None, active_sessions.get(&key))?);
            }
        }
    }
    logs.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(logs)
}

fn saved_log_from_path(
    path: &Path,
    record: Option<&LogIndexRecord>,
    active: Option<&SessionInfo>,
) -> CommandResult<SavedLog> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    let modified_at: chrono::DateTime<Utc> = metadata
        .modified()
        .map_err(|error| {
            format!(
                "Could not read the timestamp for {}: {error}",
                path.display()
            )
        })?
        .into();
    let state = if active.is_some() {
        "capturing"
    } else if let Some(record) = record {
        match record.state.as_str() {
            "capturing" | "starting" => "interrupted",
            "disconnected" | "error" | "quota-reached" => record.state.as_str(),
            _ => "saved",
        }
    } else {
        "unknown"
    };
    Ok(SavedLog {
        path: path.display().to_string(),
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("serial-capture.log")
            .into(),
        session_name: record
            .map(|value| value.session_name.clone())
            .or_else(|| active.map(|value| value.session_name.clone()))
            .unwrap_or_else(|| log_name_from_path(path)),
        port: record
            .map(|value| value.port.clone())
            .or_else(|| active.map(|value| value.port.clone())),
        baud_rate: record
            .map(|value| value.baud_rate)
            .or_else(|| active.map(|value| value.baud_rate)),
        settings: record
            .and_then(|value| value.settings.clone())
            .or_else(|| active.map(|value| value.settings.clone())),
        size_bytes: metadata.len(),
        modified_at: modified_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        session_id: record
            .map(|value| value.session_id.clone())
            .or_else(|| active.map(|value| value.id.clone())),
        started_at: record.map(|value| value.started_at.clone()),
        ended_at: record.and_then(|value| value.ended_at.clone()),
        metadata_available: record.is_some() || active.is_some(),
        state: state.into(),
    })
}

fn saved_log_metadata(log: &SavedLog) -> String {
    format!(
        "{} {} {} {}",
        log.session_name,
        log.file_name,
        log.port.as_deref().unwrap_or_default(),
        log.baud_rate
            .map(|baud| baud.to_string())
            .unwrap_or_default()
    )
}

fn begin_saved_log_search(
    state: &SerialState,
    search_id: &str,
) -> CommandResult<ActiveSavedLogSearch> {
    if search_id.len() > SEARCH_ID_BYTE_LIMIT {
        return Err(format!(
            "Search identifiers are limited to {SEARCH_ID_BYTE_LIMIT} bytes."
        ));
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    state
        .saved_log_searches
        .lock()
        .map_err(lock_error)?
        .insert(search_id.into(), cancelled.clone());
    Ok(ActiveSavedLogSearch {
        id: search_id.into(),
        cancelled,
        searches: state.saved_log_searches.clone(),
    })
}

fn ensure_search_not_cancelled(cancellation: Option<&AtomicBool>) -> CommandResult<()> {
    if cancellation.is_some_and(|cancelled| cancelled.load(Ordering::Acquire)) {
        Err(SEARCH_CANCELLED_MESSAGE.into())
    } else {
        Ok(())
    }
}

fn search_raw_log(
    path: &Path,
    needle: &[u8],
    byte_limit: u64,
    cancellation: Option<&AtomicBool>,
) -> CommandResult<(u32, Vec<SavedLogSearchMatch>, u64, bool)> {
    let file = File::open(path)
        .map_err(|error| format!("Could not open {} for search: {error}", path.display()))?;
    let file_size = file
        .metadata()
        .map_err(|error| format!("Could not inspect {} for search: {error}", path.display()))?
        .len();
    search_log_reader(
        BufReader::with_capacity(SEARCH_READ_BUFFER_SIZE, file),
        file_size,
        needle,
        byte_limit,
        cancellation,
    )
}

/// Searches raw capture bytes or an exact-byte text cache, normalizing each
/// chunk for case-insensitive matching while retaining the original window for
/// snippets. This keeps indexed results identical to raw full-search results.
fn search_log_reader<R: Read>(
    mut reader: R,
    file_size: u64,
    needle: &[u8],
    byte_limit: u64,
    cancellation: Option<&AtomicBool>,
) -> CommandResult<(u32, Vec<SavedLogSearchMatch>, u64, bool)> {
    let mut buffer = vec![0_u8; SEARCH_READ_BUFFER_SIZE];
    let mut tail = Vec::new();
    let mut bytes_read = 0_u64;
    let mut match_count = 0_u32;
    let mut matches = Vec::new();
    let overlap = needle.len().saturating_sub(1).min(SEARCH_QUERY_BYTE_LIMIT);

    while bytes_read < byte_limit {
        ensure_search_not_cancelled(cancellation)?;
        let allowed = (byte_limit - bytes_read).min(buffer.len() as u64) as usize;
        let count = reader
            .read(&mut buffer[..allowed])
            .map_err(|error| format!("Could not read saved-log search data: {error}"))?;
        if count == 0 {
            break;
        }
        let window_start = bytes_read.saturating_sub(tail.len() as u64);
        let new_data_start = bytes_read;
        let mut window = Vec::with_capacity(tail.len() + count);
        window.extend_from_slice(&tail);
        window.extend_from_slice(&buffer[..count]);
        let lowered = window
            .iter()
            .map(|byte| byte.to_ascii_lowercase())
            .collect::<Vec<_>>();
        for offset in find_all_bytes(&lowered, needle) {
            let absolute_offset = window_start + offset as u64;
            if absolute_offset + needle.len() as u64 <= new_data_start {
                continue;
            }
            match_count = match_count.saturating_add(1);
            if matches.len() < SEARCH_SNIPPET_LIMIT {
                let start = offset.saturating_sub(96);
                let end = (offset + needle.len() + 144).min(window.len());
                matches.push(SavedLogSearchMatch {
                    source: "content".into(),
                    byte_offset: Some(absolute_offset),
                    snippet: Some(
                        String::from_utf8_lossy(&window[start..end]).replace(['\n', '\r'], " "),
                    ),
                });
            }
        }
        bytes_read += count as u64;
        tail = window[window.len().saturating_sub(overlap)..].to_vec();
    }
    Ok((match_count, matches, bytes_read, bytes_read < file_size))
}

fn is_missing_search_path_error(error: &str) -> bool {
    error.contains("No such file") || error.contains("not found")
}

fn find_all_bytes(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return Vec::new();
    }
    haystack
        .windows(needle.len())
        .enumerate()
        .filter_map(|(index, candidate)| (candidate == needle).then_some(index))
        .collect()
}

fn saved_log_directories(app: &AppHandle) -> CommandResult<Vec<PathBuf>> {
    let current = log_directory(app)?;
    let configured = load_application_settings(app)
        .ok()
        .map(|settings| settings.storage.log_directory)
        .filter(|directory| !directory.is_empty())
        .map(PathBuf::from);
    let legacy = app.path().app_data_dir().ok().and_then(|directory| {
        directory
            .parent()
            .map(|parent| parent.join("com.basil.signaldeck").join("logs"))
    });
    let mut directories = vec![current.clone()];
    if let Some(directory) = configured.filter(|directory| directory != &current) {
        directories.push(directory);
    }
    if let Some(directory) = legacy.filter(|directory| directory != &current) {
        directories.push(directory);
    }
    Ok(directories)
}

/// Counts only raw captures in BaudTide-managed roots. Index records provide
/// metadata, never authority to read or write arbitrary filesystem paths.
fn capture_library_usage(app: &AppHandle) -> CommandResult<u64> {
    let mut paths = std::collections::BTreeSet::new();
    for directory in saved_log_directories(app)? {
        if !directory.is_dir() {
            continue;
        }
        for entry in read_dir(&directory)
            .map_err(|error| format!("Could not read {}: {error}", directory.display()))?
        {
            let entry =
                entry.map_err(|error| format!("Could not read a saved log entry: {error}"))?;
            let path = entry.path();
            if path.is_file()
                && path.extension().and_then(|extension| extension.to_str()) == Some("log")
            {
                paths.insert(path_key(&path));
            }
        }
    }
    paths.into_iter().try_fold(0_u64, |total, path| {
        let size = std::fs::metadata(path)
            .map_err(|error| format!("Could not inspect the capture library: {error}"))?
            .len();
        Ok(total.saturating_add(size))
    })
}

fn resolve_saved_log_path(app: &AppHandle, path: &str) -> CommandResult<PathBuf> {
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Could not open the saved log: {error}"))?;
    let roots: Vec<PathBuf> = saved_log_directories(app)?
        .into_iter()
        .filter_map(|directory| directory.canonicalize().ok())
        .collect();
    let is_legacy_library_log = roots.iter().any(|root| path.starts_with(root))
        && path.extension().and_then(|extension| extension.to_str()) == Some("log");
    if !is_legacy_library_log {
        return Err("That file is not in BaudTide's saved-log library.".into());
    }
    Ok(path)
}

fn log_name_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("Serial capture")
        .rsplit_once('-')
        .map(|(name, _)| name)
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("Serial capture")
        })
        .replace('-', " ")
}

fn open_log_file(path: &Path) -> CommandResult<File> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent)
            .map_err(|error| format!("Could not create the log directory: {error}"))?;
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("Could not open {} for logging: {error}", path.display()))
}

fn emit_status(app: &AppHandle, info: &SessionInfo, status: &'static str, message: &str) {
    let _ = app.emit(
        "serial-status",
        SerialStatusEvent {
            session_id: info.id.clone(),
            port: info.port.clone(),
            status,
            message: message.into(),
        },
    );
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "BaudTide's serial session state is unavailable. Restart the app to recover.".into()
}

fn shutdown_serial_sessions(app: &AppHandle, state: &SerialState) {
    shutdown_mobile_shares(&state.mobile_shares);
    let sessions = match state.sessions.lock() {
        Ok(mut sessions) => sessions
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>(),
        Err(_) => return,
    };
    for session in sessions {
        session.stop.store(true, Ordering::Release);
        let info = session.info.clone();
        let _ = session.reader_thread.join();
        let _ = close_serial_writer(session.writer.as_ref());
        let _ = finalize_log_index_state(app, &info.id, "disconnected");
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SerialState::default())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<SerialState>();
                if state.shutting_down.swap(true, Ordering::AcqRel) {
                    return;
                }
                api.prevent_close();
                let app = window.app_handle().clone();
                thread::spawn(move || {
                    let state = app.state::<SerialState>();
                    shutdown_serial_sessions(&app, &state);
                    app.exit(0);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            list_active_sessions,
            take_pending_serial_data,
            load_preferences,
            save_preferences,
            select_log_directory,
            list_saved_logs,
            search_saved_logs,
            cancel_saved_log_search,
            read_saved_log,
            delete_saved_log,
            save_saved_log,
            start_mobile_share,
            get_mobile_share_status,
            stop_mobile_share,
            start_serial_session,
            send_serial_text,
            send_serial_bytes,
            disconnect_serial_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running BaudTide");
}
