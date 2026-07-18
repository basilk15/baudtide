#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    fs::{create_dir_all, read_dir, File, OpenOptions},
    io::{self, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortType, StopBits};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

const READ_TIMEOUT: Duration = Duration::from_millis(100);
const READ_BUFFER_SIZE: usize = 4096;

type CommandResult<T> = Result<T, String>;

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
#[serde(rename_all = "camelCase")]
struct StartSessionRequest {
    port: String,
    baud_rate: u32,
    session_name: String,
    #[serde(default)]
    settings: SerialSettings,
    /// An absolute user-selected path. If omitted, SignalDeck stores the raw log in its app-data directory.
    log_path: Option<String>,
}

#[derive(Clone, Deserialize)]
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

#[derive(Clone, Deserialize, Default)]
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

#[derive(Clone, Deserialize, Default)]
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

#[derive(Clone, Deserialize, Default)]
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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialDataEvent {
    session_id: String,
    port: String,
    timestamp: String,
    text: String,
    bytes: Vec<u8>,
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
    size_bytes: u64,
    modified_at: String,
    state: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedLogContent {
    path: String,
    text: String,
    truncated: bool,
}

struct ActiveSession {
    info: SessionInfo,
    stop: Arc<AtomicBool>,
    writer: Arc<Mutex<Box<dyn SerialPort>>>,
    reader_thread: JoinHandle<()>,
}

#[derive(Default)]
struct SerialState {
    sessions: Mutex<HashMap<String, ActiveSession>>,
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
    Ok(sessions
        .values()
        .map(|session| session.info.clone())
        .collect())
}

#[tauri::command]
fn list_saved_logs(app: AppHandle, state: State<'_, SerialState>) -> CommandResult<Vec<SavedLog>> {
    let directory = log_directory(&app)?;
    if !directory.exists() {
        return Ok(Vec::new());
    }

    let active_sessions: HashMap<String, SessionInfo> = state
        .sessions
        .lock()
        .map_err(lock_error)?
        .values()
        .map(|session| (session.info.log_path.clone(), session.info.clone()))
        .collect();
    let mut logs = Vec::new();

    for entry in read_dir(&directory)
        .map_err(|error| format!("Could not read {}: {error}", directory.display()))?
    {
        let entry = entry.map_err(|error| format!("Could not read a saved log entry: {error}"))?;
        let path = entry.path();
        if !path.is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("log")
        {
            continue;
        }
        let metadata = entry
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
        let path_string = path.display().to_string();
        let active = active_sessions.get(&path_string);
        logs.push(SavedLog {
            path: path_string,
            file_name: path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("serial-capture.log")
                .into(),
            session_name: active
                .map(|session| session.session_name.clone())
                .unwrap_or_else(|| log_name_from_path(&path)),
            port: active.map(|session| session.port.clone()),
            baud_rate: active.map(|session| session.baud_rate),
            size_bytes: metadata.len(),
            modified_at: modified_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            state: if active.is_some() {
                "capturing".into()
            } else {
                "saved".into()
            },
        });
    }
    logs.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    Ok(logs)
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
fn save_saved_log(
    app: AppHandle,
    source_path: String,
    destination_path: String,
) -> CommandResult<String> {
    let source = resolve_saved_log_path(&app, &source_path)?;
    let destination = PathBuf::from(destination_path);
    if !destination.is_absolute() {
        return Err("Choose an absolute destination path for the saved copy.".into());
    }
    let destination = if destination.extension().is_none() {
        destination.with_extension("log")
    } else {
        destination
    };
    if destination == source {
        return Err("Choose a different location for the saved copy.".into());
    }
    if let Some(parent) = destination.parent() {
        create_dir_all(parent)
            .map_err(|error| format!("Could not create the destination folder: {error}"))?;
    }
    std::fs::copy(&source, &destination)
        .map_err(|error| format!("Could not save a copy of the log: {error}"))?;
    Ok(destination.display().to_string())
}

#[tauri::command]
fn start_serial_session(
    app: AppHandle,
    state: State<'_, SerialState>,
    request: StartSessionRequest,
) -> CommandResult<SessionInfo> {
    validate_request(&request)?;

    let mut sessions = state.sessions.lock().map_err(lock_error)?;
    if sessions
        .values()
        .any(|session| session.info.port == request.port)
    {
        return Err(format!(
            "{} is already being monitored by SignalDeck.",
            request.port
        ));
    }

    let id = Uuid::new_v4().to_string();
    let log_path = resolve_log_path(&app, &request, &id)?;
    let log_file = open_log_file(&log_path)?;

    let port = serialport::new(&request.port, request.baud_rate)
        .timeout(READ_TIMEOUT)
        .data_bits(data_bits(request.settings.data_bits)?)
        .parity(request.settings.parity.into())
        .stop_bits(request.settings.stop_bits.into())
        .flow_control(request.settings.flow_control.into())
        .open()
        .map_err(|error| format!("Could not open {}: {error}", request.port))?;

    let reader = port
        .try_clone()
        .map_err(|error| format!("Could not create a reader for {}: {error}", request.port))?;
    let info = SessionInfo {
        id: id.clone(),
        port: request.port.clone(),
        baud_rate: request.baud_rate,
        session_name: request.session_name.clone(),
        log_path: log_path.display().to_string(),
        state: "connected",
    };
    let stop = Arc::new(AtomicBool::new(false));
    let reader_stop = Arc::clone(&stop);
    let reader_info = info.clone();
    let reader_app = app.clone();
    let reader_thread = thread::Builder::new()
        .name(format!("serial-reader-{}", &id[..8]))
        .spawn(move || read_serial_loop(reader, log_file, reader_info, reader_stop, reader_app))
        .map_err(|error| format!("Could not start serial reader: {error}"))?;

    sessions.insert(
        id,
        ActiveSession {
            info: info.clone(),
            stop,
            writer: Arc::new(Mutex::new(port)),
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
    let sessions = state.sessions.lock().map_err(lock_error)?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "This serial session is no longer active.".to_string())?;
    let mut writer = session.writer.lock().map_err(lock_error)?;
    writer
        .write_all(&bytes)
        .and_then(|()| writer.flush())
        .map_err(|error| format!("Could not write to {}: {error}", session.info.port))?;
    Ok(bytes.len())
}

#[tauri::command]
fn disconnect_serial_session(
    app: AppHandle,
    state: State<'_, SerialState>,
    session_id: String,
) -> CommandResult<SessionInfo> {
    let session = state
        .sessions
        .lock()
        .map_err(lock_error)?
        .remove(&session_id)
        .ok_or_else(|| "This serial session is no longer active.".to_string())?;
    session.stop.store(true, Ordering::Release);
    let info = session.info.clone();
    session
        .reader_thread
        .join()
        .map_err(|_| format!("Serial reader for {} stopped unexpectedly.", info.port))?;
    emit_status(
        &app,
        &info,
        "disconnected",
        "Disconnected by user. The saved raw log was kept.",
    );
    Ok(info)
}

fn read_serial_loop(
    mut reader: Box<dyn SerialPort>,
    log_file: File,
    info: SessionInfo,
    stop: Arc<AtomicBool>,
    app: AppHandle,
) {
    let mut log = BufWriter::new(log_file);
    let mut buffer = [0_u8; READ_BUFFER_SIZE];

    while !stop.load(Ordering::Acquire) {
        match reader.read(&mut buffer) {
            Ok(0) => continue,
            Ok(count) => {
                let bytes = &buffer[..count];
                if let Err(error) = log.write_all(bytes).and_then(|()| log.flush()) {
                    emit_status(&app, &info, "error", &format!("Logging failed: {error}"));
                    break;
                }
                let _ = app.emit(
                    "serial-data",
                    SerialDataEvent {
                        session_id: info.id.clone(),
                        port: info.port.clone(),
                        timestamp: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                        text: String::from_utf8_lossy(bytes).into_owned(),
                        bytes: bytes.to_vec(),
                    },
                );
            }
            Err(error)
                if error.kind() == io::ErrorKind::TimedOut
                    || error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => {
                if !stop.load(Ordering::Acquire) {
                    emit_status(
                        &app,
                        &info,
                        "error",
                        &format!("Serial read failed: {error}"),
                    );
                }
                break;
            }
        }
    }
    let _ = log.flush();
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
    if request.port.trim().is_empty() {
        return Err("Choose a serial port first.".into());
    }
    if !(300..=4_000_000).contains(&request.baud_rate) {
        return Err("Baud rate must be between 300 and 4,000,000.".into());
    }
    if request.session_name.trim().is_empty() {
        return Err("Give the serial session a name.".into());
    }
    Ok(())
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

fn resolve_log_path(
    app: &AppHandle,
    request: &StartSessionRequest,
    id: &str,
) -> CommandResult<PathBuf> {
    if let Some(path) = &request.log_path {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("Log file path must be absolute.".into());
        }
        return Ok(path);
    }
    let directory = log_directory(app)?;
    let safe_name: String = request
        .session_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect();
    Ok(directory.join(format!("{}-{}.log", safe_name.trim_matches('-'), &id[..8])))
}

fn log_directory(app: &AppHandle) -> CommandResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Could not find the app-data directory: {error}"))
        .map(|directory| directory.join("logs"))
}

fn resolve_saved_log_path(app: &AppHandle, path: &str) -> CommandResult<PathBuf> {
    let root = log_directory(app)?
        .canonicalize()
        .map_err(|error| format!("Could not access SignalDeck's log directory: {error}"))?;
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Could not open the saved log: {error}"))?;
    if !path.starts_with(&root)
        || path.extension().and_then(|extension| extension.to_str()) != Some("log")
    {
        return Err("That file is not in SignalDeck's saved-log library.".into());
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
        .create(true)
        .append(true)
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
    "SignalDeck's serial session state is unavailable. Restart the app to recover.".into()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SerialState::default())
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            list_active_sessions,
            list_saved_logs,
            read_saved_log,
            save_saved_log,
            start_serial_session,
            send_serial_text,
            send_serial_bytes,
            disconnect_serial_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running SignalDeck");
}
