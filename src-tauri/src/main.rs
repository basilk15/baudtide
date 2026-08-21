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
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
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
/// Hand bytes to the operating system at a bounded cadence instead of forcing
/// a flush for every read chunk. The durability sync remains on its own,
/// slower cadence below.
const CAPTURE_FLUSH_INTERVAL: Duration = Duration::from_millis(50);
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
const SEARCH_SOURCE_STABILITY_ATTEMPTS: usize = 2;
const SERIAL_WRITE_BYTE_LIMIT: usize = 64 * 1024;
const SESSION_NAME_BYTE_LIMIT: usize = 120;
const PORT_PATH_BYTE_LIMIT: usize = 256;
const MOBILE_SHARE_REQUEST_BYTE_LIMIT: usize = 16 * 1024;
const MOBILE_SHARE_CLIENT_LIMIT: usize = 8;
const MOBILE_SHARE_EVENT_QUEUE_LIMIT: usize = 128;
const MOBILE_WORKSPACE_SESSION_LIMIT: usize = 32;
const MOBILE_WORKSPACE_MESSAGE_BYTE_LIMIT: usize = 8 * 1024;
const MOBILE_SHARE_ACCEPT_POLL: Duration = Duration::from_millis(100);
const MOBILE_SHARE_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const MOBILE_SHARE_HEARTBEAT: Duration = Duration::from_secs(20);
/// The mobile viewer gets a recent event tail from the same ordered event
/// stream as the desktop UI. Keep this small enough for several active
/// sessions while still being useful after a phone is paired late.
const MOBILE_SHARE_REPLAY_BYTE_LIMIT: usize = 512 * 1024;
const MOBILE_SHARE_REPLAY_EVENT_LIMIT: usize = 96;
/// Workspace viewers share a single cursor across every included terminal, so
/// they can resume one ordered feed after a Wi-Fi handoff. Keep the retained
/// wire payload bounded independently from the per-session raw captures.
const MOBILE_WORKSPACE_REPLAY_BYTE_LIMIT: usize = 512 * 1024;
const MOBILE_WORKSPACE_REPLAY_EVENT_LIMIT: usize = 96;
/// One replay notice plus the bounded event tail must fit before live traffic
/// can compete for a slow client's queue.
const MOBILE_SHARE_QUEUE_LIMIT: usize = 128;
const MOBILE_SHARE_WRITE_BYTE_LIMIT: usize = 4 * 1024;
const MOBILE_SHARE_WRITE_REQUEST_LIMIT: usize = 10;
const MOBILE_SHARE_WRITE_RATE_BYTE_LIMIT: usize = 16 * 1024;
const MOBILE_SHARE_WRITE_RATE_WINDOW: Duration = Duration::from_secs(1);

type CommandResult<T> = Result<T, String>;
type SerialWriter = Arc<Mutex<Option<Box<dyn SerialPort>>>>;
type SavedLogContentSearch = (u32, Vec<SavedLogSearchMatch>, u64, bool);

#[derive(Clone)]
struct VerifiedSavedLogContentSearch {
    content: SavedLogContentSearch,
    fingerprint: SavedLogFingerprint,
}

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

/// A bounded, in-memory tail of structured serial events. This is deliberately
/// separate from the raw capture: replay never reads or rewrites the capture,
/// while the event's `bytes` field keeps the viewer tied to the exact bytes that
/// were captured and sequenced by the native reader.
struct MobileReplayBuffer {
    events: Vec<SerialDataEvent>,
    byte_count: usize,
    dropped_event_count: u64,
    event_limit: usize,
    byte_limit: usize,
}

struct MobileReplaySnapshot {
    events: Vec<SerialDataEvent>,
    first_sequence: Option<u64>,
    next_sequence: u64,
    replay_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileReplayNotice {
    kind: &'static str,
    first_sequence: Option<u64>,
    next_sequence: u64,
    replay_truncated: bool,
}

impl Default for MobileReplayBuffer {
    fn default() -> Self {
        Self::with_limits(
            MOBILE_SHARE_REPLAY_EVENT_LIMIT,
            MOBILE_SHARE_REPLAY_BYTE_LIMIT,
        )
    }
}

impl MobileReplayBuffer {
    fn with_limits(event_limit: usize, byte_limit: usize) -> Self {
        Self {
            events: Vec::new(),
            byte_count: 0,
            dropped_event_count: 0,
            event_limit,
            byte_limit,
        }
    }

    fn push(&mut self, event: SerialDataEvent) {
        // The reader is the only producer and assigns increasing sequences.
        // Treat an accidental replay of an older event as a no-op so this
        // bounded source cannot introduce a duplicate or reorder a client.
        if self
            .events
            .last()
            .is_some_and(|last| last.sequence >= event.sequence)
        {
            return;
        }
        if event.bytes.len() > self.byte_limit {
            self.events.clear();
            self.byte_count = 0;
            self.dropped_event_count = self.dropped_event_count.saturating_add(1);
            return;
        }
        self.byte_count = self.byte_count.saturating_add(event.bytes.len());
        self.events.push(event);
        while self.events.len() > self.event_limit || self.byte_count > self.byte_limit {
            let removed = self.events.remove(0);
            self.byte_count = self.byte_count.saturating_sub(removed.bytes.len());
            self.dropped_event_count = self.dropped_event_count.saturating_add(1);
        }
    }

    fn snapshot_after(&self, after_sequence: Option<u64>) -> MobileReplaySnapshot {
        let first_sequence = self.events.first().map(|event| event.sequence);
        let next_sequence = self
            .events
            .last()
            .map(|event| event.sequence.saturating_add(1))
            .unwrap_or(1);
        let requested_replay_has_gap = after_sequence
            .zip(first_sequence)
            .is_some_and(|(after, first)| first > after.saturating_add(1));
        MobileReplaySnapshot {
            events: self
                .events
                .iter()
                .filter(|event| after_sequence.map_or(true, |after| event.sequence > after))
                .cloned()
                .collect(),
            first_sequence,
            next_sequence,
            replay_truncated: self.dropped_event_count > 0 || requested_replay_has_gap,
        }
    }
}

/// A workspace feed interleaves data and lifecycle updates from multiple
/// native sessions. Its cursor must therefore be allocated by the workspace,
/// rather than reusing a serial reader's per-session sequence number.
struct MobileWorkspaceReplayBuffer {
    events: Vec<MobileWorkspaceReplayEvent>,
    byte_count: usize,
    dropped_event_count: u64,
    event_limit: usize,
    byte_limit: usize,
    next_sequence: u64,
}

#[derive(Clone)]
struct MobileWorkspaceReplayEvent {
    sequence: u64,
    payload: String,
}

struct MobileWorkspaceReplaySnapshot {
    events: Vec<MobileWorkspaceReplayEvent>,
    first_sequence: Option<u64>,
    next_sequence: u64,
    replay_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileWorkspaceReplayNotice {
    #[serde(rename = "type")]
    kind: &'static str,
    first_sequence: Option<u64>,
    next_sequence: u64,
    replay_truncated: bool,
}

impl Default for MobileWorkspaceReplayBuffer {
    fn default() -> Self {
        Self::with_limits(
            MOBILE_WORKSPACE_REPLAY_EVENT_LIMIT,
            MOBILE_WORKSPACE_REPLAY_BYTE_LIMIT,
        )
    }
}

impl MobileWorkspaceReplayBuffer {
    fn with_limits(event_limit: usize, byte_limit: usize) -> Self {
        Self {
            events: Vec::new(),
            byte_count: 0,
            dropped_event_count: 0,
            event_limit,
            byte_limit,
            next_sequence: 1,
        }
    }

    fn push(&mut self, event: MobileWorkspaceReplayEventKind) -> Option<String> {
        let sequence = self.next_sequence;
        let message = event.into_message(sequence);
        let payload = serde_json::to_string(&message).ok()?;
        self.next_sequence = self.next_sequence.saturating_add(1);

        let payload_bytes = payload.len();
        if payload_bytes > self.byte_limit {
            // Keep live delivery working even for one unusually large serial
            // chunk, but make the gap explicit to any reconnecting viewer.
            self.events.clear();
            self.byte_count = 0;
            self.dropped_event_count = self.dropped_event_count.saturating_add(1);
            return Some(payload);
        }

        self.byte_count = self.byte_count.saturating_add(payload_bytes);
        self.events.push(MobileWorkspaceReplayEvent {
            sequence,
            payload: payload.clone(),
        });
        while self.events.len() > self.event_limit || self.byte_count > self.byte_limit {
            let removed = self.events.remove(0);
            self.byte_count = self.byte_count.saturating_sub(removed.payload.len());
            self.dropped_event_count = self.dropped_event_count.saturating_add(1);
        }
        Some(payload)
    }

    fn snapshot_after(&self, after_sequence: Option<u64>) -> MobileWorkspaceReplaySnapshot {
        let first_sequence = self.events.first().map(|event| event.sequence);
        let requested_replay_has_gap = after_sequence
            .zip(first_sequence)
            .is_some_and(|(after, first)| first > after.saturating_add(1));
        MobileWorkspaceReplaySnapshot {
            events: self
                .events
                .iter()
                .filter(|event| after_sequence.map_or(true, |after| event.sequence > after))
                .cloned()
                .collect(),
            first_sequence,
            next_sequence: self.next_sequence,
            replay_truncated: self.dropped_event_count > 0 || requested_replay_has_gap,
        }
    }
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    mobile_replay: Arc<Mutex<MobileReplayBuffer>>,
    reader_thread: JoinHandle<()>,
}

struct ReaderContext {
    app: AppHandle,
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
    event_delivery: Arc<Mutex<SerialEventDelivery>>,
    quota: Arc<Mutex<CaptureQuota>>,
    mobile_shares: Arc<Mutex<HashMap<String, ActiveMobileShare>>>,
    mobile_replay: Arc<Mutex<MobileReplayBuffer>>,
    mobile_workspace_share: Arc<Mutex<Option<ActiveMobileWorkspaceShare>>>,
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
    mobile_workspace_share: Arc<Mutex<Option<ActiveMobileWorkspaceShare>>>,
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
    control_enabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileWorkspaceShareInfo {
    url: String,
    host: String,
    port: u16,
    client_count: usize,
    session_count: usize,
    enabled: bool,
}

struct ActiveMobileShare {
    token: String,
    host: String,
    port: u16,
    stop: Arc<AtomicBool>,
    clients: Arc<Mutex<HashMap<u64, std::sync::mpsc::SyncSender<String>>>>,
    control_enabled: Arc<AtomicBool>,
    server_thread: JoinHandle<()>,
}

#[derive(Clone)]
struct MobileShareServerContext {
    token: String,
    stop: Arc<AtomicBool>,
    replay: Arc<Mutex<MobileReplayBuffer>>,
    clients: Arc<Mutex<HashMap<u64, std::sync::mpsc::SyncSender<String>>>>,
    next_client_id: Arc<AtomicU64>,
    connection_slots: Arc<AtomicUsize>,
    control_enabled: Arc<AtomicBool>,
    write_rate_limiter: Arc<Mutex<MobileWriteRateState>>,
    writer: SerialWriter,
    session_stop: Arc<AtomicBool>,
}

#[derive(Clone)]
struct MobileWorkspaceShareServerContext {
    token: String,
    stop: Arc<AtomicBool>,
    sessions: Arc<Mutex<BTreeMap<String, MobileWorkspaceSession>>>,
    replay: Arc<Mutex<MobileWorkspaceReplayBuffer>>,
    clients: Arc<Mutex<HashMap<u64, std::sync::mpsc::SyncSender<String>>>>,
    next_client_id: Arc<AtomicU64>,
    connection_slots: Arc<AtomicUsize>,
}

#[derive(Debug)]
struct MobileShareRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Default)]
struct MobileWriteRateState {
    window_started: Option<Instant>,
    request_count: usize,
    byte_count: usize,
}

#[derive(Debug)]
enum MobileWritePayloadError {
    Invalid(String),
    TooLarge(String),
}

#[derive(Debug)]
struct MobileWritePayload {
    mode: &'static str,
    bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct MobileWriteRequest {
    mode: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    hex: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileControlStatusResponse {
    ok: bool,
    control_enabled: bool,
    max_payload_bytes: usize,
    max_writes_per_second: usize,
    max_bytes_per_second: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileWriteSuccessResponse {
    ok: bool,
    mode: &'static str,
    written_bytes: usize,
    message: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileErrorResponse {
    ok: bool,
    error: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileWorkspaceSession {
    session_id: String,
    session_name: String,
    port: String,
    state: String,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum MobileWorkspaceMessage {
    Snapshot {
        sessions: Vec<MobileWorkspaceSession>,
    },
    Data {
        sequence: u64,
        event: SerialDataEvent,
    },
    Status {
        sequence: u64,
        session_id: String,
        port: String,
        status: String,
        message: String,
    },
}

#[derive(Clone)]
enum MobileWorkspaceReplayEventKind {
    Data {
        event: SerialDataEvent,
    },
    Status {
        session_id: String,
        port: String,
        status: String,
        message: String,
    },
}

impl MobileWorkspaceReplayEventKind {
    fn into_message(self, sequence: u64) -> MobileWorkspaceMessage {
        match self {
            Self::Data { event } => MobileWorkspaceMessage::Data { sequence, event },
            Self::Status {
                session_id,
                port,
                status,
                message,
            } => MobileWorkspaceMessage::Status {
                sequence,
                session_id,
                port,
                status,
                message,
            },
        }
    }
}

struct ActiveMobileWorkspaceShare {
    token: String,
    host: String,
    port: u16,
    stop: Arc<AtomicBool>,
    sessions: Arc<Mutex<BTreeMap<String, MobileWorkspaceSession>>>,
    replay: Arc<Mutex<MobileWorkspaceReplayBuffer>>,
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
        let mut verified_fingerprint = None;
        // A complete search must take its limit from the verified source
        // snapshot inside the search helper. The size collected above can be
        // stale by the time a growing capture is opened; using it here could
        // make a full search silently scan only the old prefix.
        let scan_limit = if full_search {
            u64::MAX
        } else {
            total_remaining.min(SEARCH_PER_LOG_BYTE_LIMIT)
        };
        let (content_match_count, content_matches, _bytes_scanned, content_search_truncated) =
            if scan_limit == 0 {
                // No content budget remains for this quick-search entry, but
                // still capture the source identity so a metadata-only result
                // cannot be returned for a path that was replaced meanwhile.
                let current_size = saved_log_fingerprint(Path::new(&log.path))
                    .map(|fingerprint| {
                        verified_fingerprint = Some(fingerprint);
                        fingerprint.size
                    })
                    .unwrap_or(log.size_bytes);
                if !full_search && current_size > 0 {
                    truncated = true;
                }
                (0, Vec::new(), 0, current_size > 0)
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
                        scanned_bytes = scanned_bytes.saturating_add(search.content.2);
                        verified_fingerprint = Some(search.fingerprint);
                        search.content
                    }
                    Ok(None) => {
                        index_fallback_log_count += 1;
                        let Some(search) = search_stable_raw_log(
                            Path::new(&log.path),
                            &query_bytes,
                            scan_limit,
                            cancellation,
                        )?
                        else {
                            continue;
                        };
                        scanned_log_count += 1;
                        scanned_bytes = scanned_bytes.saturating_add(search.content.2);
                        verified_fingerprint = Some(search.fingerprint);
                        let index_limit = index_update_budget.min(SEARCH_INDEX_PER_LOG_BYTE_LIMIT);
                        if index_limit < search.fingerprint.size {
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
                                        index_update_budget.saturating_sub(search.fingerprint.size);
                                }
                                Ok(false) => {}
                                Err(error) if error == SEARCH_CANCELLED_MESSAGE => {
                                    return Err(error);
                                }
                                // Index files are derived data. Disk damage or a concurrent
                                // cache cleanup must not hide a successful raw fallback.
                                Err(_) => {}
                            }
                        }
                        search.content
                    }
                    Err(error) if is_missing_search_path_error(&error) => continue,
                    Err(error) => return Err(error),
                }
            } else {
                let search = match search_stable_raw_log(
                    Path::new(&log.path),
                    &query_bytes,
                    scan_limit,
                    cancellation,
                ) {
                    Ok(Some(search)) => search,
                    Ok(None) => continue,
                    Err(error) if is_missing_search_path_error(&error) => continue,
                    Err(error) => return Err(error),
                };
                scanned_log_count += 1;
                scanned_bytes = scanned_bytes.saturating_add(search.content.2);
                verified_fingerprint = Some(search.fingerprint);
                if !full_search {
                    total_remaining = total_remaining.saturating_sub(search.content.2);
                }
                if search.content.3 {
                    truncated = true;
                }
                search.content
            };
        // A deletion can race an index lookup or raw scan. Do the final
        // authority check against the raw path before returning a match.
        let still_authoritative = verified_fingerprint.map_or_else(
            || Path::new(&log.path).is_file(),
            |fingerprint| saved_log_fingerprint(Path::new(&log.path)).ok() == Some(fingerprint),
        );
        if (metadata_match || content_match_count > 0) && still_authoritative {
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

/// Enables an explicitly requested companion page for one live serial session.
/// The listener is IPv4 LAN-only and starts with remote control disabled.
#[tauri::command]
fn start_mobile_share(
    state: State<'_, SerialState>,
    session_id: String,
) -> CommandResult<MobileShareInfo> {
    let session_id = require_mobile_share_session_id(&session_id)?;
    let (mobile_replay, session_writer, session_stop) = {
        let sessions = state.sessions.lock().map_err(lock_error)?;
        let shares = state.mobile_shares.lock().map_err(lock_error)?;
        if let Some(share) = shares.get(&session_id) {
            return Ok(active_mobile_share_info(&session_id, share));
        }
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| "This serial session is no longer active.".to_string())?;
        (
            Arc::clone(&session.mobile_replay),
            Arc::clone(&session.writer),
            Arc::clone(&session.stop),
        )
    };
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
    let connection_slots = Arc::new(AtomicUsize::new(0));
    let control_enabled = Arc::new(AtomicBool::new(false));
    let write_rate_limiter = Arc::new(Mutex::new(MobileWriteRateState::default()));
    let next_client_id = Arc::new(AtomicU64::new(1));
    let thread_session_id = session_id.clone();
    let thread_name_suffix: String = thread_session_id.chars().take(8).collect();
    let server_context = MobileShareServerContext {
        token: token.clone(),
        stop: Arc::clone(&stop),
        replay: Arc::clone(&mobile_replay),
        clients: Arc::clone(&clients),
        next_client_id: Arc::clone(&next_client_id),
        connection_slots: Arc::clone(&connection_slots),
        control_enabled: Arc::clone(&control_enabled),
        write_rate_limiter: Arc::clone(&write_rate_limiter),
        writer: Arc::clone(&session_writer),
        session_stop: Arc::clone(&session_stop),
    };
    register_mobile_share_for_session(
        &state.sessions,
        &state.mobile_shares,
        &session_id,
        move |session| {
            let server_context = server_context.clone();
            let server_thread = thread::Builder::new()
                .name(format!("mobile-share-{thread_name_suffix}"))
                .spawn(move || run_mobile_share_server(listener, session, server_context))
                .map_err(|error| format!("Could not start local mobile sharing: {error}"))?;
            Ok(ActiveMobileShare {
                token: token.clone(),
                host: host.clone(),
                port,
                stop,
                clients,
                control_enabled,
                server_thread,
            })
        },
    )
}

fn register_mobile_share_for_session<F>(
    sessions: &Arc<Mutex<HashMap<String, ActiveSession>>>,
    shares: &Arc<Mutex<HashMap<String, ActiveMobileShare>>>,
    session_id: &str,
    build_share: F,
) -> CommandResult<MobileShareInfo>
where
    F: FnOnce(SessionInfo) -> CommandResult<ActiveMobileShare>,
{
    let sessions = sessions.lock().map_err(lock_error)?;
    let session = sessions
        .get(session_id)
        .map(|session| session.info.clone())
        .ok_or_else(|| "This serial session is no longer active.".to_string())?;
    let mut shares = shares.lock().map_err(lock_error)?;
    if let Some(share) = shares.get(session_id) {
        return Ok(active_mobile_share_info(session_id, share));
    }
    let share = build_share(session)?;
    let info = active_mobile_share_info(session_id, &share);
    shares.insert(session_id.to_string(), share);
    Ok(info)
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
            control_enabled: false,
        }))
}

#[tauri::command]
fn set_mobile_share_control(
    state: State<'_, SerialState>,
    session_id: String,
    enabled: bool,
) -> CommandResult<MobileShareInfo> {
    let session_id = require_mobile_share_session_id(&session_id)?;
    let shares = state.mobile_shares.lock().map_err(lock_error)?;
    let share = shares
        .get(&session_id)
        .ok_or_else(|| "Create a mobile link before changing remote control.".to_string())?;
    if share.stop.load(Ordering::Acquire) {
        return Err("This mobile link is no longer active.".into());
    }
    share.control_enabled.store(enabled, Ordering::Release);
    Ok(active_mobile_share_info(&session_id, share))
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
        control_enabled: false,
    })
}

/// Starts one read-only dashboard whose scope is the set of native sessions
/// that are active at creation time. The scope is deliberately immutable: a
/// later terminal or reconnect receives a new native session ID and cannot
/// enter an already-issued bearer link.
#[tauri::command]
fn start_mobile_workspace_share(
    state: State<'_, SerialState>,
) -> CommandResult<MobileWorkspaceShareInfo> {
    // Keep this order (`sessions` then `mobile_workspace_share`) consistent
    // with serial startup, which publishes its connected status while holding
    // the native-session map. This prevents a startup/share deadlock.
    let _sessions_guard = state.sessions.lock().map_err(lock_error)?;
    let mut active_share = state.mobile_workspace_share.lock().map_err(lock_error)?;
    if let Some(share) = active_share.as_ref() {
        return Ok(active_mobile_workspace_share_info(share));
    }

    // Keep the native-session map locked through registration. A reader that
    // fails during this small window then waits until the workspace share is
    // visible and can publish its terminal status instead of leaving a stale
    // connected row in the snapshot.
    let session_scope = mobile_workspace_session_scope(&_sessions_guard)?;
    let host = local_lan_ipv4()?;
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| format!("Could not start local mobile workspace sharing: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not configure local mobile workspace sharing: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not inspect local mobile workspace sharing: {error}"))?
        .port();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let stop = Arc::new(AtomicBool::new(false));
    let sessions = Arc::new(Mutex::new(session_scope));
    let replay = Arc::new(Mutex::new(MobileWorkspaceReplayBuffer::default()));
    let clients = Arc::new(Mutex::new(HashMap::new()));
    let connection_slots = Arc::new(AtomicUsize::new(0));
    let next_client_id = Arc::new(AtomicU64::new(1));
    let server_context = MobileWorkspaceShareServerContext {
        token: token.clone(),
        stop: Arc::clone(&stop),
        sessions: Arc::clone(&sessions),
        replay: Arc::clone(&replay),
        clients: Arc::clone(&clients),
        next_client_id: Arc::clone(&next_client_id),
        connection_slots: Arc::clone(&connection_slots),
    };
    let server_thread = thread::Builder::new()
        .name("mobile-workspace-share".into())
        .spawn(move || run_mobile_workspace_share_server(listener, server_context))
        .map_err(|error| format!("Could not start local mobile workspace sharing: {error}"))?;
    let share = ActiveMobileWorkspaceShare {
        token,
        host,
        port,
        stop,
        sessions,
        replay,
        clients,
        server_thread,
    };
    let info = active_mobile_workspace_share_info(&share);
    *active_share = Some(share);
    Ok(info)
}

#[tauri::command]
fn get_mobile_workspace_share_status(
    state: State<'_, SerialState>,
) -> CommandResult<MobileWorkspaceShareInfo> {
    let active_share = state.mobile_workspace_share.lock().map_err(lock_error)?;
    Ok(active_share
        .as_ref()
        .map(active_mobile_workspace_share_info)
        .unwrap_or_else(empty_mobile_workspace_share_info))
}

#[tauri::command]
fn stop_mobile_workspace_share(
    state: State<'_, SerialState>,
) -> CommandResult<MobileWorkspaceShareInfo> {
    stop_mobile_workspace_share_for_state(&state.mobile_workspace_share);
    Ok(empty_mobile_workspace_share_info())
}

fn empty_mobile_workspace_share_info() -> MobileWorkspaceShareInfo {
    MobileWorkspaceShareInfo {
        url: String::new(),
        host: String::new(),
        port: 0,
        client_count: 0,
        session_count: 0,
        enabled: false,
    }
}

fn active_mobile_workspace_share_info(
    share: &ActiveMobileWorkspaceShare,
) -> MobileWorkspaceShareInfo {
    MobileWorkspaceShareInfo {
        url: mobile_workspace_share_url(&share.host, share.port, &share.token),
        host: share.host.clone(),
        port: share.port,
        client_count: share
            .clients
            .lock()
            .map(|clients| clients.len())
            .unwrap_or(0),
        session_count: share
            .sessions
            .lock()
            .map(|sessions| sessions.len())
            .unwrap_or(0),
        enabled: !share.stop.load(Ordering::Acquire),
    }
}

fn mobile_workspace_share_url(host: &str, port: u16, token: &str) -> String {
    format!("http://{host}:{port}/workspace/{token}")
}

fn mobile_workspace_session_scope(
    sessions: &HashMap<String, ActiveSession>,
) -> CommandResult<BTreeMap<String, MobileWorkspaceSession>> {
    if sessions.is_empty() {
        return Err(
            "Open at least one active serial session before creating a workspace link.".into(),
        );
    }
    if sessions.len() > MOBILE_WORKSPACE_SESSION_LIMIT {
        return Err(format!(
            "Workspace mobile sharing is limited to {MOBILE_WORKSPACE_SESSION_LIMIT} active sessions."
        ));
    }
    Ok(sessions
        .values()
        .map(|session| {
            (
                session.info.id.clone(),
                MobileWorkspaceSession {
                    session_id: session.info.id.clone(),
                    session_name: session.info.session_name.clone(),
                    port: session.info.port.clone(),
                    state: "connected".into(),
                    message: "Port opened and raw logging started.".into(),
                },
            )
        })
        .collect())
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
        control_enabled: share.control_enabled.load(Ordering::Acquire),
    }
}

fn mobile_share_url(host: &str, port: u16, token: &str) -> String {
    format!("http://{host}:{port}/share/{token}")
}

/// Finds a LAN-reachable local IPv4 without depending on a routable internet
/// destination. Probe private and non-routable destinations first so the
/// kernel selects the default LAN interface; fall back to active Unix
/// interface addresses when no route can be selected.
fn local_lan_ipv4() -> CommandResult<String> {
    if let Some(ip) = probe_local_lan_ipv4(&[
        Ipv4Addr::new(192, 168, 0, 1),
        Ipv4Addr::new(10, 0, 0, 1),
        Ipv4Addr::new(172, 16, 0, 1),
        Ipv4Addr::new(169, 254, 0, 1),
        Ipv4Addr::new(192, 0, 2, 1),
    ])
    .map_err(|error| format!("Could not find a local network address: {error}"))?
    {
        return Ok(ip.to_string());
    }

    #[cfg(unix)]
    if let Ok(addresses) = unix_local_ipv4_addrs() {
        if let Some(ip) = addresses.into_iter().find(|ip| is_usable_lan_ipv4(*ip)) {
            return Ok(ip.to_string());
        }
    }

    Err("Connect this computer to Wi-Fi or Ethernet before sharing with a phone.".into())
}

fn is_usable_lan_ipv4(ip: Ipv4Addr) -> bool {
    !ip.is_unspecified() && !ip.is_loopback() && (ip.is_private() || ip.is_link_local())
}

fn probe_local_lan_ipv4(destinations: &[Ipv4Addr]) -> io::Result<Option<Ipv4Addr>> {
    for destination in destinations {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
        if socket.connect((*destination, 80)).is_err() {
            continue;
        }
        let IpAddr::V4(ip) = socket.local_addr()?.ip() else {
            continue;
        };
        if is_usable_lan_ipv4(ip) {
            return Ok(Some(ip));
        }
    }
    Ok(None)
}

#[cfg(unix)]
fn unix_local_ipv4_addrs() -> io::Result<Vec<Ipv4Addr>> {
    struct InterfaceList(*mut libc::ifaddrs);

    impl Drop for InterfaceList {
        fn drop(&mut self) {
            unsafe { libc::freeifaddrs(self.0) };
        }
    }

    let mut head = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let list = InterfaceList(head);
    let mut cursor = list.0;
    let mut addrs = Vec::new();
    while !cursor.is_null() {
        let entry = unsafe { &*cursor };
        let flags = entry.ifa_flags as libc::c_uint;
        let address = entry.ifa_addr;
        if !address.is_null()
            && flags & (libc::IFF_UP as libc::c_uint) != 0
            && flags & (libc::IFF_LOOPBACK as libc::c_uint) == 0
            && unsafe { (*address).sa_family as libc::c_int } == libc::AF_INET
        {
            let address = unsafe { *(address as *const libc::sockaddr_in) };
            addrs.push(Ipv4Addr::from(u32::from_be(address.sin_addr.s_addr)));
        }
        cursor = entry.ifa_next;
    }
    Ok(addrs)
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

fn stop_mobile_workspace_share_for_state(
    share_state: &Arc<Mutex<Option<ActiveMobileWorkspaceShare>>>,
) {
    let share = share_state.lock().ok().and_then(|mut share| share.take());
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

fn shutdown_mobile_workspace_share(share_state: &Arc<Mutex<Option<ActiveMobileWorkspaceShare>>>) {
    stop_mobile_workspace_share_for_state(share_state);
}

fn try_reserve_mobile_connection(slots: &AtomicUsize) -> bool {
    let mut current = slots.load(Ordering::Relaxed);
    loop {
        if current >= MOBILE_SHARE_CLIENT_LIMIT {
            return false;
        }
        match slots.compare_exchange_weak(current, current + 1, Ordering::AcqRel, Ordering::Relaxed)
        {
            Ok(_) => return true,
            Err(next) => current = next,
        }
    }
}

struct MobileConnectionSlot(Arc<AtomicUsize>);

impl Drop for MobileConnectionSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn register_mobile_client(
    clients: &mut HashMap<u64, std::sync::mpsc::SyncSender<String>>,
    client_id: u64,
    sender: std::sync::mpsc::SyncSender<String>,
) -> Option<()> {
    if clients.len() >= MOBILE_SHARE_CLIENT_LIMIT {
        return None;
    }
    clients.insert(client_id, sender);
    Some(())
}

fn run_mobile_share_server(
    listener: TcpListener,
    session: SessionInfo,
    context: MobileShareServerContext,
) {
    while !context.stop.load(Ordering::Acquire) {
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
                if !try_reserve_mobile_connection(&context.connection_slots) {
                    let _ = write_http_response(
                        &stream,
                        "503 Service Unavailable",
                        "text/plain; charset=utf-8",
                        b"Too many mobile viewers.\n",
                        &[],
                    );
                    let _ = stream.shutdown(Shutdown::Both);
                    continue;
                }
                let request_session = session.clone();
                let request_context = context.clone();
                if thread::Builder::new()
                    .name("mobile-share-client".into())
                    .spawn(move || {
                        handle_mobile_share_connection(stream, request_session, request_context)
                    })
                    .is_err()
                {
                    context.connection_slots.fetch_sub(1, Ordering::AcqRel);
                }
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum MobileShareRoute {
    Page,
    Download,
    Events,
}

fn authorized_mobile_share_route(
    path: &str,
    root: &str,
    token: &str,
    include_download: bool,
) -> Option<MobileShareRoute> {
    let page_path = format!("/{root}/{token}");
    if constant_time_eq(path.as_bytes(), page_path.as_bytes()) {
        return Some(MobileShareRoute::Page);
    }
    if include_download
        && constant_time_eq(path.as_bytes(), format!("{page_path}/download").as_bytes())
    {
        return Some(MobileShareRoute::Download);
    }
    constant_time_eq(path.as_bytes(), format!("{page_path}/events").as_bytes())
        .then_some(MobileShareRoute::Events)
}

fn handle_mobile_share_connection(
    mut stream: TcpStream,
    session: SessionInfo,
    context: MobileShareServerContext,
) {
    let _connection_slot = MobileConnectionSlot(Arc::clone(&context.connection_slots));
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
    let page_path = format!("/share/{}", context.token);
    let download_path = format!("{page_path}/download");
    let events_path = format!("{page_path}/events");
    let control_status_path = format!("{page_path}/control/status");
    let control_write_path = format!("{page_path}/control/write");
    let events_after = parse_mobile_share_events_path(&request.path, &events_path);
    let is_page = constant_time_eq(request.path.as_bytes(), page_path.as_bytes());
    let is_download = constant_time_eq(request.path.as_bytes(), download_path.as_bytes());
    let is_events = events_after.is_some();
    let is_control_status =
        constant_time_eq(request.path.as_bytes(), control_status_path.as_bytes());
    let is_control_write = constant_time_eq(request.path.as_bytes(), control_write_path.as_bytes());

    if (request.method == "GET" && !(is_page || is_download || is_events || is_control_status))
        || (request.method == "POST" && !is_control_write)
        || (request.method != "GET" && request.method != "POST")
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
    if is_page {
        let _ = write_http_response(
            &stream,
            "200 OK",
            "text/html; charset=utf-8",
            MOBILE_SHARE_PAGE.as_bytes(),
            &[
                ("Cache-Control", "no-store"),
                ("Referrer-Policy", "no-referrer"),
                ("X-Content-Type-Options", "nosniff"),
                (
                    "Content-Security-Policy",
                    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' ws: wss:",
                ),
                ("Permissions-Policy", "web-share=(self)"),
            ],
        );
    } else if is_download {
        serve_mobile_share_download(&mut stream, &session.log_path);
    } else if is_events {
        serve_mobile_share_websocket(
            &mut stream,
            &request.headers,
            Arc::clone(&context.stop),
            Arc::clone(&context.replay),
            Arc::clone(&context.clients),
            Arc::clone(&context.next_client_id),
            events_after.expect("validated mobile events path"),
        );
    } else if is_control_status {
        if !mobile_share_bearer_matches(&request.headers, &context.token) {
            write_mobile_error_response(
                &stream,
                "401 Unauthorized",
                "A valid mobile share capability is required.",
                &[("WWW-Authenticate", "Bearer")],
            );
            return;
        }
        let status = MobileControlStatusResponse {
            ok: true,
            control_enabled: context.control_enabled.load(Ordering::Acquire),
            max_payload_bytes: MOBILE_SHARE_WRITE_BYTE_LIMIT,
            max_writes_per_second: MOBILE_SHARE_WRITE_REQUEST_LIMIT,
            max_bytes_per_second: MOBILE_SHARE_WRITE_RATE_BYTE_LIMIT,
        };
        let _ = write_mobile_json_response(&stream, "200 OK", &status, &[]);
    } else if is_control_write {
        handle_mobile_share_write(&stream, &request, &context, &session.port);
    }
}

fn run_mobile_workspace_share_server(
    listener: TcpListener,
    context: MobileWorkspaceShareServerContext,
) {
    while !context.stop.load(Ordering::Acquire) {
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
                if !try_reserve_mobile_connection(&context.connection_slots) {
                    let _ = write_http_response(
                        &stream,
                        "503 Service Unavailable",
                        "text/plain; charset=utf-8",
                        b"Too many mobile viewers.\n",
                        &[],
                    );
                    let _ = stream.shutdown(Shutdown::Both);
                    continue;
                }
                let request_context = context.clone();
                if thread::Builder::new()
                    .name("mobile-workspace-client".into())
                    .spawn(move || {
                        handle_mobile_workspace_share_connection(stream, request_context)
                    })
                    .is_err()
                {
                    context.connection_slots.fetch_sub(1, Ordering::AcqRel);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(MOBILE_SHARE_ACCEPT_POLL)
            }
            Err(_) => break,
        }
    }
}

fn handle_mobile_workspace_share_connection(
    mut stream: TcpStream,
    context: MobileWorkspaceShareServerContext,
) {
    let _connection_slot = MobileConnectionSlot(Arc::clone(&context.connection_slots));
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
    let MobileShareRequest {
        method,
        path,
        headers,
        ..
    } = request;
    let page_path = format!("/workspace/{}", context.token);
    let events_path = format!("{page_path}/events");
    let events_after = parse_mobile_share_events_path(&path, &events_path);
    let is_page = matches!(
        authorized_mobile_share_route(&path, "workspace", &context.token, false),
        Some(MobileShareRoute::Page)
    );
    if method != "GET" || !(is_page || events_after.is_some()) {
        let _ = write_http_response(
            &stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not found.\n",
            &[],
        );
        return;
    }
    if is_page {
        let _ = write_http_response(
                &stream,
                "200 OK",
                "text/html; charset=utf-8",
                mobile_workspace_share_page().as_bytes(),
                &[
                    ("Cache-Control", "no-store"),
                    ("Referrer-Policy", "no-referrer"),
                    ("X-Content-Type-Options", "nosniff"),
                    (
                        "Content-Security-Policy",
                        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' ws: wss:",
                    ),
                ],
            );
    } else {
        serve_mobile_workspace_websocket(
            &mut stream,
            &headers,
            &context,
            events_after.expect("validated mobile workspace events path"),
        );
    }
}

/// The browser uses this tiny query parameter to ask for only events after its
/// last accepted sequence on reconnect. Keep the grammar intentionally narrow:
/// no decoded paths, fragments, or unknown query fields are accepted.
fn parse_mobile_share_events_path(path: &str, events_path: &str) -> Option<Option<u64>> {
    let (pathname, query) = path.split_once('?').unwrap_or((path, ""));
    if !constant_time_eq(pathname.as_bytes(), events_path.as_bytes()) {
        return None;
    }
    if query.is_empty() {
        return Some(None);
    }
    let (name, value) = query.split_once('=')?;
    if name != "after"
        || value.is_empty()
        || value.bytes().any(|byte| !byte.is_ascii_digit())
        || query.matches('&').count() > 0
    {
        return None;
    }
    value.parse::<u64>().ok().map(Some)
}

fn read_mobile_share_request(stream: &mut TcpStream) -> io::Result<MobileShareRequest> {
    stream.set_read_timeout(Some(MOBILE_SHARE_WRITE_TIMEOUT))?;
    read_mobile_share_request_from_reader(stream)
}

fn read_mobile_share_request_from_reader(reader: &mut impl Read) -> io::Result<MobileShareRequest> {
    let mut bytes = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 1024];
    let header_end = loop {
        if bytes.len() >= MOBILE_SHARE_REQUEST_BYTE_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request exceeds the size limit",
            ));
        }
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "request ended",
            ));
        }
        let remaining = MOBILE_SHARE_REQUEST_BYTE_LIMIT - bytes.len();
        if count > remaining {
            bytes.extend_from_slice(&buffer[..remaining]);
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request exceeds the size limit",
            ));
        }
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break end;
        }
    };

    let header_length = header_end + 4;
    let (method, path, headers) = parse_mobile_share_request_bytes(&bytes[..header_end])?;
    if headers.contains_key("transfer-encoding") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "chunked request bodies are not supported",
        ));
    }
    let content_length = headers
        .get("content-length")
        .map(|value| parse_mobile_content_length(value))
        .transpose()?;
    let content_length = content_length.unwrap_or(0);
    if header_length.saturating_add(content_length) > MOBILE_SHARE_REQUEST_BYTE_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "request exceeds the size limit",
        ));
    }
    if method == "GET" && content_length > 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "request body is not allowed",
        ));
    }

    let mut body = bytes[header_length..].to_vec();
    if body.len() > content_length {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "request contains bytes beyond its declared body",
        ));
    }
    while body.len() < content_length {
        let remaining = content_length - body.len();
        let read_limit = remaining.min(buffer.len());
        let count = reader.read(&mut buffer[..read_limit])?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "request body ended",
            ));
        }
        body.extend_from_slice(&buffer[..count]);
    }
    Ok(MobileShareRequest {
        method,
        path,
        headers,
        body,
    })
}

fn parse_mobile_content_length(value: &str) -> io::Result<usize> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid Content-Length",
        ));
    }
    value
        .parse::<usize>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid Content-Length"))
}

fn parse_mobile_share_request_bytes(
    request_bytes: &[u8],
) -> io::Result<(String, String, HashMap<String, String>)> {
    let request = std::str::from_utf8(request_bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "request is not UTF-8"))?;
    let mut lines = request.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request line"))?;
    let mut request_parts = request_line.split(' ');
    let method = request_parts.next().unwrap_or_default();
    let path = request_parts.next().unwrap_or_default();
    let version = request_parts.next().unwrap_or_default();
    if request_parts.next().is_some()
        || method.is_empty()
        || path.is_empty()
        || version != "HTTP/1.1"
        || !method.bytes().all(is_http_token_byte)
        || !path.starts_with('/')
        || path.len() > MOBILE_SHARE_REQUEST_BYTE_LIMIT
        || path.bytes().any(|byte| matches!(byte, 0x00..=0x20 | 0x7f))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid request line",
        ));
    }
    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unexpected blank header line",
            ));
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid header"));
        };
        let name = name.trim();
        let value = value.trim();
        if name.is_empty()
            || !name.bytes().all(is_http_token_byte)
            || value.bytes().any(is_invalid_http_header_value_byte)
            || headers
                .insert(name.to_ascii_lowercase(), value.to_owned())
                .is_some()
        {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid header"));
        }
    }
    Ok((method.to_owned(), path.to_owned(), headers))
}

fn is_http_token_byte(byte: u8) -> bool {
    matches!(byte, b'!' | b'#'..=b'\'' | b'*' | b'+' | b'-' | b'.' | b'0'..=b'9' | b'A'..=b'Z' | b'^' | b'_' | b'`' | b'a'..=b'z' | b'|' | b'~')
}

fn is_invalid_http_header_value_byte(byte: u8) -> bool {
    matches!(byte, 0x00..=0x08 | 0x0a..=0x1f | 0x7f)
}

fn mobile_share_bearer_matches(headers: &HashMap<String, String>, token: &str) -> bool {
    let Some(value) = headers.get("authorization") else {
        return false;
    };
    let Some((scheme, credential)) = value.split_once(' ') else {
        return false;
    };
    scheme.eq_ignore_ascii_case("Bearer")
        && !credential.is_empty()
        && !credential.bytes().any(|byte| byte.is_ascii_whitespace())
        && constant_time_eq(credential.as_bytes(), token.as_bytes())
}

fn parse_mobile_write_payload(body: &[u8]) -> Result<MobileWritePayload, MobileWritePayloadError> {
    let request: MobileWriteRequest = serde_json::from_slice(body).map_err(|_| {
        MobileWritePayloadError::Invalid("Write payload must be JSON with mode text or hex.".into())
    })?;
    match request.mode.as_str() {
        "text" => {
            if request.hex.is_some() {
                return Err(MobileWritePayloadError::Invalid(
                    "Text writes accept only the text field.".into(),
                ));
            }
            let Some(text) = request.text else {
                return Err(MobileWritePayloadError::Invalid(
                    "Text writes require a text field.".into(),
                ));
            };
            if text.is_empty() {
                return Err(MobileWritePayloadError::Invalid(
                    "Text payload must not be empty.".into(),
                ));
            }
            if text.len() > MOBILE_SHARE_WRITE_BYTE_LIMIT {
                return Err(MobileWritePayloadError::TooLarge(format!(
                    "Mobile writes are limited to {MOBILE_SHARE_WRITE_BYTE_LIMIT} UTF-8 bytes."
                )));
            }
            Ok(MobileWritePayload {
                mode: "text",
                bytes: text.into_bytes(),
            })
        }
        "hex" => {
            if request.text.is_some() {
                return Err(MobileWritePayloadError::Invalid(
                    "Hex writes accept only the hex field.".into(),
                ));
            }
            let Some(hex) = request.hex else {
                return Err(MobileWritePayloadError::Invalid(
                    "Hex writes require a hex field.".into(),
                ));
            };
            let bytes = parse_mobile_hex_bytes(&hex)?;
            Ok(MobileWritePayload { mode: "hex", bytes })
        }
        _ => Err(MobileWritePayloadError::Invalid(
            "Mode must be text or hex.".into(),
        )),
    }
}

fn parse_mobile_hex_bytes(input: &str) -> Result<Vec<u8>, MobileWritePayloadError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(MobileWritePayloadError::Invalid(
            "Hex payload must contain at least one byte.".into(),
        ));
    }
    let mut tokens = Vec::new();
    for comma_segment in trimmed.split(',') {
        let segment = comma_segment.trim();
        if segment.is_empty() {
            return Err(MobileWritePayloadError::Invalid(
                "Use one comma or whitespace separator between each byte.".into(),
            ));
        }
        tokens.extend(segment.split_whitespace());
    }
    if tokens.is_empty() {
        return Err(MobileWritePayloadError::Invalid(
            "Hex payload must contain at least one byte.".into(),
        ));
    }
    if tokens.len() > MOBILE_SHARE_WRITE_BYTE_LIMIT {
        return Err(MobileWritePayloadError::TooLarge(format!(
            "Mobile writes are limited to {MOBILE_SHARE_WRITE_BYTE_LIMIT} bytes."
        )));
    }
    let mut bytes = Vec::with_capacity(tokens.len());
    for token in tokens {
        let digits = token
            .strip_prefix("0x")
            .or_else(|| token.strip_prefix("0X"))
            .unwrap_or(token);
        if digits.len() != 2 || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(MobileWritePayloadError::Invalid(format!(
                "{token:?} is not a byte. Use two hex digits such as 7E or 0x7E."
            )));
        }
        let byte = u8::from_str_radix(digits, 16).map_err(|_| {
            MobileWritePayloadError::Invalid(format!(
                "{token:?} is not a byte. Use two hex digits such as 7E or 0x7E."
            ))
        })?;
        bytes.push(byte);
    }
    Ok(bytes)
}

fn check_mobile_write_rate(
    limiter: &Mutex<MobileWriteRateState>,
    byte_count: usize,
) -> CommandResult<()> {
    let mut state = limiter.lock().map_err(lock_error)?;
    check_mobile_write_rate_at(&mut state, Instant::now(), byte_count)
}

fn check_mobile_write_rate_at(
    state: &mut MobileWriteRateState,
    now: Instant,
    byte_count: usize,
) -> CommandResult<()> {
    if byte_count > MOBILE_SHARE_WRITE_RATE_BYTE_LIMIT {
        return Err(format!(
            "Remote control is limited to {MOBILE_SHARE_WRITE_RATE_BYTE_LIMIT} bytes per second."
        ));
    }
    let window_expired = match state.window_started {
        None => true,
        Some(started) => now
            .checked_duration_since(started)
            .is_some_and(|elapsed| elapsed >= MOBILE_SHARE_WRITE_RATE_WINDOW),
    };
    if window_expired {
        state.window_started = Some(now);
        state.request_count = 0;
        state.byte_count = 0;
    }
    if state.request_count >= MOBILE_SHARE_WRITE_REQUEST_LIMIT
        || state.byte_count.saturating_add(byte_count) > MOBILE_SHARE_WRITE_RATE_BYTE_LIMIT
    {
        return Err(format!(
            "Remote control is limited to {MOBILE_SHARE_WRITE_REQUEST_LIMIT} writes and {MOBILE_SHARE_WRITE_RATE_BYTE_LIMIT} bytes per second."
        ));
    }
    state.request_count += 1;
    state.byte_count += byte_count;
    Ok(())
}

fn is_json_content_type(headers: &HashMap<String, String>) -> bool {
    headers
        .get("content-type")
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

fn write_mobile_json_response<T: Serialize>(
    stream: &TcpStream,
    status: &str,
    payload: &T,
    headers: &[(&str, &str)],
) -> io::Result<()> {
    let body = serde_json::to_vec(payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let mut response_headers = vec![
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
    ];
    response_headers.extend_from_slice(headers);
    write_http_response(
        stream,
        status,
        "application/json; charset=utf-8",
        &body,
        &response_headers,
    )
}

fn write_mobile_error_response(
    stream: &TcpStream,
    status: &str,
    error: &str,
    headers: &[(&str, &str)],
) {
    let payload = MobileErrorResponse {
        ok: false,
        error: error.into(),
    };
    let _ = write_mobile_json_response(stream, status, &payload, headers);
}

fn handle_mobile_share_write(
    stream: &TcpStream,
    request: &MobileShareRequest,
    context: &MobileShareServerContext,
    port: &str,
) {
    if !mobile_share_bearer_matches(&request.headers, &context.token) {
        write_mobile_error_response(
            stream,
            "401 Unauthorized",
            "A valid mobile share capability is required.",
            &[("WWW-Authenticate", "Bearer")],
        );
        return;
    }
    if !context.control_enabled.load(Ordering::Acquire) {
        write_mobile_error_response(
            stream,
            "403 Forbidden",
            "Remote control is disabled on the desktop. Enable it in the Mobile companion panel first.",
            &[],
        );
        return;
    }
    if context.stop.load(Ordering::Acquire) || context.session_stop.load(Ordering::Acquire) {
        write_mobile_error_response(
            stream,
            "503 Service Unavailable",
            "This mobile link or serial session is no longer active.",
            &[],
        );
        return;
    }
    if !is_json_content_type(&request.headers) {
        write_mobile_error_response(
            stream,
            "415 Unsupported Media Type",
            "Write requests must use Content-Type: application/json.",
            &[],
        );
        return;
    }
    let payload = match parse_mobile_write_payload(&request.body) {
        Ok(payload) => payload,
        Err(MobileWritePayloadError::Invalid(error)) => {
            write_mobile_error_response(stream, "400 Bad Request", &error, &[]);
            return;
        }
        Err(MobileWritePayloadError::TooLarge(error)) => {
            write_mobile_error_response(stream, "413 Payload Too Large", &error, &[]);
            return;
        }
    };
    if let Err(error) = check_mobile_write_rate(&context.write_rate_limiter, payload.bytes.len()) {
        write_mobile_error_response(
            stream,
            "429 Too Many Requests",
            &error,
            &[("Retry-After", "1")],
        );
        return;
    }
    let result = write_serial_bytes_authorized(
        context.writer.as_ref(),
        context.session_stop.as_ref(),
        port,
        &payload.bytes,
        || context.control_enabled.load(Ordering::Acquire) && !context.stop.load(Ordering::Acquire),
    );
    match result {
        Ok(written_bytes) => {
            let response = MobileWriteSuccessResponse {
                ok: true,
                mode: payload.mode,
                written_bytes,
                message: "Bytes written to the selected serial session.",
            };
            let _ = write_mobile_json_response(stream, "200 OK", &response, &[]);
        }
        Err(error) => {
            let status = if !context.control_enabled.load(Ordering::Acquire) {
                "403 Forbidden"
            } else if context.stop.load(Ordering::Acquire)
                || context.session_stop.load(Ordering::Acquire)
            {
                "503 Service Unavailable"
            } else {
                "500 Internal Server Error"
            };
            write_mobile_error_response(stream, status, &error, &[]);
        }
    }
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
    replay: Arc<Mutex<MobileReplayBuffer>>,
    clients: Arc<Mutex<HashMap<u64, std::sync::mpsc::SyncSender<String>>>>,
    next_client_id: Arc<AtomicU64>,
    after_sequence: Option<u64>,
) {
    let Some(key) = validated_websocket_key(headers) else {
        let _ = write_http_response(
            stream,
            "400 Bad Request",
            "text/plain; charset=utf-8",
            b"WebSocket upgrade required.\n",
            &[],
        );
        return;
    };
    let accept = websocket_accept_key(key);
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nCache-Control: no-store\r\n\r\n"
    );
    if stream.write_all(response.as_bytes()).is_err() || stream.flush().is_err() {
        return;
    }
    let client_id = next_client_id.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = std::sync::mpsc::sync_channel(MOBILE_SHARE_QUEUE_LIMIT);
    let registered =
        register_mobile_share_client(client_id, after_sequence, &replay, &clients, sender);
    if !registered {
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
    let (close_code, close_reason) = mobile_share_close_status(stop.load(Ordering::Acquire));
    let _ = write_websocket_close(stream, close_code, close_reason);
}

fn mobile_share_close_status(share_stopping: bool) -> (u16, &'static str) {
    if share_stopping {
        (1000, "Sharing ended")
    } else {
        // A slow queue or a transient socket write failure should let the
        // mobile page reconnect from its last sequence instead of looking
        // like an intentional share revocation.
        (1012, "Connection interrupted")
    }
}

/// Snapshotting the replay and inserting a client share the same lock order as
/// live publishing (`replay` then `clients`). That makes the handoff atomic:
/// a data event is either in the replay sent to this client or queued after it,
/// never both and never neither.
fn register_mobile_share_client(
    client_id: u64,
    after_sequence: Option<u64>,
    replay: &Arc<Mutex<MobileReplayBuffer>>,
    clients: &Arc<Mutex<HashMap<u64, std::sync::mpsc::SyncSender<String>>>>,
    sender: std::sync::mpsc::SyncSender<String>,
) -> bool {
    let Ok(replay) = replay.lock() else {
        return false;
    };
    let snapshot = replay.snapshot_after(after_sequence);
    let replay_capacity = MOBILE_SHARE_QUEUE_LIMIT.saturating_sub(1);
    let first_replay_index = snapshot.events.len().saturating_sub(replay_capacity);
    let Ok(notice) = serde_json::to_string(&MobileReplayNotice {
        kind: "replay",
        first_sequence: snapshot.first_sequence,
        next_sequence: snapshot.next_sequence,
        replay_truncated: snapshot.replay_truncated || first_replay_index > 0,
    }) else {
        return false;
    };
    let Ok(mut clients) = clients.lock() else {
        return false;
    };
    if clients.len() >= MOBILE_SHARE_CLIENT_LIMIT {
        return false;
    }
    // The replay event bound deliberately leaves room for this notice and
    // future live events. Retain the newest part if a future configuration
    // changes those bounds without allowing an unbounded initial queue.
    if sender.try_send(notice).is_err() {
        return false;
    }
    for event in snapshot.events.iter().skip(first_replay_index) {
        let Ok(payload) = serde_json::to_string(event) else {
            return false;
        };
        if sender.try_send(payload).is_err() {
            return false;
        }
    }
    clients.insert(client_id, sender);
    true
}

fn serve_mobile_workspace_websocket(
    stream: &mut TcpStream,
    headers: &HashMap<String, String>,
    context: &MobileWorkspaceShareServerContext,
    after_sequence: Option<u64>,
) {
    let Some(key) = validated_websocket_key(headers) else {
        let _ = write_http_response(
            stream,
            "400 Bad Request",
            "text/plain; charset=utf-8",
            b"WebSocket upgrade required.\n",
            &[],
        );
        return;
    };
    let accept = websocket_accept_key(key);
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nCache-Control: no-store\r\n\r\n"
    );
    if stream.write_all(response.as_bytes()).is_err() || stream.flush().is_err() {
        return;
    }
    let client_id = context.next_client_id.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = std::sync::mpsc::sync_channel(MOBILE_SHARE_EVENT_QUEUE_LIMIT);
    let Some(snapshot) = register_mobile_workspace_client(
        client_id,
        after_sequence,
        &context.sessions,
        &context.replay,
        &context.clients,
        sender,
    ) else {
        let _ = write_websocket_close(stream, 1013, "Too many viewers");
        return;
    };
    if write_websocket_text(stream, &snapshot).is_err() {
        if let Ok(mut clients) = context.clients.lock() {
            clients.remove(&client_id);
        }
        return;
    }

    let _ = stream.set_write_timeout(Some(MOBILE_SHARE_WRITE_TIMEOUT));
    let mut last_heartbeat = Instant::now();
    while !context.stop.load(Ordering::Acquire) {
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
    if let Ok(mut clients) = context.clients.lock() {
        clients.remove(&client_id);
    }
    let (close_code, close_reason) =
        mobile_share_close_status(context.stop.load(Ordering::Acquire));
    let _ = write_websocket_close(stream, close_code, close_reason);
}

/// Registration follows the same replay-then-client lock order as live
/// publishing. A workspace event is therefore either queued from the replay
/// tail or queued as live traffic, never both and never neither.
fn register_mobile_workspace_client(
    client_id: u64,
    after_sequence: Option<u64>,
    sessions: &Arc<Mutex<BTreeMap<String, MobileWorkspaceSession>>>,
    replay: &Arc<Mutex<MobileWorkspaceReplayBuffer>>,
    clients: &Arc<Mutex<HashMap<u64, std::sync::mpsc::SyncSender<String>>>>,
    sender: std::sync::mpsc::SyncSender<String>,
) -> Option<String> {
    let replay = replay.lock().ok()?;
    let snapshot = replay.snapshot_after(after_sequence);
    let replay_capacity = MOBILE_SHARE_EVENT_QUEUE_LIMIT.saturating_sub(1);
    let first_replay_index = snapshot.events.len().saturating_sub(replay_capacity);
    let notice = serde_json::to_string(&MobileWorkspaceReplayNotice {
        kind: "replay",
        first_sequence: snapshot.first_sequence,
        next_sequence: snapshot.next_sequence,
        replay_truncated: snapshot.replay_truncated || first_replay_index > 0,
    })
    .ok()?;
    let workspace_snapshot = mobile_workspace_snapshot_payload(sessions)?;
    let mut clients = clients.lock().ok()?;
    let delivery_sender = sender.clone();
    register_mobile_client(&mut clients, client_id, sender)?;
    if delivery_sender.try_send(notice).is_err() {
        clients.remove(&client_id);
        return None;
    }
    for event in snapshot.events.iter().skip(first_replay_index) {
        if delivery_sender.try_send(event.payload.clone()).is_err() {
            clients.remove(&client_id);
            return None;
        }
    }
    Some(workspace_snapshot)
}

fn mobile_workspace_snapshot_payload(
    sessions: &Arc<Mutex<BTreeMap<String, MobileWorkspaceSession>>>,
) -> Option<String> {
    let sessions = sessions.lock().ok()?.values().cloned().collect();
    serde_json::to_string(&MobileWorkspaceMessage::Snapshot { sessions }).ok()
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
    replay: &Arc<Mutex<MobileReplayBuffer>>,
    event: &SerialDataEvent,
) {
    let clients = match shares.lock() {
        Ok(shares) => shares
            .get(&event.session_id)
            .map(|share| Arc::clone(&share.clients)),
        Err(_) => None,
    };
    let Some(clients) = clients else {
        return;
    };
    let payload = match serde_json::to_string(event) {
        Ok(payload) => payload,
        Err(_) => return,
    };
    // Publishing owns the replay-to-live handoff lock. A client registering at
    // this point therefore sees this event either in its snapshot or queued
    // after the snapshot, never twice and never out of order.
    let Ok(mut replay) = replay.lock() else {
        return;
    };
    replay.push(event.clone());
    if let Ok(mut clients) = clients.lock() {
        clients.retain(|_, sender| sender.try_send(payload.clone()).is_ok());
    };
}

fn broadcast_mobile_workspace_serial_data(
    share_state: &Arc<Mutex<Option<ActiveMobileWorkspaceShare>>>,
    event: &SerialDataEvent,
) {
    let (sessions, replay, clients) = match share_state.lock() {
        Ok(share) => share.as_ref().map_or((None, None, None), |share| {
            (
                Some(Arc::clone(&share.sessions)),
                Some(Arc::clone(&share.replay)),
                Some(Arc::clone(&share.clients)),
            )
        }),
        Err(_) => (None, None, None),
    };
    let (Some(sessions), Some(replay), Some(clients)) = (sessions, replay, clients) else {
        return;
    };
    if !sessions
        .lock()
        .ok()
        .is_some_and(|sessions| sessions.contains_key(&event.session_id))
    {
        return;
    }
    publish_mobile_workspace_event(
        &replay,
        &clients,
        MobileWorkspaceReplayEventKind::Data {
            event: event.clone(),
        },
    );
}

fn broadcast_mobile_workspace_status(
    share_state: &Arc<Mutex<Option<ActiveMobileWorkspaceShare>>>,
    info: &SessionInfo,
    status: &str,
    message: &str,
) {
    let (sessions, replay, clients) = match share_state.lock() {
        Ok(share) => share.as_ref().map_or((None, None, None), |share| {
            (
                Some(Arc::clone(&share.sessions)),
                Some(Arc::clone(&share.replay)),
                Some(Arc::clone(&share.clients)),
            )
        }),
        Err(_) => (None, None, None),
    };
    let (Some(sessions), Some(replay), Some(clients)) = (sessions, replay, clients) else {
        return;
    };
    let bounded_message = bound_mobile_workspace_message(message);
    let included = sessions.lock().ok().and_then(|mut sessions| {
        let session = sessions.get_mut(&info.id)?;
        session.state = status.into();
        session.message = bounded_message.clone();
        Some(())
    });
    if included.is_none() {
        return;
    }
    publish_mobile_workspace_event(
        &replay,
        &clients,
        MobileWorkspaceReplayEventKind::Status {
            session_id: info.id.clone(),
            port: info.port.clone(),
            status: status.into(),
            message: bounded_message,
        },
    );
}

fn publish_mobile_workspace_event(
    replay: &Arc<Mutex<MobileWorkspaceReplayBuffer>>,
    clients: &Arc<Mutex<HashMap<u64, std::sync::mpsc::SyncSender<String>>>>,
    event: MobileWorkspaceReplayEventKind,
) {
    let Ok(mut replay) = replay.lock() else {
        return;
    };
    let Some(payload) = replay.push(event) else {
        return;
    };
    if let Ok(mut clients) = clients.lock() {
        clients.retain(|_, sender| sender.try_send(payload.clone()).is_ok());
    }
}

fn bound_mobile_workspace_message(message: &str) -> String {
    if message.len() <= MOBILE_WORKSPACE_MESSAGE_BYTE_LIMIT {
        return message.into();
    }
    let mut end = MOBILE_WORKSPACE_MESSAGE_BYTE_LIMIT.saturating_sub(3);
    while end > 0 && !message.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &message[..end])
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

fn validated_websocket_key(headers: &HashMap<String, String>) -> Option<&str> {
    let upgrade = headers
        .get("upgrade")
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let connection_upgrade = headers.get("connection").is_some_and(|value| {
        value
            .split(',')
            .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
    });
    let version_ok = headers
        .get("sec-websocket-version")
        .is_some_and(|value| value == "13");
    let key = headers
        .get("sec-websocket-key")
        .filter(|key| key.len() <= 128)?;
    let key_bytes = base64_decode(key)?;
    if upgrade && connection_upgrade && version_ok && key_bytes.len() == 16 {
        Some(key)
    } else {
        None
    }
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

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    if input.is_empty() || input.len() % 4 != 0 {
        return None;
    }
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    let chunks = input.as_bytes().chunks_exact(4);
    let chunk_count = chunks.len();
    for (chunk_index, chunk) in chunks.enumerate() {
        let is_last = chunk_index + 1 == chunk_count;
        let a = decode_base64_char(chunk[0])?;
        let b = decode_base64_char(chunk[1])?;
        let c = match chunk[2] {
            b'=' => 64,
            byte => decode_base64_char(byte)?,
        };
        let d = match chunk[3] {
            b'=' => 64,
            byte => decode_base64_char(byte)?,
        };
        if (!is_last && d == 64) || (c == 64 && d != 64) {
            return None;
        }
        // Reject non-canonical encodings with non-zero bits hidden by
        // padding. This also keeps padding from representing an ambiguous
        // WebSocket nonce.
        if c == 64 && b & 0x0f != 0 {
            return None;
        }
        if d == 64 && c != 64 && c & 0x03 != 0 {
            return None;
        }
        output.push((a << 2) | (b >> 4));
        if c != 64 {
            output.push((b << 4) | (c >> 2));
        }
        if d != 64 {
            output.push((c << 6) | d);
        }
    }
    Some(output)
}

fn decode_base64_char(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
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

const MOBILE_SHARE_PAGE: &str = r###"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#111827">
  <title>BaudTide mobile log</title>
  <script>document.documentElement.classList.add('mobile-ready')</script>
  <style>
    :root{color-scheme:dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box}
    body{margin:0;background:#111827;color:#e5e7eb;font-size:15px}
    main{max-width:960px;margin:auto;padding:14px}
    header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
    h1{font-size:1.18rem;line-height:1.2;margin:0 0 4px}
    #state{display:block;color:#93c5fd;font-size:.84rem}
    #summary{display:block;margin-top:3px;color:#94a3b8;font-size:.72rem}
    a{color:#bfdbfe}
    .controls{display:grid;gap:9px;margin-bottom:10px;padding:10px;border:1px solid #374151;border-radius:9px;background:#172131}
    .control-row,.filter-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
    button{min-height:34px;border:1px solid #4b5563;border-radius:7px;color:#e5e7eb;background:#1f2937;padding:7px 10px;font:inherit;font-size:.8rem;cursor:pointer}
    button:hover{border-color:#7dd3fc;background:#26364a}
    button.active{border-color:#4adeba;background:#173d38;color:#baf5e3}
    button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #75dfc0;outline-offset:2px}
    .download-actions{display:flex;align-items:center;gap:12px;margin-left:auto;flex-wrap:wrap}
    .download{padding:8px 2px;font-size:.8rem}
    .share-log{border:0;background:transparent;color:#bfdbfe;padding:8px 2px;font-size:.8rem}
    .share-log:hover{border-color:transparent;background:transparent;color:#e0f2fe;text-decoration:underline}
    .share-log:disabled{cursor:wait}
    .excerpt-row{align-items:center}.excerpt-label,.export-format{color:#9caec0;font-size:.72rem}.export-format{display:flex;align-items:center;gap:5px}.export-format select{min-height:34px;border:1px solid #4b5563;border-radius:7px;padding:7px 8px;color:#e5e7eb;background:#1f2937;font:inherit;font-size:.8rem}.excerpt-status{min-height:1.1em;color:#a7f3d0;font-size:.72rem}
    .search{display:flex;align-items:center;gap:7px;color:#b6c5d5;font-size:.78rem}
    .search input{width:100%;min-width:0;border:1px solid #4b5563;border-radius:7px;padding:8px 9px;background:#0b1220;color:#f3f4f6;font:inherit;font-size:.82rem}
    .filter-label{color:#9caec0;font-size:.72rem}
    .filter-row button{min-height:29px;padding:4px 9px;font-size:.72rem}
    #notice{margin:0 0 10px;padding:8px 10px;border:1px solid #755e32;border-radius:7px;background:#302817;color:#f5d58a;font-size:.76rem;line-height:1.35}
    #log{height:66vh;min-height:360px;max-height:760px;overflow:auto;border:1px solid #374151;border-radius:9px;background:#030712;padding:8px;line-height:1.38;overscroll-behavior:contain}
    .entry{display:grid;grid-template-columns:86px minmax(0,1fr);gap:8px;padding:3px 4px;border-bottom:1px solid #111827;white-space:pre-wrap;overflow-wrap:anywhere}
    .entry-time{color:#7dd3fc;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
    .entry-text{color:#e5e7eb;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
    .empty{padding:28px 12px;color:#8190a2;text-align:center;font-size:.82rem}
    .control{display:grid;gap:8px;margin-bottom:10px;padding:10px;border:1px solid #4b5563;border-radius:9px;background:#172033}
    .control h2{font-size:.92rem;margin:0}.control p{margin:0;color:#cbd5e1;font-size:.76rem;line-height:1.45}
    .control-status{color:#fbbf24;font-size:.8rem;font-weight:700}.control-status.enabled{color:#86efac}
    .control-form{display:grid;gap:8px}.control-form-row{display:flex;gap:8px;align-items:center}
    .control-form-row select{border:1px solid #4b5563;border-radius:6px;color:#e5e7eb;background:#1f2937;padding:8px;font:inherit;font-size:.8rem}
    textarea{box-sizing:border-box;width:100%;min-height:68px;resize:vertical;border:1px solid #4b5563;border-radius:6px;background:#030712;color:#f9fafb;padding:9px;font:inherit;line-height:1.4}
    button:disabled,textarea:disabled,select:disabled{opacity:.55;cursor:not-allowed}.control-hint,.control-message{color:#94a3b8;font-size:.72rem}.control-message{min-height:1.1em;color:#a7f3d0}
    .mobile-launch-splash{display:none}.mobile-app{transition:opacity .42s cubic-bezier(.16,1,.3,1),transform .42s cubic-bezier(.16,1,.3,1)}html.mobile-ready .mobile-launch-splash{position:fixed;z-index:20;inset:0;display:grid;place-items:center;overflow:hidden;isolation:isolate;background:radial-gradient(ellipse 64% 48% at 50% 46%,#123a46 0%,#0d2631 38%,transparent 73%),radial-gradient(ellipse 75% 64% at 110% -12%,#183e51 0%,transparent 64%),#090f18;color:#edf7f6}html.mobile-ready .mobile-app{opacity:0;transform:translateY(10px)}.mobile-launch-splash::before{position:absolute;z-index:-1;inset:0;content:"";opacity:.52;background-image:linear-gradient(#9de5dc0a 1px,transparent 1px),linear-gradient(90deg,#9de5dc0a 1px,transparent 1px);background-size:34px 34px;mask-image:radial-gradient(ellipse 78% 76% at 50% 44%,#000 0%,transparent 76%)}.mobile-launch-content{display:grid;justify-items:center;padding:24px;text-align:center;animation:mobile-launch-enter .6s cubic-bezier(.16,1,.3,1) both}.mobile-launch-mark{position:relative;width:min(35vw,138px);min-width:106px;filter:drop-shadow(0 18px 25px #0017219c);animation:mobile-launch-mark .72s .05s cubic-bezier(.16,1,.3,1) both}.mobile-launch-mark::before{position:absolute;z-index:-1;inset:18%;border-radius:50%;content:"";background:#35e6c9;opacity:.25;filter:blur(24px)}.mobile-launch-mark svg{display:block;width:100%;height:auto}.mobile-launch-frame{fill:none;stroke:#113a62;stroke-width:9;stroke-linecap:round;stroke-linejoin:round}.mobile-launch-wave{fill:none;stroke:url(#mobile-launch-gradient);stroke-width:8;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:88;stroke-dashoffset:88;animation:mobile-launch-wave .72s .35s ease-out forwards}.mobile-launch-node{fill:#20dfcf;opacity:0;animation:mobile-launch-node .2s .95s ease-out forwards}.mobile-launch-name{margin-top:17px;color:#f0faf8;font:800 1.88rem/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:-.08em}.mobile-launch-name span{color:#7ee1c3}.mobile-launch-copy{margin:10px 0 0;color:#9fd6c9;font-size:.61rem;font-weight:800;letter-spacing:.17em}.mobile-launch-loader{position:absolute;bottom:max(37px,7vh);display:grid;gap:10px;width:min(220px,calc(100vw - 48px));animation:mobile-launch-enter .55s .24s cubic-bezier(.16,1,.3,1) both}.mobile-launch-loader span{display:flex;align-items:center;justify-content:center;gap:8px;color:#a7bac7;font-size:.7rem}.mobile-launch-loader span::before{width:6px;height:6px;border-radius:50%;content:"";background:#7be0c2;box-shadow:0 0 0 4px #7be0c21a,0 0 15px #7be0c2a3;animation:mobile-launch-dot 1.1s ease-in-out infinite}.mobile-launch-progress{height:2px;overflow:hidden;border-radius:999px;background:#8fe8d31c}.mobile-launch-progress i{display:block;width:52%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#5acbb0,#9af1d4);box-shadow:0 0 13px #65dbbe8c;animation:mobile-launch-progress 1.15s cubic-bezier(.3,.04,.2,1) both}.mobile-launch-splash.is-leaving{pointer-events:none;animation:mobile-launch-exit .34s cubic-bezier(.4,0,1,1) forwards}html.mobile-ready .mobile-app.is-visible{opacity:1;transform:translateY(0)}@keyframes mobile-launch-enter{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}@keyframes mobile-launch-mark{from{opacity:0;transform:scale(.72)}to{opacity:1;transform:scale(1)}}@keyframes mobile-launch-wave{to{stroke-dashoffset:0}}@keyframes mobile-launch-node{to{opacity:1}}@keyframes mobile-launch-dot{50%{transform:scale(1.18);opacity:.64}}@keyframes mobile-launch-progress{from{transform:translateX(-100%)}to{transform:translateX(195%)}}@keyframes mobile-launch-exit{to{opacity:0;transform:scale(1.012)}}
    @media(max-width:520px){main{padding:10px}.download-actions{width:100%;margin-left:0;justify-content:space-between}.entry{grid-template-columns:72px minmax(0,1fr);gap:6px}.entry-time{font-size:10px}.entry-text{font-size:11px}#log{min-height:320px;height:64vh}.control-form-row{align-items:stretch;flex-direction:column}.control-form-row button,.control-form-row select{width:100%}.export-format{width:100%;justify-content:space-between}.excerpt-status{width:100%}}
    @media(prefers-reduced-motion:reduce){.mobile-launch-content,.mobile-launch-mark,.mobile-launch-wave,.mobile-launch-node,.mobile-launch-loader,.mobile-launch-loader span::before,.mobile-launch-progress i,.mobile-launch-splash.is-leaving,.mobile-app{animation:none;transition:none}}
  </style>
</head>
<body>
  <div id="mobile-launch-splash" class="mobile-launch-splash" role="status" aria-live="polite" aria-label="Opening BaudTide mobile companion">
    <div class="mobile-launch-content">
      <div class="mobile-launch-mark" aria-hidden="true"><svg viewBox="0 0 120 120"><defs><linearGradient id="mobile-launch-gradient" x1="31" y1="0" x2="91" y2="0" gradientUnits="userSpaceOnUse"><stop stop-color="#52e7a8"/><stop offset="1" stop-color="#19c9f1"/></linearGradient></defs><path class="mobile-launch-frame" d="M32 39 60 21l29 18v15M89 81v1L60 100 31 82l13-11"/><path class="mobile-launch-wave" d="M36 67h13c7 0 7-13 14-13s7 13 14 13h7c7 0 7-13 14-13"/><circle class="mobile-launch-node" cx="36" cy="67" r="5"/><circle class="mobile-launch-node" cx="91" cy="54" r="5"/></svg></div>
      <div class="mobile-launch-name">baud<span>tide</span></div>
      <p class="mobile-launch-copy">MOBILE COMPANION</p>
    </div>
    <div class="mobile-launch-loader" aria-hidden="true"><span>Loading live workspace</span><div class="mobile-launch-progress"><i></i></div></div>
  </div>
  <main id="mobile-app" class="mobile-app" aria-hidden="true">
    <header>
      <div><h1>BaudTide · live serial log</h1><span id="state" role="status">Connecting…</span><span id="summary">Waiting for a recent capture tail…</span></div>
      <div class="download-actions"><button id="share-raw" class="share-log" type="button">Send logs</button><a id="download" class="download" download>Download raw (.log)</a></div>
    </header>
    <section class="controls" aria-label="Log viewer controls">
      <div class="control-row">
        <button id="pause" type="button">Pause</button>
        <button id="follow" type="button" aria-pressed="true">Following</button>
        <button id="latest" type="button" hidden>Jump to latest</button>
      </div>
      <label class="search">Search <input id="search" type="search" maxlength="128" autocomplete="off" placeholder="Find in the recent tail"></label>
      <div class="filter-row" role="group" aria-label="High-signal filters">
        <span class="filter-label">Show</span>
        <button type="button" data-filter="all" class="active">All</button>
        <button type="button" data-filter="errors">Errors</button>
        <button type="button" data-filter="wifi">Wi-Fi</button>
      </div>
      <div class="control-row excerpt-row" aria-label="Visible log excerpt">
        <span class="excerpt-label">Export visible</span>
        <label class="export-format" for="export-format">Format
          <select id="export-format">
            <option value="txt">Text (.txt)</option>
            <option value="json">JSON (.json)</option>
          </select>
        </label>
        <button id="copy-visible" type="button">Copy visible</button>
        <button id="download-visible" type="button">Download visible</button>
        <span id="excerpt-status" class="excerpt-status" role="status" aria-live="polite"></span>
      </div>
    </section>
    <section class="control" aria-labelledby="control-heading">
      <h2 id="control-heading">Send to serial device</h2>
      <p>Read-only is the default. The desktop operator must explicitly enable remote control for this paired link. Text is sent as UTF-8 exactly as entered; hex sends exact bytes with no line ending.</p>
      <div id="control-state" class="control-status" role="status" aria-live="polite">Checking desktop permission…</div>
      <form id="control-form" class="control-form">
        <div class="control-form-row"><select id="control-mode" aria-label="Send mode" disabled><option value="text">Text</option><option value="hex">Exact hex bytes</option></select><button id="control-send" type="submit" disabled>Send to serial device</button></div>
        <textarea id="control-input" maxlength="16384" placeholder="Enable remote control on the desktop first" disabled></textarea>
        <p class="control-hint">Text: UTF-8 bytes. Hex: two-digit bytes separated by spaces or commas, such as 7E 00 FF.</p>
        <p id="control-message" class="control-message" role="status" aria-live="polite"></p>
      </form>
    </section>
    <div id="notice" hidden></div>
    <div id="log" role="log" aria-live="polite" aria-label="Serial log"><div class="empty">Waiting for serial data…</div></div>
  </main>
  <script>
  (()=>{
    'use strict';
    const log=document.querySelector('#log');
    const state=document.querySelector('#state');
    const summary=document.querySelector('#summary');
    const notice=document.querySelector('#notice');
    const pauseButton=document.querySelector('#pause');
    const followButton=document.querySelector('#follow');
    const latestButton=document.querySelector('#latest');
    const searchInput=document.querySelector('#search');
    const shareRawButton=document.querySelector('#share-raw');
    const download=document.querySelector('#download');
    const copyVisibleButton=document.querySelector('#copy-visible');
    const downloadVisibleButton=document.querySelector('#download-visible');
    const exportFormat=document.querySelector('#export-format');
    const excerptStatus=document.querySelector('#excerpt-status');
    const controlState=document.querySelector('#control-state');
    const controlForm=document.querySelector('#control-form');
    const controlMode=document.querySelector('#control-mode');
    const controlInput=document.querySelector('#control-input');
    const controlSend=document.querySelector('#control-send');
    const controlMessage=document.querySelector('#control-message');
    const splash=document.querySelector('#mobile-launch-splash');
    const app=document.querySelector('#mobile-app');
    const base=location.pathname.replace(/\/$/,'');
    const token=base.split('/').pop();
    download.href=base+'/download';
    const MAX_RETAINED_EVENTS=700;
    const MAX_RETAINED_BYTES=320000;
    const MAX_RECONNECT_DELAY=8000;
    const ERROR_PATTERN=/\b(?:error|err|fail(?:ed|ure)?|panic|fatal|exception|abort(?:ed)?)\b/i;
    const WIFI_PATTERN=/\b(?:wi-?fi|wlan|ssid|bssid|rssi|ip address|disconnect(?:ed|ion)?|reconnect(?:ed|ing)?)\b/i;
    let socket=null;
    let reconnectTimer=null;
    let reconnectAttempt=0;
    let stopped=false;
    let paused=false;
    let follow=true;
    let filter='all';
    let query='';
    let entries=[];
    let retainedBytes=0;
    let lastSequence=0;
    let renderPending=false;
    let connectionLabel='Connecting…';
    let controlEnabled=false;
    let controlRefreshTimer=null;

    const revealMobileApp=()=>{
      app.classList.add('is-visible');app.removeAttribute('aria-hidden');splash.classList.add('is-leaving');
      window.setTimeout(()=>splash.remove(),360);
    };
    window.setTimeout(revealMobileApp,matchMedia('(prefers-reduced-motion: reduce)').matches?0:1250);

    function pad(value,width=2){return String(value).padStart(width,'0')}
    function timestamp(value){
      const date=new Date(typeof value==='string'?value:'');
      if(Number.isNaN(date.getTime())) return typeof value==='string'&&value?value:'—';
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(),3)}`;
    }
    function setConnection(label){
      connectionLabel=label;
      state.textContent=paused&&label.startsWith('Live')?`${label} · paused`:label;
    }
    function setNotice(message){
      notice.textContent=message||'';
      notice.hidden=!message;
    }
    function setControlState(enabled,message){
      controlEnabled=enabled;
      controlState.textContent=message|| (enabled?'Remote control enabled by desktop':'Read-only · desktop permission required');
      controlState.className='control-status'+(enabled?' enabled':'');
      controlInput.disabled=!enabled;
      controlMode.disabled=!enabled;
      controlSend.disabled=!enabled;
      controlInput.placeholder=enabled?'Type text or hex bytes…':'Enable remote control on the desktop first';
    }
    async function controlRequest(path,options={}){
      const response=await fetch(path,{...options,headers:{Authorization:'Bearer '+token,...(options.headers||{})}});
      let payload={};
      try{payload=await response.json()}catch{}
      if(!response.ok) throw new Error(payload.error||'Request failed ('+response.status+')');
      return payload;
    }
    async function refreshControl(){
      try{const status=await controlRequest(base+'/control/status');setControlState(Boolean(status.controlEnabled))}
      catch{setControlState(false,'Read-only · desktop permission unavailable')}
    }
    function updateFollowButton(){
      followButton.textContent=follow?'Following':'Follow';
      followButton.setAttribute('aria-pressed',String(follow));
      followButton.classList.toggle('active',follow);
      latestButton.hidden=follow;
    }
    function matches(entry){
      const text=entry.text.toLowerCase();
      const needle=query.trim().toLowerCase();
      if(needle&&!text.includes(needle)) return false;
      if(filter==='errors'&&!ERROR_PATTERN.test(entry.text)) return false;
      if(filter==='wifi'&&!WIFI_PATTERN.test(entry.text)) return false;
      return true;
    }
    function visibleEntries(){return entries.filter(matches)}
    function excerptText(visible=visibleEntries()){
      if(!visible.length) return {visible,text:''};
      const filters=[];
      if(filter!=='all') filters.push(filter==='wifi'?'Wi-Fi':'Errors');
      if(query.trim()) filters.push(`Search: ${query.trim()}`);
      const context=filters.length?filters.join(' · '):'All retained events';
      const generated=new Date().toLocaleString();
      const lines=[
        'BaudTide · visible serial log excerpt',
        `Generated: ${generated}`,
        `View: ${context}`,
        `Events: ${visible.length} of ${entries.length} retained`,
        ''
      ];
      visible.forEach(entry=>lines.push(`[${timestamp(entry.timestamp)}] ${entry.text}`));
      return {visible,text:lines.join('\n')};
    }
    function exportJson(visible){
      return JSON.stringify({
        format:'baudtide.mobile-visible-log',
        schemaVersion:1,
        generatedAt:new Date().toISOString(),
        view:{
          filter,
          search:query.trim()||null,
          visibleEventCount:visible.length,
          retainedEventCount:entries.length
        },
        events:visible.map(entry=>({
          sequence:entry.sequence,
          timestamp:typeof entry.timestamp==='string'?entry.timestamp:null,
          text:entry.text,
          byteLength:entry.byteLength
        }))
      },null,2);
    }
    function selectedExport(){
      const visible=visibleEntries();
      const format=exportFormat.value==='json'?'json':'txt';
      return {visible,format,text:format==='json'?exportJson(visible):excerptText(visible).text};
    }
    function setExcerptStatus(message){excerptStatus.textContent=message||''}
    async function copyExcerpt(text){
      if(navigator.clipboard&&window.isSecureContext){
        await navigator.clipboard.writeText(text);
        return;
      }
      const fallback=document.createElement('textarea');
      fallback.value=text;
      fallback.setAttribute('readonly','');
      fallback.style.position='fixed';
      fallback.style.opacity='0';
      document.body.append(fallback);
      fallback.select();
      const copied=document.execCommand&&document.execCommand('copy');
      fallback.remove();
      if(!copied) throw new Error('Clipboard is unavailable');
    }
    function downloadExport(text,format){
      const isJson=format==='json';
      const file=new Blob([text+(isJson?'':'\n')],{type:isJson?'application/json;charset=utf-8':'text/plain;charset=utf-8'});
      const link=document.createElement('a');
      const stamp=new Date().toISOString().replace(/[:.]/g,'-');
      link.href=URL.createObjectURL(file);
      link.download=`baudtide-visible-log-${stamp}.${format}`;
      link.hidden=true;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(()=>URL.revokeObjectURL(link.href),0);
    }
    function downloadFile(file){
      const link=document.createElement('a');
      link.href=URL.createObjectURL(file);
      link.download=file.name;
      link.hidden=true;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(()=>URL.revokeObjectURL(link.href),0);
    }
    function rawLogFileName(response){
      const disposition=response.headers.get('Content-Disposition')||'';
      const match=disposition.match(/filename="([^"\r\n]+)"/i);
      if(match&&match[1]) return match[1];
      const stamp=new Date().toISOString().replace(/[:.]/g,'-');
      return `baudtide-serial-log-${stamp}.log`;
    }
    async function fetchRawLogFile(){
      const response=await fetch(download.href,{cache:'no-store'});
      if(!response.ok) throw new Error(`Raw log download failed (${response.status}).`);
      const blob=await response.blob();
      return new File([blob],rawLogFileName(response),{type:'text/plain'});
    }
    function canShareRawFile(file){
      if(typeof navigator.share!=='function') return false;
      if(typeof navigator.canShare!=='function') return true;
      try{return navigator.canShare({files:[file]})}catch{return false}
    }
    function canShareText(text){
      if(typeof navigator.share!=='function') return false;
      if(typeof navigator.canShare!=='function') return true;
      try{return navigator.canShare({text})}catch{return false}
    }
    async function shareRawLog(){
      if(typeof navigator.share!=='function'){
        setExcerptStatus('Native sharing is unavailable in this browser; downloading the raw log instead.');
        download.click();
        return;
      }
      shareRawButton.disabled=true;
      shareRawButton.textContent='Preparing…';
      setExcerptStatus('Preparing the raw log for sharing…');
      try{
        const file=await fetchRawLogFile();
        if(!canShareRawFile(file)){
          const excerpt=excerptText();
          if(!excerpt.visible.length||!canShareText(excerpt.text)){
            setExcerptStatus('This browser cannot share .log files; downloading the raw log instead.');
            downloadFile(file);
            return;
          }
          await navigator.share({title:'BaudTide serial log excerpt',text:excerpt.text});
          setExcerptStatus('The visible log excerpt is ready to send.');
          return;
        }
        await navigator.share({title:'BaudTide serial log',files:[file]});
        setExcerptStatus('The raw log is ready to send.');
      }catch(error){
        if(error&&typeof error==='object'&&error.name==='AbortError'){
          setExcerptStatus('Sharing canceled.');
          return;
        }
        setExcerptStatus('Native sharing failed; downloading the raw log instead.');
        download.click();
      }finally{
        shareRawButton.disabled=false;
        shareRawButton.textContent='Send logs';
      }
    }
    function render(){
      renderPending=false;
      const visible=visibleEntries();
      log.replaceChildren();
      if(!visible.length){
        const empty=document.createElement('div');
        empty.className='empty';
        empty.textContent=entries.length?'No retained chunks match this filter.':'Waiting for serial data…';
        log.append(empty);
      }else{
        const fragment=document.createDocumentFragment();
        visible.forEach(entry=>{
          const row=document.createElement('div');
          row.className='entry';
          const time=document.createElement('time');
          time.className='entry-time';
          time.textContent=timestamp(entry.timestamp);
          const text=document.createElement('span');
          text.className='entry-text';
          text.textContent=entry.text;
          row.append(time,text);
          fragment.append(row);
        });
        log.append(fragment);
      }
      summary.textContent=`${visible.length} shown · ${entries.length} retained${lastSequence?` · sequence ${lastSequence}`:''}`;
      if(follow&&!paused) log.scrollTop=log.scrollHeight;
    }
    function requestRender(){
      if(paused||renderPending) return;
      renderPending=true;
      if(window.requestAnimationFrame) window.requestAnimationFrame(render);
      else window.setTimeout(render,0);
    }
    function retain(item){
      if(!Number.isSafeInteger(item.sequence)||item.sequence<1) return;
      if(item.sequence<=lastSequence) return;
      if(lastSequence&&item.sequence>lastSequence+1) setNotice(`Some live chunks were missed; showing the available tail from sequence ${item.sequence}.`);
      lastSequence=item.sequence;
      const text=typeof item.text==='string'?item.text.slice(0,8192):'';
      const bytes=Array.isArray(item.bytes)?item.bytes.length:0;
      const size=text.length+bytes;
      entries.push({sequence:item.sequence,timestamp:item.timestamp,text,byteLength:bytes,size});
      retainedBytes+=size;
      while(entries.length>MAX_RETAINED_EVENTS||retainedBytes>MAX_RETAINED_BYTES){
        const removed=entries.shift();
        if(removed) retainedBytes=Math.max(0,retainedBytes-removed.size);
      }
      if(paused) setConnection(connectionLabel);
      requestRender();
    }
    function handleMessage(raw){
      let item;
      try{item=JSON.parse(raw)}catch{return}
      if(item&&item.kind==='replay'){
        if(item.replayTruncated){
          const first=Number.isSafeInteger(item.firstSequence)?` from sequence ${item.firstSequence}`:'';
          setNotice(`Showing the bounded recent tail${first}; older chunks are still available in the raw download.`);
        }
        return;
      }
      if(item&&typeof item==='object') retain(item);
    }
    function connect(){
      if(stopped||socket) return;
      const suffix=lastSequence?`?after=${encodeURIComponent(lastSequence)}`:'';
      const url=(location.protocol==='https:'?'wss':'ws')+'://'+location.host+base+'/events'+suffix;
      setConnection(reconnectAttempt?'Reconnecting…':'Connecting…');
      try{socket=new WebSocket(url)}catch{socket=null;scheduleReconnect();return}
      socket.onopen=()=>{
        reconnectAttempt=0;
        setConnection('Live · read-only');
      };
      socket.onmessage=event=>handleMessage(event.data);
      socket.onerror=()=>setConnection('Connection error · retrying…');
      socket.onclose=event=>{
        socket=null;
        if(stopped) return;
        if(event.code===1000&&event.reason==='Sharing ended'){
          stopped=true;
          if(controlRefreshTimer!==null) window.clearInterval(controlRefreshTimer);
          setConnection('Disconnected · sharing ended');
          return;
        }
        setConnection('Disconnected · retrying…');
        scheduleReconnect();
      };
    }
    function scheduleReconnect(){
      if(stopped||reconnectTimer) return;
      const delay=Math.min(1000*2**Math.min(reconnectAttempt,3),MAX_RECONNECT_DELAY);
      reconnectAttempt+=1;
      reconnectTimer=window.setTimeout(()=>{reconnectTimer=null;connect()},delay);
    }
    pauseButton.onclick=()=>{
      paused=!paused;
      pauseButton.textContent=paused?'Resume':'Pause';
      pauseButton.classList.toggle('active',paused);
      setConnection(connectionLabel);
      if(!paused) {render();if(follow) log.scrollTop=log.scrollHeight;}
    };
    followButton.onclick=()=>{follow=!follow;updateFollowButton();if(follow){render();log.scrollTop=log.scrollHeight}};
    latestButton.onclick=()=>{follow=true;updateFollowButton();render();log.scrollTop=log.scrollHeight};
    log.addEventListener('scroll',()=>{
      const nearBottom=log.scrollHeight-log.scrollTop-log.clientHeight<36;
      if(nearBottom!==follow){follow=nearBottom;updateFollowButton()}
    });
    searchInput.addEventListener('input',()=>{query=searchInput.value.slice(0,128);render()});
    shareRawButton.onclick=()=>{void shareRawLog()};
    copyVisibleButton.onclick=async()=>{
      const excerpt=excerptText();
      if(!excerpt.visible.length){setExcerptStatus('Nothing matches this view yet.');return}
      copyVisibleButton.disabled=true;
      setExcerptStatus('Copying visible log…');
      try{await copyExcerpt(excerpt.text);setExcerptStatus(`Copied ${excerpt.visible.length} visible event${excerpt.visible.length===1?'':'s'}.`)}
      catch{setExcerptStatus('Could not copy this excerpt. Download it instead.')}
      finally{copyVisibleButton.disabled=false}
    };
    downloadVisibleButton.onclick=()=>{
      const exportData=selectedExport();
      if(!exportData.visible.length){setExcerptStatus('Nothing matches this view yet.');return}
      try{downloadExport(exportData.text,exportData.format);setExcerptStatus(`Downloading ${exportData.visible.length} visible event${exportData.visible.length===1?'':'s'} as ${exportData.format.toUpperCase()}.`)}
      catch{setExcerptStatus('Could not prepare the download. Try again.')}
    };
    controlMode.onchange=()=>{controlInput.placeholder=controlMode.value==='hex'?'7E 00 FF or 0x7E, 0x00…':'Type text; UTF-8 bytes are sent exactly as entered'};
    controlForm.onsubmit=async(event)=>{
      event.preventDefault();
      if(!controlEnabled||!controlInput.value) return;
      controlSend.disabled=true;
      controlMessage.textContent='Sending…';
      const mode=controlMode.value;
      const payload=mode==='hex'?{mode:'hex',hex:controlInput.value}:{mode:'text',text:controlInput.value};
      try{
        const result=await controlRequest(base+'/control/write',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        controlMessage.textContent='Success · '+result.writtenBytes+' byte'+(result.writtenBytes===1?'':'s')+' written';
        controlInput.value='';
      }catch(error){
        controlMessage.textContent='Send failed · '+(error instanceof Error?error.message:'Unknown error');
        await refreshControl();
      }finally{controlSend.disabled=!controlEnabled}
    };
    document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{
      filter=button.dataset.filter||'all';
      document.querySelectorAll('[data-filter]').forEach(item=>item.classList.toggle('active',item===button));
      render();
    }));
    updateFollowButton();
    render();
    void refreshControl();
    controlRefreshTimer=window.setInterval(refreshControl,3000);
    connect();
  })();
  </script>
</body>
</html>"###;

fn mobile_workspace_share_page() -> &'static str {
    r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#0b1720">
  <title>BaudTide mobile dashboard</title>
  <script>document.documentElement.classList.add('mobile-ready')</script>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b1720;color:#e5f1ee;font:15px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(100%,980px);margin:auto;padding:16px}header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:14px}h1,h2,p{margin:0}h1{font-size:1.25rem;letter-spacing:-.02em}header p{margin-top:5px;color:#9bb2bd;font-size:.82rem}#feed-state{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border:1px solid #2b5660;border-radius:999px;color:#a9ead8;font-size:.78rem;font-weight:700}#feed-state i{width:7px;height:7px;border-radius:50%;background:#79dfbd;box-shadow:0 0 0 4px #79dfbd22}#feed-state[data-state="reconnecting"]{border-color:#8fcbf4;color:#b8dcf5}#feed-state[data-state="reconnecting"] i{background:#8fcbf4;box-shadow:0 0 0 4px #8fcbf422}#feed-state[data-state="stopped"]{border-color:#657780;color:#c4ced3}#feed-state[data-state="stopped"] i{background:#8da1ac;box-shadow:none}.layout{display:grid;grid-template-columns:minmax(190px,260px) minmax(0,1fr);gap:13px}.panel{border:1px solid #29414d;border-radius:12px;background:#10232d;box-shadow:0 12px 35px #02070b44}.panel-head{padding:13px 14px;border-bottom:1px solid #29414d}.panel-head h2{font-size:.88rem}.panel-head p{margin-top:4px;color:#8fa8b2;font-size:.72rem;line-height:1.4}.sessions{padding:8px}.session{display:block;width:100%;margin:0 0 7px;padding:11px;border:1px solid transparent;border-radius:9px;background:#142b36;color:#e5f1ee;text-align:left;cursor:pointer}.session:last-child{margin-bottom:0}.session:hover{border-color:#3b7275}.session.active{border-color:#6cc7ac;background:#173b3d}.session-title{display:flex;align-items:center;gap:7px;font-weight:750;font-size:.83rem}.session-title i{width:8px;height:8px;flex:0 0 auto;border-radius:50%;background:#79dfbd}.session-title i.error{background:#f3a6a6}.session-title i.disconnected{background:#8da1ac}.session-title i.storage-limit{background:#f2c477}.session-title i.reconnecting{background:#8fcbf4}.session-meta{display:block;margin:5px 0 0 15px;color:#a5bbc2;font:.7rem ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-state{display:block;margin:7px 0 0 15px;color:#86d5be;font-size:.67rem;font-weight:700}.stream-panel{min-width:0}.stream-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:13px 14px;border-bottom:1px solid #29414d}.stream-head h2{font-size:.92rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.stream-head p{margin-top:5px;color:#9bb2bd;font-size:.72rem}.stream-state{color:#9bb2bd;font-size:.7rem;text-align:right}.stream-state.error,.stream-state.storage-limit{color:#ffb9b9}.stream-state.disconnected{color:#c4ced3}#stream{min-height:58vh;max-height:65vh;margin:0;padding:14px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#061018;color:#d5e6e4;font:.78rem/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}#detail{min-height:22px;padding:9px 14px;border-top:1px solid #29414d;color:#a5bbc2;font-size:.72rem;line-height:1.4}.notice{margin-top:13px;padding:10px 12px;border:1px solid #38545c;border-radius:9px;background:#122933;color:#9eb7bf;font-size:.72rem;line-height:1.45}.notice strong{color:#c7e7dc}.notice[hidden]{display:none}@media(max-width:680px){main{padding:11px}.layout{grid-template-columns:1fr}.sessions{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:7px}.session,.session:last-child{margin:0}.stream-head{align-items:flex-start}#stream{min-height:52vh;max-height:62vh}}
  </style>
  <style>
    .mobile-launch-splash{display:none}.mobile-app{transition:opacity .42s cubic-bezier(.16,1,.3,1),transform .42s cubic-bezier(.16,1,.3,1)}html.mobile-ready .mobile-launch-splash{position:fixed;z-index:20;inset:0;display:grid;place-items:center;overflow:hidden;isolation:isolate;background:radial-gradient(ellipse 64% 48% at 50% 46%,#123a46 0%,#0d2631 38%,transparent 73%),radial-gradient(ellipse 75% 64% at 110% -12%,#183e51 0%,transparent 64%),#090f18;color:#edf7f6}html.mobile-ready .mobile-app{opacity:0;transform:translateY(10px)}.mobile-launch-splash::before{position:absolute;z-index:-1;inset:0;content:"";opacity:.52;background-image:linear-gradient(#9de5dc0a 1px,transparent 1px),linear-gradient(90deg,#9de5dc0a 1px,transparent 1px);background-size:34px 34px;mask-image:radial-gradient(ellipse 78% 76% at 50% 44%,#000 0%,transparent 76%)}.mobile-launch-content{display:grid;justify-items:center;padding:24px;text-align:center;animation:mobile-launch-enter .6s cubic-bezier(.16,1,.3,1) both}.mobile-launch-mark{position:relative;width:min(35vw,138px);min-width:106px;filter:drop-shadow(0 18px 25px #0017219c);animation:mobile-launch-mark .72s .05s cubic-bezier(.16,1,.3,1) both}.mobile-launch-mark::before{position:absolute;z-index:-1;inset:18%;border-radius:50%;content:"";background:#35e6c9;opacity:.25;filter:blur(24px)}.mobile-launch-mark svg{display:block;width:100%;height:auto}.mobile-launch-frame{fill:none;stroke:#113a62;stroke-width:9;stroke-linecap:round;stroke-linejoin:round}.mobile-launch-wave{fill:none;stroke:url(#mobile-launch-gradient);stroke-width:8;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:88;stroke-dashoffset:88;animation:mobile-launch-wave .72s .35s ease-out forwards}.mobile-launch-node{fill:#20dfcf;opacity:0;animation:mobile-launch-node .2s .95s ease-out forwards}.mobile-launch-name{margin-top:17px;color:#f0faf8;font:800 1.88rem/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:-.08em}.mobile-launch-name span{color:#7ee1c3}.mobile-launch-copy{margin:10px 0 0;color:#9fd6c9;font-size:.61rem;font-weight:800;letter-spacing:.17em}.mobile-launch-loader{position:absolute;bottom:max(37px,7vh);display:grid;gap:10px;width:min(220px,calc(100vw - 48px));animation:mobile-launch-enter .55s .24s cubic-bezier(.16,1,.3,1) both}.mobile-launch-loader span{display:flex;align-items:center;justify-content:center;gap:8px;color:#a7bac7;font-size:.7rem}.mobile-launch-loader span::before{width:6px;height:6px;border-radius:50%;content:"";background:#7be0c2;box-shadow:0 0 0 4px #7be0c21a,0 0 15px #7be0c2a3;animation:mobile-launch-dot 1.1s ease-in-out infinite}.mobile-launch-progress{height:2px;overflow:hidden;border-radius:999px;background:#8fe8d31c}.mobile-launch-progress i{display:block;width:52%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#5acbb0,#9af1d4);box-shadow:0 0 13px #65dbbe8c;animation:mobile-launch-progress 1.15s cubic-bezier(.3,.04,.2,1) both}.mobile-launch-splash.is-leaving{pointer-events:none;animation:mobile-launch-exit .34s cubic-bezier(.4,0,1,1) forwards}html.mobile-ready .mobile-app.is-visible{opacity:1;transform:translateY(0)}@keyframes mobile-launch-enter{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}@keyframes mobile-launch-mark{from{opacity:0;transform:scale(.72)}to{opacity:1;transform:scale(1)}}@keyframes mobile-launch-wave{to{stroke-dashoffset:0}}@keyframes mobile-launch-node{to{opacity:1}}@keyframes mobile-launch-dot{50%{transform:scale(1.18);opacity:.64}}@keyframes mobile-launch-progress{from{transform:translateX(-100%)}to{transform:translateX(195%)}}@keyframes mobile-launch-exit{to{opacity:0;transform:scale(1.012)}}@media(prefers-reduced-motion:reduce){.mobile-launch-content,.mobile-launch-mark,.mobile-launch-wave,.mobile-launch-node,.mobile-launch-loader,.mobile-launch-loader span::before,.mobile-launch-progress i,.mobile-launch-splash.is-leaving,.mobile-app{animation:none;transition:none}}
  </style>
</head>
<body>
  <div id="mobile-launch-splash" class="mobile-launch-splash" role="status" aria-live="polite" aria-label="Opening BaudTide mobile companion">
    <div class="mobile-launch-content">
      <div class="mobile-launch-mark" aria-hidden="true"><svg viewBox="0 0 120 120"><defs><linearGradient id="mobile-launch-gradient" x1="31" y1="0" x2="91" y2="0" gradientUnits="userSpaceOnUse"><stop stop-color="#52e7a8"/><stop offset="1" stop-color="#19c9f1"/></linearGradient></defs><path class="mobile-launch-frame" d="M32 39 60 21l29 18v15M89 81v1L60 100 31 82l13-11"/><path class="mobile-launch-wave" d="M36 67h13c7 0 7-13 14-13s7 13 14 13h7c7 0 7-13 14-13"/><circle class="mobile-launch-node" cx="36" cy="67" r="5"/><circle class="mobile-launch-node" cx="91" cy="54" r="5"/></svg></div>
      <div class="mobile-launch-name">baud<span>tide</span></div>
      <p class="mobile-launch-copy">MOBILE COMPANION</p>
    </div>
    <div class="mobile-launch-loader" aria-hidden="true"><span>Loading live workspace</span><div class="mobile-launch-progress"><i></i></div></div>
  </div>
  <main id="mobile-app" class="mobile-app" aria-hidden="true">
    <header>
      <div><h1>BaudTide · mobile dashboard</h1><p>Read-only live streams from the shared terminal workspace.</p></div>
      <span id="feed-state" data-state="reconnecting"><i></i><span>Connecting…</span></span>
    </header>
    <div class="layout">
      <section class="panel"><div class="panel-head"><h2>Shared terminals</h2><p id="scope">Waiting for the shared session list…</p></div><div id="sessions" class="sessions"></div></section>
      <section class="panel stream-panel"><div class="stream-head"><div><h2 id="stream-title">Choose a terminal</h2><p id="stream-meta">No stream selected</p></div><span id="stream-state" class="stream-state">Waiting</span></div><pre id="stream" aria-live="polite">The dashboard will show live output after it connects.</pre><div id="detail">Only sessions included when this link was created can appear here.</div></section>
    </div>
    <div id="recovery-notice" class="notice" role="status" hidden></div>
    <div class="notice"><strong>Local and read-only.</strong> This link works only on the same local network. The phone automatically reconnects after a Wi-Fi handoff and asks for the bounded recent workspace tail. Output keeps the newest 240,000 characters per shared stream in this phone view; raw capture files stay on the desktop.</div>
  </main>
  <script>
  (()=>{
    const sessionsEl=document.querySelector('#sessions'),scopeEl=document.querySelector('#scope'),feedRoot=document.querySelector('#feed-state'),feedEl=document.querySelector('#feed-state span'),streamTitle=document.querySelector('#stream-title'),streamMeta=document.querySelector('#stream-meta'),streamState=document.querySelector('#stream-state'),streamEl=document.querySelector('#stream'),detailEl=document.querySelector('#detail'),noticeEl=document.querySelector('#recovery-notice'),splash=document.querySelector('#mobile-launch-splash'),app=document.querySelector('#mobile-app');
    const sessions=new Map(),logs=new Map();
    const MAX_LOG_CHARS=240000,MAX_RECONNECT_DELAY=8000;
    const base=location.pathname.replace(/\/$/,'');
    let selectedId='',lastSequence=0,socket=null,reconnectTimer=null,reconnectAttempt=0,connectedOnce=false,stopped=false;
    const revealMobileApp=()=>{app.classList.add('is-visible');app.removeAttribute('aria-hidden');splash.classList.add('is-leaving');window.setTimeout(()=>splash.remove(),360)};
    window.setTimeout(revealMobileApp,matchMedia('(prefers-reduced-motion: reduce)').matches?0:1250);
    const stateLabel=(state)=>state==='storage-limit'?'Storage limit':state==='disconnected'?'Disconnected':state==='error'?'Error':state==='reconnecting'?'Reconnecting':state==='connected'?'Connected':state||'Unknown';
    const setFeed=(label,state)=>{feedEl.textContent=label;feedRoot.dataset.state=state||'live'};
    const setNotice=(message)=>{noticeEl.textContent=message||'';noticeEl.hidden=!message};
    const select=(id)=>{if(!sessions.has(id))return;selectedId=id;render()};
    const render=()=>{
      sessionsEl.replaceChildren();
      for(const item of sessions.values()){
        const button=document.createElement('button');button.className='session'+(item.sessionId===selectedId?' active':'');button.type='button';button.onclick=()=>select(item.sessionId);
        const title=document.createElement('span');title.className='session-title';const dot=document.createElement('i');dot.className=item.state||'';title.append(dot,document.createTextNode(item.sessionName));
        const meta=document.createElement('span');meta.className='session-meta';meta.textContent=item.port;
        const state=document.createElement('span');state.className='session-state';state.textContent=stateLabel(item.state);button.append(title,meta,state);sessionsEl.append(button);
      }
      const current=sessions.get(selectedId);
      if(!current){streamTitle.textContent='Choose a terminal';streamMeta.textContent='No stream selected';streamState.textContent='Waiting';streamState.className='stream-state';streamEl.textContent='The dashboard will show live output after it connects.';detailEl.textContent='Only sessions included when this link was created can appear here.';return}
      streamTitle.textContent=current.sessionName;streamMeta.textContent=current.port;streamState.textContent=stateLabel(current.state);streamState.className='stream-state '+(current.state||'');streamEl.textContent=logs.get(selectedId)||'No output received for this stream yet.';detailEl.textContent=current.message||'Live output is read-only.';streamEl.scrollTop=streamEl.scrollHeight;
    };
    const applySnapshot=(items)=>{
      sessions.clear();for(const item of items||[]){if(!item||typeof item.sessionId!=='string'||typeof item.sessionName!=='string'||typeof item.port!=='string')continue;sessions.set(item.sessionId,{...item})}
      if(!sessions.has(selectedId))selectedId=sessions.keys().next().value||'';
      scopeEl.textContent=sessions.size+' terminal'+(sessions.size===1?'':'s')+' included in this link';render();
    };
    const acceptSequence=(item)=>{
      if(!Number.isSafeInteger(item&&item.sequence)||item.sequence<1||item.sequence<=lastSequence)return false;
      if(lastSequence&&item.sequence>lastSequence+1)setNotice(`Some workspace updates were missed; showing the available tail from sequence ${item.sequence}.`);
      lastSequence=item.sequence;return true;
    };
    const applyStatus=(item)=>{
      if(!acceptSequence(item))return;const current=sessions.get(item.sessionId);if(!current)return;
      current.state=typeof item.status==='string'?item.status:'error';current.message=typeof item.message==='string'?item.message:'The desktop reported a session state change.';render();
    };
    const appendData=(item)=>{
      if(!acceptSequence(item))return;const event=item.event;
      if(!event||typeof event.sessionId!=='string'||!sessions.has(event.sessionId))return;
      const next=(logs.get(event.sessionId)||'')+(typeof event.text==='string'?event.text:'');logs.set(event.sessionId,next.length>MAX_LOG_CHARS?next.slice(-MAX_LOG_CHARS):next);
      if(event.sessionId===selectedId){streamEl.textContent=logs.get(event.sessionId)||'';streamEl.scrollTop=streamEl.scrollHeight}
    };
    const handleReplay=(item)=>{
      if(item.replayTruncated){const first=Number.isSafeInteger(item.firstSequence)?` from sequence ${item.firstSequence}`:'';setNotice(`Showing the bounded recent workspace tail${first}; older output was not retained on the desktop.`)}
    };
    const handleMessage=(raw)=>{try{const item=JSON.parse(raw);if(item.type==='snapshot')applySnapshot(item.sessions);else if(item.type==='replay')handleReplay(item);else if(item.type==='data')appendData(item);else if(item.type==='status')applyStatus(item)}catch{setFeed('Invalid feed · retrying…','reconnecting')}};
    const scheduleReconnect=()=>{
      if(stopped||reconnectTimer)return;
      const delay=Math.min(1000*2**Math.min(reconnectAttempt,3),MAX_RECONNECT_DELAY);reconnectAttempt+=1;
      setFeed(`Reconnecting in ${Math.ceil(delay/1000)}s…`,'reconnecting');detailEl.textContent='Keeping your place and requesting missed workspace output when the connection returns.';
      reconnectTimer=window.setTimeout(()=>{reconnectTimer=null;connect()},delay);
    };
    const connect=()=>{
      if(stopped||socket)return;
      const suffix=lastSequence?`?after=${encodeURIComponent(lastSequence)}`:'';
      setFeed(reconnectAttempt?'Reconnecting…':'Connecting…','reconnecting');
      try{socket=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+base+'/events'+suffix)}catch{socket=null;scheduleReconnect();return}
      socket.onopen=()=>{const reconnected=connectedOnce;connectedOnce=true;reconnectAttempt=0;setFeed(reconnected?'Reconnected · read-only':'Connected · read-only','live');if(reconnected)detailEl.textContent='Connection restored. Applying any retained workspace output now.'};
      socket.onmessage=(event)=>handleMessage(event.data);
      socket.onerror=()=>setFeed('Connection error · retrying…','reconnecting');
      socket.onclose=(event)=>{
        socket=null;if(stopped)return;
        if(event.code===1000&&event.reason==='Sharing ended'){stopped=true;setFeed('Disconnected · sharing ended','stopped');detailEl.textContent='The desktop ended this mobile share.';return}
        setFeed('Disconnected · retrying…','reconnecting');scheduleReconnect();
      };
    };
    window.addEventListener('beforeunload',()=>{stopped=true;if(reconnectTimer)window.clearTimeout(reconnectTimer);if(socket)socket.close()});
    render();connect();
  })();
  </script>
</body>
</html>"##
}

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
            ));
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
    let mobile_replay = Arc::new(Mutex::new(MobileReplayBuffer::default()));
    let reader_event_delivery = Arc::clone(&event_delivery);
    let reader_mobile_replay = Arc::clone(&mobile_replay);
    let reader_info = info.clone();
    let reader_app = app.clone();
    let reader_sessions = Arc::clone(&state.sessions);
    let reader_quota = Arc::clone(&state.capture_quota);
    let reader_mobile_shares = Arc::clone(&state.mobile_shares);
    let reader_mobile_workspace_share = Arc::clone(&state.mobile_workspace_share);
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
                    mobile_replay: reader_mobile_replay,
                    mobile_workspace_share: reader_mobile_workspace_share,
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
            mobile_replay,
            reader_thread,
        },
    );
    emit_status(
        &app,
        &info,
        "connected",
        "Port opened and raw logging started.",
    );
    broadcast_mobile_workspace_status(
        &state.mobile_workspace_share,
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
    write_serial_bytes_authorized(writer, stop, port, bytes, || true)
}

fn write_serial_bytes_authorized<W: Write, F: Fn() -> bool>(
    writer: &Mutex<Option<W>>,
    stop: &AtomicBool,
    port: &str,
    bytes: &[u8],
    is_authorized: F,
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
    if !is_authorized() {
        return Err("Remote control is disabled on the desktop.".into());
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
    broadcast_mobile_workspace_status(
        &state.mobile_workspace_share,
        &info,
        "disconnected",
        &message,
    );
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
            broadcast_mobile_serial_data(&context.mobile_shares, &context.mobile_replay, &event);
            broadcast_mobile_workspace_serial_data(&context.mobile_workspace_share, &event);
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
            broadcast_mobile_workspace_status(
                &context.mobile_workspace_share,
                &info,
                status,
                &message,
            );
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
    let mut last_flush = Instant::now();

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
                        let sync_due = capture_durability_sync_is_due(last_durable_sync.elapsed());
                        let flush_due = sync_due || last_flush.elapsed() >= CAPTURE_FLUSH_INTERVAL;
                        match log.write_all(&bytes[..allowed]).and_then(|()| {
                            if flush_due {
                                log.flush()
                            } else {
                                Ok(())
                            }
                        }) {
                            Ok(()) if !sync_due => {
                                if flush_due {
                                    last_flush = Instant::now();
                                }
                                quota.used_bytes = quota.used_bytes.saturating_add(allowed as u64);
                                allowed
                            }
                            Ok(()) => match log.get_ref().sync_data() {
                                Ok(()) => {
                                    last_durable_sync = Instant::now();
                                    last_flush = Instant::now();
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
        activate_serial_event_delivery, authorized_mobile_share_route,
        broadcast_mobile_workspace_serial_data, broadcast_mobile_workspace_status,
        capture_durability_sync_is_due, mobile_workspace_session_scope, register_mobile_client,
        register_mobile_workspace_client, remove_session_by_identity,
        stop_mobile_workspace_share_for_state, try_reserve_mobile_connection, MobileShareRoute,
        MobileWorkspaceReplayBuffer, MobileWorkspaceReplayEventKind, MobileWorkspaceSession,
        SerialDataEvent, SerialEventDelivery,
    };
    use super::{
        base64_decode, begin_saved_log_search, broadcast_mobile_serial_data,
        check_mobile_write_rate_at, data_bits, disconnect_status_message,
        ensure_search_not_cancelled, generated_log_path, index_records_by_path, is_usable_lan_ipv4,
        mark_log_closing, mobile_share_bearer_matches, mobile_share_close_status,
        normalize_application_settings, parse_mobile_share_events_path, parse_mobile_write_payload,
        read_mobile_share_request_from_reader, rebuild_log_text_index_in_directory,
        register_mobile_share_client, register_mobile_share_for_session, release_capture_quota,
        remove_log_text_indexes_for_path_in_directory, saved_log_text_index_path,
        search_fresh_log_text_index_in_directory, search_raw_log, stable_saved_log_content_search,
        stop_mobile_share_for_session, valid_serial_port, validate_preference_log_directory,
        validated_websocket_key, websocket_accept_key, ActiveMobileShare,
        ActiveMobileWorkspaceShare, ActiveSession, ApplicationSettings, CaptureQuota,
        FlowControlSetting, LogIndexRecord, MobileReplayBuffer, MobileShareRequest,
        MobileWritePayloadError, MobileWriteRateState, ParitySetting, SavedLogFingerprint,
        SavedLogTextIndexHeader, SerialSettings, SerialState, SessionInfo, StartSessionRequest,
        StopBitsSetting, CAPTURE_DURABILITY_SYNC_INTERVAL, GIBIBYTE,
        MOBILE_SHARE_EVENT_QUEUE_LIMIT, SEARCH_CANCELLED_MESSAGE, SEARCH_INDEX_MAGIC,
        SEARCH_INDEX_SCHEMA_VERSION, SEARCH_PER_LOG_BYTE_LIMIT, SEARCH_READ_BUFFER_SIZE,
    };
    use std::{
        cell::Cell,
        collections::{BTreeMap, HashMap},
        fs::File,
        io::{self, Cursor, Write},
        net::Ipv4Addr,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc, Arc, Mutex,
        },
        thread,
        time::{Duration, Instant},
    };
    use uuid::Uuid;

    #[cfg(target_os = "linux")]
    #[test]
    fn serial_path_validation_accepts_numeric_linux_pty_slaves_without_traversal() {
        assert!(valid_serial_port("/dev/pts/2"));
        assert!(!valid_serial_port("/dev/pts/console"));
        assert!(!valid_serial_port("/dev/pts/2/../ttyUSB0"));
    }

    #[derive(Debug, PartialEq)]
    struct TestSession {
        id: String,
        port: String,
    }

    fn send_mobile_share_request(bytes: &[u8]) -> io::Result<MobileShareRequest> {
        read_mobile_share_request_from_reader(&mut Cursor::new(bytes))
    }

    fn mobile_event(sequence: u64, byte_count: usize) -> SerialDataEvent {
        SerialDataEvent {
            session_id: "session-1".into(),
            port: "/dev/ttyUSB0".into(),
            sequence,
            timestamp: "2026-08-07T10:00:00.000Z".into(),
            text: format!("event-{sequence}"),
            bytes: vec![sequence as u8; byte_count],
        }
    }

    fn test_session_info(id: &str) -> SessionInfo {
        SessionInfo {
            id: id.into(),
            port: "/dev/ttyUSB0".into(),
            baud_rate: 115_200,
            session_name: "Bench".into(),
            log_path: "/tmp/bench.log".into(),
            state: "capturing",
            settings: SerialSettings::default(),
        }
    }

    fn test_active_session(id: &str) -> ActiveSession {
        ActiveSession {
            info: test_session_info(id),
            stop: Arc::new(AtomicBool::new(false)),
            writer: Arc::new(Mutex::new(None)),
            event_delivery: Arc::new(Mutex::new(SerialEventDelivery::Live { next_sequence: 0 })),
            mobile_replay: Arc::new(Mutex::new(MobileReplayBuffer::default())),
            reader_thread: thread::spawn(|| {}),
        }
    }

    fn test_workspace_session(id: &str, name: &str, port: &str) -> MobileWorkspaceSession {
        MobileWorkspaceSession {
            session_id: id.into(),
            session_name: name.into(),
            port: port.into(),
            state: "connected".into(),
            message: "Port opened and raw logging started.".into(),
        }
    }

    fn test_workspace_share_with_client(
        scope: &[MobileWorkspaceSession],
    ) -> (
        Arc<Mutex<Option<ActiveMobileWorkspaceShare>>>,
        mpsc::Receiver<String>,
    ) {
        let clients = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = mpsc::sync_channel(MOBILE_SHARE_EVENT_QUEUE_LIMIT);
        assert!(register_mobile_client(&mut clients.lock().unwrap(), 1, sender).is_some());
        let share = ActiveMobileWorkspaceShare {
            token: "workspace-token".into(),
            host: "192.168.1.50".into(),
            port: 4321,
            stop: Arc::new(AtomicBool::new(false)),
            sessions: Arc::new(Mutex::new(
                scope
                    .iter()
                    .cloned()
                    .map(|session| (session.session_id.clone(), session))
                    .collect::<BTreeMap<_, _>>(),
            )),
            replay: Arc::new(Mutex::new(MobileWorkspaceReplayBuffer::default())),
            clients,
            server_thread: thread::spawn(|| {}),
        };
        (Arc::new(Mutex::new(Some(share))), receiver)
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
        assert_eq!(fresh.content.0, 1);
        assert!(!fresh.content.3);
        assert!(fresh.content.1[0]
            .snippet
            .as_deref()
            .unwrap()
            .contains("NEEDLE"));

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
    fn stable_saved_log_search_retries_until_the_source_fingerprint_stabilizes() {
        let path = std::path::Path::new("/tmp/retry-search.log");
        let first = SavedLogFingerprint {
            size: 10,
            modified_seconds: 1,
            modified_nanos: 0,
        };
        let second = SavedLogFingerprint {
            size: 12,
            modified_seconds: 2,
            modified_nanos: 0,
        };
        let inspect_calls = Cell::new(0usize);
        let search_calls = Cell::new(0usize);

        let search = stable_saved_log_content_search(
            path,
            || {
                let next = match inspect_calls.get() {
                    0 => first,
                    1 => second,
                    _ => second,
                };
                inspect_calls.set(inspect_calls.get() + 1);
                Ok(next)
            },
            |fingerprint| {
                search_calls.set(search_calls.get() + 1);
                Ok(Some((
                    if fingerprint == first { 1 } else { 2 },
                    Vec::new(),
                    fingerprint.size,
                    false,
                )))
            },
        )
        .unwrap()
        .expect("the second attempt should stabilize");

        assert_eq!(search_calls.get(), 2);
        assert_eq!(search.fingerprint, second);
        assert_eq!(search.content.0, 2);
        assert_eq!(search.content.2, second.size);
    }

    #[test]
    fn stable_saved_log_search_drops_results_if_the_source_never_stabilizes() {
        let path = std::path::Path::new("/tmp/unstable-search.log");
        let fingerprints = [
            SavedLogFingerprint {
                size: 10,
                modified_seconds: 1,
                modified_nanos: 0,
            },
            SavedLogFingerprint {
                size: 11,
                modified_seconds: 2,
                modified_nanos: 0,
            },
            SavedLogFingerprint {
                size: 12,
                modified_seconds: 3,
                modified_nanos: 0,
            },
            SavedLogFingerprint {
                size: 13,
                modified_seconds: 4,
                modified_nanos: 0,
            },
        ];
        let inspect_calls = Cell::new(0usize);
        let search_calls = Cell::new(0usize);

        let search = stable_saved_log_content_search(
            path,
            || {
                let index = inspect_calls.get();
                inspect_calls.set(index + 1);
                Ok(fingerprints[index])
            },
            |fingerprint| {
                search_calls.set(search_calls.get() + 1);
                Ok(Some((1, Vec::new(), fingerprint.size, false)))
            },
        )
        .unwrap();

        assert!(search.is_none());
        assert_eq!(search_calls.get(), 2);
    }

    #[test]
    fn mobile_replay_tail_is_bounded_by_event_and_byte_limits() {
        let mut replay = MobileReplayBuffer::with_limits(3, 10);
        replay.push(mobile_event(1, 4));
        replay.push(mobile_event(2, 4));
        replay.push(mobile_event(3, 4));
        replay.push(mobile_event(4, 4));

        assert_eq!(
            replay
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![3, 4]
        );
        assert!(replay.events.len() <= 3);
        assert!(replay.byte_count <= 10);
        assert!(replay.dropped_event_count > 0);
    }

    #[test]
    fn mobile_replay_cursor_preserves_order_and_deduplicates_old_events() {
        let mut replay = MobileReplayBuffer::with_limits(8, 128);
        for sequence in 1..=5 {
            replay.push(mobile_event(sequence, 1));
        }
        replay.push(mobile_event(3, 1));

        let snapshot = replay.snapshot_after(Some(2));
        assert_eq!(
            snapshot
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![3, 4, 5]
        );
        assert_eq!(snapshot.first_sequence, Some(1));
        assert_eq!(snapshot.next_sequence, 6);
        assert!(!snapshot.replay_truncated);
    }

    #[test]
    fn mobile_share_queues_replay_before_a_new_live_event() {
        let replay = Arc::new(Mutex::new(MobileReplayBuffer::with_limits(8, 128)));
        replay.lock().unwrap().push(mobile_event(1, 1));
        replay.lock().unwrap().push(mobile_event(2, 1));
        let clients = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = mpsc::sync_channel(8);

        assert!(register_mobile_share_client(
            7, None, &replay, &clients, sender,
        ));
        let notice: serde_json::Value = serde_json::from_str(&receiver.recv().unwrap()).unwrap();
        assert_eq!(notice["kind"], "replay");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&receiver.recv().unwrap()).unwrap()
                ["sequence"],
            1
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&receiver.recv().unwrap()).unwrap()
                ["sequence"],
            2
        );

        let stop = Arc::new(AtomicBool::new(false));
        let shares = Arc::new(Mutex::new(HashMap::from([(
            "session-1".to_string(),
            ActiveMobileShare {
                token: "token".into(),
                host: "192.168.1.50".into(),
                port: 4321,
                stop,
                clients: Arc::clone(&clients),
                control_enabled: Arc::new(AtomicBool::new(false)),
                server_thread: thread::spawn(|| {}),
            },
        )])));
        broadcast_mobile_serial_data(&shares, &replay, &mobile_event(3, 1));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&receiver.recv().unwrap()).unwrap()
                ["sequence"],
            3
        );
    }

    #[test]
    fn mobile_reconnect_cursor_reports_when_older_tail_is_unavailable() {
        let mut replay = MobileReplayBuffer::with_limits(3, 128);
        for sequence in 1..=5 {
            replay.push(mobile_event(sequence, 1));
        }

        let snapshot = replay.snapshot_after(Some(1));
        assert_eq!(snapshot.first_sequence, Some(3));
        assert_eq!(snapshot.next_sequence, 6);
        assert_eq!(
            snapshot
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![3, 4, 5]
        );
        assert!(snapshot.replay_truncated);
    }

    #[test]
    fn mobile_share_events_path_accepts_only_the_reconnect_cursor() {
        let events_path = "/share/token/events";
        assert_eq!(
            parse_mobile_share_events_path(events_path, events_path),
            Some(None)
        );
        assert_eq!(
            parse_mobile_share_events_path("/share/token/events?after=42", events_path),
            Some(Some(42))
        );
        assert!(
            parse_mobile_share_events_path("/share/token/events?after=", events_path).is_none()
        );
        assert!(parse_mobile_share_events_path(
            "/share/token/events?after=42&extra=1",
            events_path
        )
        .is_none());
        assert!(
            parse_mobile_share_events_path("/share/token/events?after=-1", events_path).is_none()
        );
        assert!(
            parse_mobile_share_events_path("/share/other/events?after=42", events_path).is_none()
        );
    }

    #[test]
    fn mobile_share_only_marks_an_intentional_stop_as_a_clean_disconnect() {
        assert_eq!(mobile_share_close_status(true), (1000, "Sharing ended"));
        assert_eq!(
            mobile_share_close_status(false),
            (1012, "Connection interrupted")
        );
    }

    #[test]
    fn mobile_share_request_parser_rejects_extra_body_bytes_and_duplicate_headers() {
        let body_error = send_mobile_share_request(
            b"GET /share/token HTTP/1.1\r\nHost: phone\r\n\r\nunexpected",
        )
        .unwrap_err();
        assert_eq!(body_error.kind(), io::ErrorKind::InvalidData);

        let duplicate_error = send_mobile_share_request(
            b"GET /share/token/events HTTP/1.1\r\nHost: phone\r\nHost: duplicate\r\n\r\n",
        )
        .unwrap_err();
        assert_eq!(duplicate_error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn mobile_share_request_parser_reads_only_declared_bounded_bodies() {
        let body = br#"{"mode":"hex","hex":"00 FF"}"#;
        let request = format!(
            "POST /share/token/control/write HTTP/1.1\r\nHost: phone\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            std::str::from_utf8(body).unwrap()
        );
        let request = send_mobile_share_request(request.as_bytes()).unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/share/token/control/write");
        assert_eq!(
            request.headers.get("content-length"),
            Some(&body.len().to_string())
        );
        assert_eq!(request.body, body);

        let oversized = format!(
            "POST /share/token/control/write HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            super::MOBILE_SHARE_REQUEST_BYTE_LIMIT
        );
        let error = send_mobile_share_request(oversized.as_bytes()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("size limit"));
    }

    #[test]
    fn mobile_share_control_requires_the_exact_bearer_capability() {
        let no_auth = HashMap::new();
        assert!(!mobile_share_bearer_matches(&no_auth, "secret"));
        assert!(!mobile_share_bearer_matches(
            &HashMap::from([("authorization".into(), "Bearer wrong".into())]),
            "secret"
        ));
        assert!(!mobile_share_bearer_matches(
            &HashMap::from([("authorization".into(), "Bearer secret extra".into())]),
            "secret"
        ));
        assert!(mobile_share_bearer_matches(
            &HashMap::from([("authorization".into(), "bearer secret".into())]),
            "secret"
        ));
    }

    #[test]
    fn mobile_write_payload_parser_validates_text_hex_and_decoded_limits() {
        let text = parse_mobile_write_payload(br#"{"mode":"text","text":"hello"}"#).unwrap();
        assert_eq!(text.mode, "text");
        assert_eq!(text.bytes, b"hello");

        let hex = parse_mobile_write_payload(br#"{"mode":"hex","hex":"0x00, FF 7e"}"#).unwrap();
        assert_eq!(hex.mode, "hex");
        assert_eq!(hex.bytes, [0x00, 0xff, 0x7e]);

        let invalid = parse_mobile_write_payload(br#"{"mode":"hex","hex":"0G"}"#).unwrap_err();
        assert!(matches!(invalid, MobileWritePayloadError::Invalid(_)));

        let oversized_text = format!(
            "{{\"mode\":\"text\",\"text\":\"{}\"}}",
            "x".repeat(super::MOBILE_SHARE_WRITE_BYTE_LIMIT + 1)
        );
        let oversized = parse_mobile_write_payload(oversized_text.as_bytes()).unwrap_err();
        assert!(matches!(oversized, MobileWritePayloadError::TooLarge(_)));

        let oversized_hex = format!(
            "{{\"mode\":\"hex\",\"hex\":\"{}\"}}",
            "00 ".repeat(super::MOBILE_SHARE_WRITE_BYTE_LIMIT + 1)
        );
        let oversized = parse_mobile_write_payload(oversized_hex.as_bytes()).unwrap_err();
        assert!(matches!(oversized, MobileWritePayloadError::TooLarge(_)));
    }

    #[test]
    fn mobile_write_rate_limiter_denies_bursts_and_resets_after_one_second() {
        let mut state = MobileWriteRateState::default();
        let start = Instant::now();
        for _ in 0..super::MOBILE_SHARE_WRITE_REQUEST_LIMIT {
            check_mobile_write_rate_at(&mut state, start, 1).unwrap();
        }
        let error = check_mobile_write_rate_at(&mut state, start, 1).unwrap_err();
        assert!(error.contains("writes"));
        check_mobile_write_rate_at(
            &mut state,
            start + super::MOBILE_SHARE_WRITE_RATE_WINDOW,
            super::MOBILE_SHARE_WRITE_RATE_BYTE_LIMIT,
        )
        .unwrap();
    }

    #[test]
    fn websocket_validation_requires_rfc_6455_version_and_key_shape() {
        let valid = HashMap::from([
            ("upgrade".into(), "websocket".into()),
            ("connection".into(), "keep-alive, Upgrade".into()),
            ("sec-websocket-version".into(), "13".into()),
            (
                "sec-websocket-key".into(),
                "dGhlIHNhbXBsZSBub25jZQ==".into(),
            ),
        ]);
        assert_eq!(
            validated_websocket_key(&valid),
            Some("dGhlIHNhbXBsZSBub25jZQ==")
        );

        let wrong_version = HashMap::from([
            ("upgrade".into(), "websocket".into()),
            ("connection".into(), "Upgrade".into()),
            ("sec-websocket-version".into(), "12".into()),
            (
                "sec-websocket-key".into(),
                "dGhlIHNhbXBsZSBub25jZQ==".into(),
            ),
        ]);
        assert!(validated_websocket_key(&wrong_version).is_none());

        let wrong_key = HashMap::from([
            ("upgrade".into(), "websocket".into()),
            ("connection".into(), "Upgrade".into()),
            ("sec-websocket-version".into(), "13".into()),
            ("sec-websocket-key".into(), "Zm9v".into()),
        ]);
        assert!(validated_websocket_key(&wrong_key).is_none());
        assert!(base64_decode("AA==AAAA").is_none());
        assert!(base64_decode("AB==").is_none());
    }

    #[test]
    fn lan_address_filter_accepts_only_private_or_link_local_ipv4() {
        assert!(is_usable_lan_ipv4(Ipv4Addr::new(192, 168, 1, 20)));
        assert!(is_usable_lan_ipv4(Ipv4Addr::new(169, 254, 8, 9)));
        assert!(!is_usable_lan_ipv4(Ipv4Addr::LOCALHOST));
        assert!(!is_usable_lan_ipv4(Ipv4Addr::UNSPECIFIED));
        assert!(!is_usable_lan_ipv4(Ipv4Addr::new(8, 8, 8, 8)));
    }

    #[test]
    fn mobile_share_registration_leaves_no_orphan_when_session_stops_during_start() {
        let session_id = "session-1";
        let sessions = Arc::new(Mutex::new(HashMap::from([(
            session_id.to_string(),
            test_active_session(session_id),
        )])));
        let shares = Arc::new(Mutex::new(HashMap::new()));
        let (started_tx, started_rx) = mpsc::channel();
        let remover_sessions = Arc::clone(&sessions);
        let remover_shares = Arc::clone(&shares);
        let server_exited = Arc::new(AtomicBool::new(false));
        let remover = thread::spawn(move || {
            started_rx.recv().unwrap();
            let removed = remover_sessions
                .lock()
                .unwrap()
                .remove(session_id)
                .expect("session should still exist until registration finishes");
            stop_mobile_share_for_session(&remover_shares, session_id);
            removed.reader_thread.join().unwrap();
        });

        let exit_flag = Arc::clone(&server_exited);
        let info = register_mobile_share_for_session(&sessions, &shares, session_id, move |_| {
            started_tx.send(()).unwrap();
            thread::sleep(Duration::from_millis(100));
            let stop = Arc::new(AtomicBool::new(false));
            let server_stop = Arc::clone(&stop);
            let server_exit = Arc::clone(&exit_flag);
            let server_thread = thread::spawn(move || {
                while !server_stop.load(Ordering::Acquire) {
                    thread::sleep(Duration::from_millis(10));
                }
                server_exit.store(true, Ordering::Release);
            });
            Ok(ActiveMobileShare {
                token: "token".into(),
                host: "192.168.1.50".into(),
                port: 4321,
                stop,
                clients: Arc::new(Mutex::new(HashMap::new())),
                control_enabled: Arc::new(AtomicBool::new(false)),
                server_thread,
            })
        })
        .unwrap();

        assert_eq!(info.session_id, session_id);
        assert_eq!(info.url, "http://192.168.1.50:4321/share/token");
        assert_eq!(info.host, "192.168.1.50");
        assert_eq!(info.port, 4321);
        assert_eq!(info.client_count, 0);
        assert!(info.enabled);
        assert!(!info.control_enabled);
        remover.join().unwrap();
        assert!(shares.lock().unwrap().is_empty());
        assert!(server_exited.load(Ordering::Acquire));
    }

    #[test]
    fn workspace_scope_contains_only_the_active_sessions_at_creation() {
        let sessions = HashMap::from([
            ("session-1".into(), test_active_session("session-1")),
            ("session-2".into(), test_active_session("session-2")),
        ]);

        let scope = mobile_workspace_session_scope(&sessions).unwrap();

        assert_eq!(scope.len(), 2);
        assert_eq!(scope["session-1"].session_name, "Bench");
        assert_eq!(scope["session-2"].port, "/dev/ttyUSB0");
        assert!(scope.values().all(|session| session.state == "connected"));
    }

    #[test]
    fn workspace_scope_rejects_empty_or_over_limit_session_sets() {
        assert!(mobile_workspace_session_scope(&HashMap::new()).is_err());
        let mut sessions = HashMap::new();
        for index in 0..=super::MOBILE_WORKSPACE_SESSION_LIMIT {
            let id = format!("session-{index}");
            sessions.insert(id.clone(), test_active_session(&id));
        }
        let error = match mobile_workspace_session_scope(&sessions) {
            Ok(_) => panic!("an over-limit workspace scope should fail"),
            Err(error) => error,
        };
        assert!(error.contains("limited to"));
    }

    #[test]
    fn workspace_routes_require_the_exact_bearer_token() {
        assert!(matches!(
            authorized_mobile_share_route("/workspace/token", "workspace", "token", false),
            Some(MobileShareRoute::Page)
        ));
        assert!(matches!(
            authorized_mobile_share_route("/workspace/token/events", "workspace", "token", false),
            Some(MobileShareRoute::Events)
        ));
        assert!(
            authorized_mobile_share_route("/workspace/wrong", "workspace", "token", false)
                .is_none()
        );
        assert!(authorized_mobile_share_route(
            "/workspace/token/download",
            "workspace",
            "token",
            false
        )
        .is_none());
        assert!(matches!(
            authorized_mobile_share_route("/share/token/download", "share", "token", true),
            Some(MobileShareRoute::Download)
        ));
        assert_eq!(
            parse_mobile_share_events_path(
                "/workspace/token/events?after=42",
                "/workspace/token/events"
            ),
            Some(Some(42))
        );
        assert!(parse_mobile_share_events_path(
            "/workspace/token/events?after=42&extra=1",
            "/workspace/token/events"
        )
        .is_none());
    }

    #[test]
    fn workspace_replay_uses_one_ordered_cursor_across_terminal_streams() {
        let mut replay = MobileWorkspaceReplayBuffer::with_limits(3, 64 * 1024);
        for (index, session_id) in [
            "session-1",
            "session-2",
            "session-1",
            "session-2",
            "session-1",
        ]
        .into_iter()
        .enumerate()
        {
            let event = SerialDataEvent {
                session_id: session_id.into(),
                port: "/dev/ttyUSB0".into(),
                sequence: 1,
                timestamp: "2026-08-09T10:00:00.000Z".into(),
                text: format!("event-{index}"),
                bytes: vec![index as u8],
            };
            assert!(replay
                .push(MobileWorkspaceReplayEventKind::Data { event })
                .is_some());
        }

        let snapshot = replay.snapshot_after(Some(1));
        assert_eq!(snapshot.first_sequence, Some(3));
        assert_eq!(snapshot.next_sequence, 6);
        assert!(snapshot.replay_truncated);
        assert_eq!(
            snapshot
                .events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![3, 4, 5]
        );
        let terminal_ids = snapshot
            .events
            .iter()
            .map(|event| {
                let payload: serde_json::Value = serde_json::from_str(&event.payload).unwrap();
                payload["event"]["sessionId"].as_str().unwrap().to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(terminal_ids, ["session-1", "session-2", "session-1"]);
    }

    #[test]
    fn workspace_replay_registration_resumes_after_the_cursor_without_duplicates() {
        let sessions = Arc::new(Mutex::new(BTreeMap::from([(
            "session-1".into(),
            test_workspace_session("session-1", "Bench", "/dev/ttyUSB0"),
        )])));
        let replay = Arc::new(Mutex::new(MobileWorkspaceReplayBuffer::with_limits(
            8,
            64 * 1024,
        )));
        for sequence in 1..=3 {
            let event = SerialDataEvent {
                session_id: "session-1".into(),
                port: "/dev/ttyUSB0".into(),
                sequence,
                timestamp: "2026-08-09T10:00:00.000Z".into(),
                text: format!("event-{sequence}"),
                bytes: vec![sequence as u8],
            };
            replay
                .lock()
                .unwrap()
                .push(MobileWorkspaceReplayEventKind::Data { event })
                .unwrap();
        }
        let clients = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = mpsc::sync_channel(8);

        let snapshot =
            register_mobile_workspace_client(7, Some(1), &sessions, &replay, &clients, sender)
                .unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        assert_eq!(snapshot["type"], "snapshot");

        let notice: serde_json::Value = serde_json::from_str(&receiver.recv().unwrap()).unwrap();
        assert_eq!(notice["type"], "replay");
        assert_eq!(notice["nextSequence"], 4);
        let resumed = [receiver.recv().unwrap(), receiver.recv().unwrap()]
            .into_iter()
            .map(|payload| {
                serde_json::from_str::<serde_json::Value>(&payload).unwrap()["sequence"]
                    .as_u64()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(resumed, [2, 3]);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn workspace_replay_marks_a_live_only_oversized_event_as_unavailable_after_reconnect() {
        let mut replay = MobileWorkspaceReplayBuffer::with_limits(8, 80);
        let payload = replay
            .push(MobileWorkspaceReplayEventKind::Data {
                event: SerialDataEvent {
                    session_id: "session-1".into(),
                    port: "/dev/ttyUSB0".into(),
                    sequence: 1,
                    timestamp: "2026-08-09T10:00:00.000Z".into(),
                    text: "x".repeat(256),
                    bytes: vec![0; 256],
                },
            })
            .unwrap();
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["type"], "data");
        assert_eq!(payload["sequence"], 1);

        let snapshot = replay.snapshot_after(None);
        assert!(snapshot.events.is_empty());
        assert_eq!(snapshot.next_sequence, 2);
        assert!(snapshot.replay_truncated);
    }

    #[test]
    fn workspace_event_routing_multiplexes_only_scoped_session_data() {
        let scope = vec![test_workspace_session("session-1", "Bench", "/dev/ttyUSB0")];
        let (share_state, receiver) = test_workspace_share_with_client(&scope);
        let event = |session_id: &str, text: &str| SerialDataEvent {
            session_id: session_id.into(),
            port: "/dev/ttyUSB0".into(),
            sequence: 1,
            timestamp: "2026-08-07T10:00:00.000Z".into(),
            text: text.into(),
            bytes: text.as_bytes().to_vec(),
        };

        broadcast_mobile_workspace_serial_data(&share_state, &event("session-1", "allowed"));
        let payload = receiver.recv_timeout(Duration::from_millis(100)).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["type"], "data");
        assert_eq!(payload["event"]["sessionId"], "session-1");
        assert_eq!(payload["event"]["text"], "allowed");

        broadcast_mobile_workspace_serial_data(&share_state, &event("not-shared", "blocked"));
        assert!(receiver.recv_timeout(Duration::from_millis(30)).is_err());
    }

    #[test]
    fn workspace_lifecycle_status_is_visible_and_cleanup_stops_the_server() {
        let info = test_session_info("session-1");
        let scope = vec![test_workspace_session("session-1", "Bench", "/dev/ttyUSB0")];
        let (share_state, receiver) = test_workspace_share_with_client(&scope);

        for (status, message) in [
            ("disconnected", "The user disconnected this terminal."),
            ("error", "The serial reader failed."),
            ("storage-limit", "Storage limit reached; logging stopped."),
        ] {
            broadcast_mobile_workspace_status(&share_state, &info, status, message);
            let payload: serde_json::Value =
                serde_json::from_str(&receiver.recv_timeout(Duration::from_millis(100)).unwrap())
                    .unwrap();
            assert_eq!(payload["type"], "status");
            assert_eq!(payload["status"], status);
            assert_eq!(payload["message"], message);
        }
        assert_eq!(
            share_state
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .sessions
                .lock()
                .unwrap()["session-1"]
                .state,
            "storage-limit"
        );

        let server_stop = Arc::new(AtomicBool::new(false));
        let server_exited = Arc::new(AtomicBool::new(false));
        let stop_for_thread = Arc::clone(&server_stop);
        let exited_for_thread = Arc::clone(&server_exited);
        let replacement_share = ActiveMobileWorkspaceShare {
            token: "cleanup-token".into(),
            host: "192.168.1.50".into(),
            port: 4321,
            stop: Arc::clone(&server_stop),
            sessions: Arc::new(Mutex::new(BTreeMap::new())),
            replay: Arc::new(Mutex::new(MobileWorkspaceReplayBuffer::default())),
            clients: Arc::new(Mutex::new(HashMap::new())),
            server_thread: thread::spawn(move || {
                while !stop_for_thread.load(Ordering::Acquire) {
                    thread::sleep(Duration::from_millis(5));
                }
                exited_for_thread.store(true, Ordering::Release);
            }),
        };
        let cleanup_state = Arc::new(Mutex::new(Some(replacement_share)));
        stop_mobile_workspace_share_for_state(&cleanup_state);
        assert!(cleanup_state.lock().unwrap().is_none());
        assert!(server_exited.load(Ordering::Acquire));
    }

    #[test]
    fn mobile_client_slots_and_registration_are_bounded() {
        let slots = AtomicUsize::new(0);
        for _ in 0..super::MOBILE_SHARE_CLIENT_LIMIT {
            assert!(try_reserve_mobile_connection(&slots));
        }
        assert!(!try_reserve_mobile_connection(&slots));
        assert_eq!(
            slots.load(Ordering::Acquire),
            super::MOBILE_SHARE_CLIENT_LIMIT
        );

        let mut clients = HashMap::new();
        for id in 0..super::MOBILE_SHARE_CLIENT_LIMIT as u64 {
            let (sender, _receiver) = mpsc::sync_channel(MOBILE_SHARE_EVENT_QUEUE_LIMIT);
            assert!(register_mobile_client(&mut clients, id, sender).is_some());
        }
        let (sender, _receiver) = mpsc::sync_channel(MOBILE_SHARE_EVENT_QUEUE_LIMIT);
        assert!(register_mobile_client(&mut clients, 99, sender).is_none());
        assert_eq!(clients.len(), super::MOBILE_SHARE_CLIENT_LIMIT);
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
        let has_parent = Path::new(port)
            .components()
            .any(|component| component == std::path::Component::ParentDir);
        if has_parent {
            return false;
        }
        let accepted_device_prefix = [
            "/dev/tty",
            "/dev/rfcomm",
            "/dev/serial/by-id/",
            "/dev/serial/by-path/",
        ]
        .iter()
        .any(|prefix| port.starts_with(prefix));
        let accepted_pty = port
            .strip_prefix("/dev/pts/")
            .is_some_and(|name| !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit()));
        return accepted_device_prefix || accepted_pty;
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

fn stable_saved_log_content_search<F, G>(
    path: &Path,
    mut inspect_fingerprint: G,
    mut search: F,
) -> CommandResult<Option<VerifiedSavedLogContentSearch>>
where
    F: FnMut(SavedLogFingerprint) -> CommandResult<Option<SavedLogContentSearch>>,
    G: FnMut() -> io::Result<SavedLogFingerprint>,
{
    for _ in 0..SEARCH_SOURCE_STABILITY_ATTEMPTS {
        let fingerprint = match inspect_fingerprint() {
            Ok(fingerprint) => fingerprint,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "Could not inspect {} for search: {error}",
                    path.display()
                ));
            }
        };
        let Some(content) = search(fingerprint)? else {
            return Ok(None);
        };
        match inspect_fingerprint() {
            Ok(current) if current == fingerprint => {
                return Ok(Some(VerifiedSavedLogContentSearch {
                    content,
                    fingerprint,
                }));
            }
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "Could not inspect {} for search: {error}",
                    path.display()
                ));
            }
        }
    }
    Ok(None)
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
) -> CommandResult<Option<VerifiedSavedLogContentSearch>> {
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
) -> CommandResult<Option<VerifiedSavedLogContentSearch>> {
    stable_saved_log_content_search(
        path,
        || saved_log_fingerprint(path),
        |fingerprint| {
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
            // Short/corrupt cache data is never authoritative, even if it happened
            // to contain a match.
            if search.3 {
                return Ok(None);
            }
            Ok(Some(search))
        },
    )
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
            ));
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

#[cfg(test)]
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

fn search_stable_raw_log(
    path: &Path,
    needle: &[u8],
    byte_limit: u64,
    cancellation: Option<&AtomicBool>,
) -> CommandResult<Option<VerifiedSavedLogContentSearch>> {
    stable_saved_log_content_search(
        path,
        || saved_log_fingerprint(path),
        |fingerprint| {
            let file = match File::open(path) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(error) => {
                    return Err(format!(
                        "Could not open {} for search: {error}",
                        path.display()
                    ));
                }
            };
            let effective_limit = byte_limit.min(fingerprint.size);
            Ok(Some(search_log_reader(
                BufReader::with_capacity(SEARCH_READ_BUFFER_SIZE, file),
                fingerprint.size,
                needle,
                effective_limit,
                cancellation,
            )?))
        },
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
    shutdown_mobile_workspace_share(&state.mobile_workspace_share);
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
            set_mobile_share_control,
            stop_mobile_share,
            start_mobile_workspace_share,
            get_mobile_workspace_share_status,
            stop_mobile_workspace_share,
            start_serial_session,
            send_serial_text,
            send_serial_bytes,
            disconnect_serial_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running BaudTide");
}
