//! Linux-only integration coverage for the serial crate using pseudo-terminals.
//!
//! A PTY gives these tests a kernel-backed serial-like device without requiring
//! an Arduino, ESP32, USB adapter, or any `/dev/ttyUSB*` hardware.

use std::{
    ffi::CStr,
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    os::fd::{AsRawFd, FromRawFd},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use uuid::Uuid;

use super::{
    activate_serial_event_delivery, buffer_serial_event, run_serial_capture_loop,
    write_serial_bytes, CaptureQuota, SerialEventDelivery, SerialSettings, SessionInfo,
    SERIAL_WRITE_BYTE_LIMIT,
};

struct PtyPair {
    master: File,
    slave_path: String,
}

/// Owns a unique temporary raw-capture file for one test. The file handle may
/// be moved to a reader thread while this guard remains responsible for
/// removing only that known test artifact.
struct TemporaryCapture {
    path: PathBuf,
    file: Option<File>,
}

impl Drop for TemporaryCapture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl PtyPair {
    fn new() -> Self {
        // `posix_openpt`, `grantpt`, and `unlockpt` create a fresh PTY pair.
        // The master is held by this test; serialport opens the slave path.
        let master_fd =
            unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC) };
        assert!(
            master_fd >= 0,
            "could not create PTY master: {}",
            io::Error::last_os_error()
        );

        let master = unsafe { File::from_raw_fd(master_fd) };
        assert_eq!(
            unsafe { libc::grantpt(master.as_raw_fd()) },
            0,
            "could not grant PTY slave access: {}",
            io::Error::last_os_error()
        );
        assert_eq!(
            unsafe { libc::unlockpt(master.as_raw_fd()) },
            0,
            "could not unlock PTY slave: {}",
            io::Error::last_os_error()
        );

        let mut path = vec![0 as libc::c_char; 128];
        let result = unsafe { libc::ptsname_r(master.as_raw_fd(), path.as_mut_ptr(), path.len()) };
        assert_eq!(
            result,
            0,
            "could not resolve PTY slave path: {}",
            io::Error::from_raw_os_error(result)
        );
        let slave_path = unsafe { CStr::from_ptr(path.as_ptr()) }
            .to_str()
            .expect("Linux PTY path must be UTF-8")
            .to_owned();

        Self { master, slave_path }
    }
}

fn open_serial(pty: &PtyPair, timeout: Duration) -> Box<dyn SerialPort> {
    serialport::new(&pty.slave_path, 57_600)
        .timeout(timeout)
        // PTYs implement a terminal stream, not an electrical UART, so Linux
        // intentionally normalizes their framing to this supported baseline.
        .data_bits(DataBits::Eight)
        .parity(Parity::None)
        .stop_bits(StopBits::One)
        .flow_control(FlowControl::None)
        .open()
        .expect("serialport should open and configure a PTY")
}

fn read_exact_with_deadline(file: &mut File, buffer: &mut [u8], timeout: Duration) {
    let deadline = Instant::now() + timeout;
    let mut offset = 0;
    while offset < buffer.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "timed out after {timeout:?} with {offset}/{} bytes",
            buffer.len()
        );
        let timeout_ms = remaining
            .as_millis()
            .clamp(1, i32::MAX as u128)
            .try_into()
            .unwrap();
        let mut poll_fd = libc::pollfd {
            fd: file.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut poll_fd, 1, timeout_ms) };
        assert!(
            ready > 0,
            "PTY read did not become ready within {timeout:?}: {}",
            if ready < 0 {
                io::Error::last_os_error().to_string()
            } else {
                "deadline expired".into()
            }
        );
        assert_ne!(
            poll_fd.revents & (libc::POLLIN | libc::POLLERR | libc::POLLHUP),
            0,
            "PTY returned unexpected poll events: {}",
            poll_fd.revents
        );
        match file.read(&mut buffer[offset..]) {
            Ok(0) => panic!("PTY reached EOF with {offset}/{} bytes", buffer.len()),
            Ok(count) => offset += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => panic!("could not read PTY master: {error}"),
        }
    }
}

fn capture_file(name: &str) -> TemporaryCapture {
    let path = std::env::temp_dir().join(format!("baudtide-pty-{name}-{}.log", Uuid::new_v4()));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .expect("could not create temporary capture file");
    TemporaryCapture {
        path,
        file: Some(file),
    }
}

fn capture_info(log_path: &Path) -> SessionInfo {
    SessionInfo {
        id: "pty-session".into(),
        port: "/dev/pts/test".into(),
        baud_rate: 57_600,
        session_name: "PTY lifecycle".into(),
        log_path: log_path.display().to_string(),
        state: "connected",
        settings: SerialSettings::default(),
    }
}

fn wait_until(timeout: Duration, predicate: impl Fn() -> bool) {
    let deadline = Instant::now() + timeout;
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "condition did not become true within {timeout:?}"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn recv_events_until(
    rx: &mpsc::Receiver<super::SerialDataEvent>,
    expected_bytes: usize,
    timeout: Duration,
) -> Vec<super::SerialDataEvent> {
    let deadline = Instant::now() + timeout;
    let mut events = Vec::new();
    let mut received_bytes = 0;
    while received_bytes < expected_bytes {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "timed out after {timeout:?} with {received_bytes}/{expected_bytes} bytes"
        );
        let event = rx
            .recv_timeout(remaining)
            .expect("serial event did not arrive before the test deadline");
        received_bytes += event.bytes.len();
        events.push(event);
    }
    events
}

fn concat_event_bytes(events: &[super::SerialDataEvent]) -> Vec<u8> {
    events
        .iter()
        .flat_map(|event| event.bytes.iter().copied())
        .collect()
}

fn assert_contiguous_sequences(events: &[super::SerialDataEvent], starting_at: u64) {
    assert_eq!(
        events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        (starting_at..starting_at + events.len() as u64).collect::<Vec<_>>()
    );
}

#[test]
fn pty_open_applies_requested_serial_configuration() {
    let pty = PtyPair::new();
    let port = open_serial(&pty, Duration::from_millis(75));

    assert_eq!(port.baud_rate().unwrap(), 57_600);
    assert_eq!(port.data_bits().unwrap(), DataBits::Eight);
    assert_eq!(port.parity().unwrap(), Parity::None);
    assert_eq!(port.stop_bits().unwrap(), StopBits::One);
    assert_eq!(port.flow_control().unwrap(), FlowControl::None);
    assert_eq!(port.timeout(), Duration::from_millis(75));
}

#[test]
fn pty_serial_port_preserves_binary_bytes_in_both_directions() {
    let mut pty = PtyPair::new();
    let mut port = open_serial(&pty, Duration::from_millis(150));
    let device_to_host = [0x00, 0xff, b'\n', 0x80, b'A', b'\r'];
    let host_to_device = [0xfe, 0x00, b'B', b'\n', 0x7f];

    pty.master.write_all(&device_to_host).unwrap();
    let mut received_by_host = [0_u8; 6];
    port.read_exact(&mut received_by_host).unwrap();
    assert_eq!(received_by_host, device_to_host);

    port.write_all(&host_to_device).unwrap();
    port.flush().unwrap();
    let mut received_by_device = [0_u8; 5];
    read_exact_with_deadline(
        &mut pty.master,
        &mut received_by_device,
        Duration::from_secs(1),
    );
    assert_eq!(received_by_device, host_to_device);
}

#[test]
fn baudtide_writer_preserves_exact_bytes_and_enforces_limit() {
    let mut pty = PtyPair::new();
    let writer = Mutex::new(Some(open_serial(&pty, Duration::from_millis(150))));
    let stopped = AtomicBool::new(false);
    let payload = [0x00, 0xff, 0x80, b'\r', b'\n', 0x7f];

    assert_eq!(
        write_serial_bytes(&writer, &stopped, &pty.slave_path, &payload).unwrap(),
        payload.len()
    );
    let mut received = [0_u8; 6];
    read_exact_with_deadline(&mut pty.master, &mut received, Duration::from_secs(1));
    assert_eq!(received, payload);

    let oversized = vec![0_u8; SERIAL_WRITE_BYTE_LIMIT + 1];
    let error = write_serial_bytes(&writer, &stopped, &pty.slave_path, &oversized).unwrap_err();
    assert_eq!(
        error,
        format!("Serial writes are limited to {SERIAL_WRITE_BYTE_LIMIT} bytes.")
    );
}

#[test]
fn pty_serial_read_honors_timeout_then_remains_usable() {
    let mut pty = PtyPair::new();
    let mut port = open_serial(&pty, Duration::from_millis(60));
    let mut byte = [0_u8; 1];

    let started = Instant::now();
    let error = port.read(&mut byte).unwrap_err();
    let elapsed = started.elapsed();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(
        elapsed >= Duration::from_millis(35),
        "timeout returned too early: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_secs(1),
        "timeout took too long: {elapsed:?}"
    );

    pty.master.write_all(b"R").unwrap();
    port.read_exact(&mut byte).unwrap();
    assert_eq!(byte, *b"R");
}

#[test]
fn pty_master_close_surfaces_as_a_serial_hangup() {
    let pty = PtyPair::new();
    let mut port = open_serial(&pty, Duration::from_millis(100));

    drop(pty.master);
    let mut byte = [0_u8; 1];
    match port.read(&mut byte) {
        Ok(0) => {}
        Ok(count) => panic!("expected PTY EOF after master close, received {count} bytes"),
        // Linux PTYs report this end-of-stream condition as EIO, which Rust
        // maps to BrokenPipe. Real serial unplug failures are likewise
        // surfaced through the reader's non-timeout error path.
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {}
        Err(error) => panic!("expected PTY hangup after master close, got {error}"),
    }
}

#[test]
fn pty_capture_loop_persists_raw_bytes_and_replays_startup_events_in_order() {
    let mut pty = PtyPair::new();
    let reader = open_serial(&pty, Duration::from_millis(50));
    let mut capture = capture_file("startup-replay");
    let info = capture_info(&capture.path);
    let log_path = capture.path.clone();
    let log_file = capture.file.take().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let quota = Arc::new(Mutex::new(CaptureQuota {
        used_bytes: 0,
        limit_bytes: 4_096,
    }));
    let delivery = Arc::new(Mutex::new(SerialEventDelivery::Buffering {
        events: Vec::new(),
        buffered_bytes: 0,
        dropped_event_count: 0,
        next_sequence: 1,
    }));
    let received_bytes = Arc::new(AtomicUsize::new(0));
    let (finished_tx, finished_rx) = mpsc::channel();

    let reader_stop = Arc::clone(&stop);
    let reader_quota = Arc::clone(&quota);
    let reader_delivery = Arc::clone(&delivery);
    let reader_received_bytes = Arc::clone(&received_bytes);
    let reader_info = info.clone();
    let reader_thread = thread::spawn(move || {
        let terminal_status = run_serial_capture_loop(
            reader,
            log_file,
            &reader_info,
            reader_stop.as_ref(),
            &reader_quota,
            |event| {
                let event_bytes = event.bytes.len();
                assert!(buffer_serial_event(&reader_delivery, event).is_none());
                // Count after the delivery state records the event so the
                // test cannot activate the handoff in between those steps.
                reader_received_bytes.fetch_add(event_bytes, Ordering::Release);
            },
        );
        finished_tx.send(terminal_status).unwrap();
    });

    let payload = [0x00, 0xff, b'A', b'\r', b'\n', 0x80];
    pty.master.write_all(&payload).unwrap();
    wait_until(Duration::from_secs(1), || {
        received_bytes.load(Ordering::Acquire) == payload.len()
    });

    // The serial reader uses a finite read timeout, so shutdown cannot hang on
    // an idle PTY. A normal stop must preserve the capture without an error.
    stop.store(true, Ordering::Release);
    assert_eq!(
        finished_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        None
    );
    reader_thread.join().unwrap();

    let pending = activate_serial_event_delivery(&mut delivery.lock().unwrap());
    let replayed_bytes = pending
        .events
        .iter()
        .flat_map(|event| event.bytes.iter().copied())
        .collect::<Vec<_>>();
    assert_eq!(replayed_bytes, payload);
    assert_eq!(
        pending
            .events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        (1..=pending.events.len() as u64).collect::<Vec<_>>()
    );
    assert_eq!(pending.next_sequence, pending.events.len() as u64 + 1);
    assert_eq!(std::fs::read(&log_path).unwrap(), payload);
    assert_eq!(quota.lock().unwrap().used_bytes, payload.len() as u64);
}

#[test]
fn pty_capture_loop_truncates_a_quota_crossing_chunk_then_finalizes() {
    let mut pty = PtyPair::new();
    let reader = open_serial(&pty, Duration::from_millis(50));
    let mut capture = capture_file("quota-boundary");
    let info = capture_info(&capture.path);
    let log_path = capture.path.clone();
    let log_file = capture.file.take().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    // Start with 11 bytes already reserved by another capture. The single PTY
    // write below therefore crosses the five bytes still available.
    let quota = Arc::new(Mutex::new(CaptureQuota {
        used_bytes: 11,
        limit_bytes: 16,
    }));
    let (event_tx, event_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();

    let reader_stop = Arc::clone(&stop);
    let reader_quota = Arc::clone(&quota);
    let reader_info = info.clone();
    let reader_thread = thread::spawn(move || {
        let terminal_status = run_serial_capture_loop(
            reader,
            log_file,
            &reader_info,
            reader_stop.as_ref(),
            &reader_quota,
            |event| event_tx.send(event).unwrap(),
        );
        finished_tx.send(terminal_status).unwrap();
    });

    let chunk = b"crosses-quota";
    let expected_prefix = &chunk[..5];
    let started = Instant::now();
    pty.master.write_all(chunk).unwrap();

    // The reader has a finite timeout, but quota exhaustion must not wait for
    // another read: the terminal status arrives from the same admitted chunk.
    let (status, message) = finished_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("quota boundary did not stop the capture loop before its deadline")
        .expect("a quota boundary should report a terminal status");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "storage-limit reporting exceeded the test deadline"
    );
    reader_thread.join().unwrap();

    let events = event_rx.try_iter().collect::<Vec<_>>();
    assert_eq!(
        events.len(),
        1,
        "crossing chunk should emit only its prefix"
    );
    assert_eq!(events[0].sequence, 1);
    assert_eq!(events[0].bytes, expected_prefix);
    assert_eq!(std::fs::read(&log_path).unwrap(), expected_prefix);
    assert_eq!(status, "storage-limit");
    assert_eq!(
        message,
        "Storage limit reached; logging stopped before exceeding the configured capture-library limit."
    );
    let quota = quota.lock().unwrap();
    assert_eq!(quota.used_bytes, quota.limit_bytes);
    assert!(quota.used_bytes <= quota.limit_bytes);
}

#[test]
fn pty_capture_handoff_stays_ordered_across_a_frontend_reload() {
    let mut pty = PtyPair::new();
    let reader = open_serial(&pty, Duration::from_millis(50));
    let mut capture = capture_file("reload-handoff");
    let info = capture_info(&capture.path);
    let log_path = capture.path.clone();
    let log_file = capture.file.take().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let quota = Arc::new(Mutex::new(CaptureQuota {
        used_bytes: 0,
        limit_bytes: 4_096,
    }));
    let delivery = Arc::new(Mutex::new(SerialEventDelivery::Buffering {
        events: Vec::new(),
        buffered_bytes: 0,
        dropped_event_count: 0,
        next_sequence: 1,
    }));
    let received_bytes = Arc::new(AtomicUsize::new(0));
    let (live_tx, live_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();

    let reader_stop = Arc::clone(&stop);
    let reader_quota = Arc::clone(&quota);
    let reader_delivery = Arc::clone(&delivery);
    let reader_received_bytes = Arc::clone(&received_bytes);
    let reader_info = info.clone();
    let reader_thread = thread::spawn(move || {
        let terminal_status = run_serial_capture_loop(
            reader,
            log_file,
            &reader_info,
            reader_stop.as_ref(),
            &reader_quota,
            |event| {
                let event_bytes = event.bytes.len();
                if let Some(live_event) = buffer_serial_event(&reader_delivery, event) {
                    live_tx.send(live_event).unwrap();
                }
                // Count only after the delivery state has recorded the event;
                // otherwise the test could activate the handoff in the small
                // gap between the counter update and buffering.
                reader_received_bytes.fetch_add(event_bytes, Ordering::Release);
            },
        );
        finished_tx.send(terminal_status).unwrap();
    });

    let startup = b"startup\n";
    pty.master.write_all(startup).unwrap();
    wait_until(Duration::from_secs(1), || {
        received_bytes.load(Ordering::Acquire) == startup.len()
    });

    // Starting the frontend atomically turns the first buffered PTY chunk
    // into the replay snapshot before later chunks can be sent live.
    let initial_replay = activate_serial_event_delivery(&mut delivery.lock().unwrap());
    assert_eq!(initial_replay.events.len(), 1);
    assert_eq!(initial_replay.events[0].sequence, 1);
    assert_eq!(initial_replay.events[0].bytes, startup);
    assert_eq!(initial_replay.next_sequence, 2);

    let live = b"live\n";
    pty.master.write_all(live).unwrap();
    wait_until(Duration::from_secs(1), || {
        received_bytes.load(Ordering::Acquire) == startup.len() + live.len()
    });
    let live_event = live_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(live_event.sequence, 2);
    assert_eq!(live_event.bytes, live);

    // `list_active_sessions` performs this state transition after a WebView
    // reload. Reproduce it at the helper seam so bytes arriving in the reload
    // gap are buffered and replayed rather than emitted to the old listener.
    {
        let mut current_delivery = delivery.lock().unwrap();
        let next_sequence = match &*current_delivery {
            SerialEventDelivery::Live { next_sequence } => *next_sequence,
            SerialEventDelivery::Buffering { .. } => panic!("delivery should be live"),
        };
        *current_delivery = SerialEventDelivery::Buffering {
            events: Vec::new(),
            buffered_bytes: 0,
            dropped_event_count: 0,
            next_sequence,
        };
    }

    let reload_gap = b"reload\n";
    pty.master.write_all(reload_gap).unwrap();
    wait_until(Duration::from_secs(1), || {
        received_bytes.load(Ordering::Acquire) == startup.len() + live.len() + reload_gap.len()
    });
    assert!(matches!(live_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));

    let reload_replay = activate_serial_event_delivery(&mut delivery.lock().unwrap());
    assert_eq!(reload_replay.events.len(), 1);
    assert_eq!(reload_replay.events[0].sequence, 3);
    assert_eq!(reload_replay.events[0].bytes, reload_gap);
    assert_eq!(reload_replay.next_sequence, 4);

    stop.store(true, Ordering::Release);
    assert_eq!(
        finished_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        None
    );
    reader_thread.join().unwrap();

    let expected_capture = [startup.as_slice(), live.as_slice(), reload_gap.as_slice()].concat();
    assert_eq!(std::fs::read(&log_path).unwrap(), expected_capture);
    assert_eq!(
        quota.lock().unwrap().used_bytes,
        expected_capture.len() as u64
    );
}

#[test]
fn pty_capture_loop_finalizes_then_reports_a_terminal_hangup() {
    let pty = PtyPair::new();
    let reader = open_serial(&pty, Duration::from_millis(50));
    let mut capture = capture_file("hangup");
    let info = capture_info(&capture.path);
    let log_path = capture.path.clone();
    let log_file = capture.file.take().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let quota = Arc::new(Mutex::new(CaptureQuota {
        used_bytes: 0,
        limit_bytes: 4_096,
    }));
    let (finished_tx, finished_rx) = mpsc::channel();

    // Closing the PTY master is the kernel-backed equivalent of losing the
    // device endpoint. Keep the test deadline-bounded in case platform error
    // delivery changes.
    drop(pty.master);
    let reader_stop = Arc::clone(&stop);
    let reader_quota = Arc::clone(&quota);
    let reader_thread = thread::spawn(move || {
        let terminal_status = run_serial_capture_loop(
            reader,
            log_file,
            &info,
            reader_stop.as_ref(),
            &reader_quota,
            |_| {},
        );
        finished_tx.send(terminal_status).unwrap();
    });

    let (status, message) = finished_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("hangup did not end the capture loop before its deadline")
        .expect("hangup should produce a terminal reader failure");
    reader_thread.join().unwrap();

    assert_eq!(status, "error");
    assert!(message.starts_with("Serial read failed:"), "{message}");
    assert_eq!(std::fs::read(&log_path).unwrap(), Vec::<u8>::new());
    assert_eq!(quota.lock().unwrap().used_bytes, 0);
}

#[test]
fn pty_capture_loop_user_stop_finalizes_multi_chunk_capture_without_terminal_error() {
    let mut pty = PtyPair::new();
    let reader = open_serial(&pty, Duration::from_millis(50));
    let mut capture = capture_file("user-stop-finalize");
    let info = capture_info(&capture.path);
    let log_path = capture.path.clone();
    let log_file = capture.file.take().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let quota = Arc::new(Mutex::new(CaptureQuota {
        used_bytes: 0,
        limit_bytes: 4_096,
    }));
    let (event_tx, event_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();

    let reader_stop = Arc::clone(&stop);
    let reader_quota = Arc::clone(&quota);
    let reader_info = info.clone();
    let reader_thread = thread::spawn(move || {
        let terminal_status = run_serial_capture_loop(
            reader,
            log_file,
            &reader_info,
            reader_stop.as_ref(),
            &reader_quota,
            |event| event_tx.send(event).unwrap(),
        );
        finished_tx.send(terminal_status).unwrap();
    });

    let first = b"boot:";
    let second = b" ready\n";
    let expected_capture = [first.as_slice(), second.as_slice()].concat();
    pty.master.write_all(first).unwrap();
    pty.master.write_all(second).unwrap();

    let events = recv_events_until(&event_rx, expected_capture.len(), Duration::from_secs(1));
    assert_contiguous_sequences(&events, 1);
    assert_eq!(concat_event_bytes(&events), expected_capture);

    stop.store(true, Ordering::Release);
    assert_eq!(
        finished_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        None
    );
    reader_thread.join().unwrap();

    assert_eq!(std::fs::read(&log_path).unwrap(), expected_capture);
    assert_eq!(
        quota.lock().unwrap().used_bytes,
        expected_capture.len() as u64
    );
}

#[test]
fn pty_reconnect_starts_a_new_capture_with_a_fresh_sequence_and_log() {
    let mut pty = PtyPair::new();
    let quota = Arc::new(Mutex::new(CaptureQuota {
        used_bytes: 0,
        limit_bytes: 4_096,
    }));

    let first_reader = open_serial(&pty, Duration::from_millis(50));
    let mut first_capture = capture_file("reconnect-first");
    let mut first_info = capture_info(&first_capture.path);
    first_info.id = "pty-session-1".into();
    let first_log_path = first_capture.path.clone();
    let first_log_file = first_capture.file.take().unwrap();
    let first_stop = Arc::new(AtomicBool::new(false));
    let (first_event_tx, first_event_rx) = mpsc::channel();
    let (first_finished_tx, first_finished_rx) = mpsc::channel();

    let first_reader_stop = Arc::clone(&first_stop);
    let first_reader_quota = Arc::clone(&quota);
    let first_reader_info = first_info.clone();
    let first_thread = thread::spawn(move || {
        let terminal_status = run_serial_capture_loop(
            first_reader,
            first_log_file,
            &first_reader_info,
            first_reader_stop.as_ref(),
            &first_reader_quota,
            |event| first_event_tx.send(event).unwrap(),
        );
        first_finished_tx.send(terminal_status).unwrap();
    });

    let first_payload = b"first capture\n";
    pty.master.write_all(first_payload).unwrap();
    let first_events =
        recv_events_until(&first_event_rx, first_payload.len(), Duration::from_secs(1));
    assert_contiguous_sequences(&first_events, 1);
    assert_eq!(concat_event_bytes(&first_events), first_payload);

    first_stop.store(true, Ordering::Release);
    assert_eq!(
        first_finished_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap(),
        None
    );
    first_thread.join().unwrap();

    let second_reader = open_serial(&pty, Duration::from_millis(50));
    let mut second_capture = capture_file("reconnect-second");
    let mut second_info = capture_info(&second_capture.path);
    second_info.id = "pty-session-2".into();
    let second_log_path = second_capture.path.clone();
    let second_log_file = second_capture.file.take().unwrap();
    let second_stop = Arc::new(AtomicBool::new(false));
    let (second_event_tx, second_event_rx) = mpsc::channel();
    let (second_finished_tx, second_finished_rx) = mpsc::channel();

    let second_reader_stop = Arc::clone(&second_stop);
    let second_reader_quota = Arc::clone(&quota);
    let second_reader_info = second_info.clone();
    let second_thread = thread::spawn(move || {
        let terminal_status = run_serial_capture_loop(
            second_reader,
            second_log_file,
            &second_reader_info,
            second_reader_stop.as_ref(),
            &second_reader_quota,
            |event| second_event_tx.send(event).unwrap(),
        );
        second_finished_tx.send(terminal_status).unwrap();
    });

    let second_payload = b"second capture\n";
    pty.master.write_all(second_payload).unwrap();
    let second_events = recv_events_until(
        &second_event_rx,
        second_payload.len(),
        Duration::from_secs(1),
    );
    assert_contiguous_sequences(&second_events, 1);
    assert_eq!(concat_event_bytes(&second_events), second_payload);

    second_stop.store(true, Ordering::Release);
    assert_eq!(
        second_finished_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap(),
        None
    );
    second_thread.join().unwrap();

    assert_eq!(std::fs::read(&first_log_path).unwrap(), first_payload);
    assert_eq!(std::fs::read(&second_log_path).unwrap(), second_payload);
    assert_eq!(
        quota.lock().unwrap().used_bytes,
        (first_payload.len() + second_payload.len()) as u64
    );
}

#[test]
fn pty_event_delivery_replays_buffered_bytes_once_then_continues_live_across_reload() {
    let mut pty = PtyPair::new();
    let reader = open_serial(&pty, Duration::from_millis(50));
    let mut capture = capture_file("replay-once-reload");
    let info = capture_info(&capture.path);
    let log_path = capture.path.clone();
    let log_file = capture.file.take().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let quota = Arc::new(Mutex::new(CaptureQuota {
        used_bytes: 0,
        limit_bytes: 4_096,
    }));
    let delivery = Arc::new(Mutex::new(SerialEventDelivery::Buffering {
        events: Vec::new(),
        buffered_bytes: 0,
        dropped_event_count: 0,
        next_sequence: 1,
    }));
    let received_bytes = Arc::new(AtomicUsize::new(0));
    let (live_tx, live_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();

    let reader_stop = Arc::clone(&stop);
    let reader_quota = Arc::clone(&quota);
    let reader_delivery = Arc::clone(&delivery);
    let reader_received_bytes = Arc::clone(&received_bytes);
    let reader_info = info.clone();
    let reader_thread = thread::spawn(move || {
        let terminal_status = run_serial_capture_loop(
            reader,
            log_file,
            &reader_info,
            reader_stop.as_ref(),
            &reader_quota,
            |event| {
                let event_bytes = event.bytes.len();
                if let Some(live_event) = buffer_serial_event(&reader_delivery, event) {
                    live_tx.send(live_event).unwrap();
                }
                // Count only after buffering/live delivery has recorded the
                // event, avoiding an activation race in the test.
                reader_received_bytes.fetch_add(event_bytes, Ordering::Release);
            },
        );
        finished_tx.send(terminal_status).unwrap();
    });

    let startup = b"startup bytes\n";
    pty.master.write_all(startup).unwrap();
    wait_until(Duration::from_secs(1), || {
        received_bytes.load(Ordering::Acquire) >= startup.len()
    });
    let initial_replay = activate_serial_event_delivery(&mut delivery.lock().unwrap());
    assert_eq!(concat_event_bytes(&initial_replay.events), startup);
    assert_contiguous_sequences(&initial_replay.events, 1);
    assert_eq!(
        initial_replay.next_sequence,
        initial_replay.events.len() as u64 + 1
    );

    let repeated_activation = activate_serial_event_delivery(&mut delivery.lock().unwrap());
    assert!(repeated_activation.events.is_empty());
    assert_eq!(
        repeated_activation.next_sequence,
        initial_replay.next_sequence
    );

    let live = b"live bytes\n";
    pty.master.write_all(live).unwrap();
    let live_events = recv_events_until(&live_rx, live.len(), Duration::from_secs(1));
    assert_eq!(
        live_events.first().unwrap().sequence,
        initial_replay.next_sequence
    );
    assert_contiguous_sequences(&live_events, initial_replay.next_sequence);
    assert_eq!(concat_event_bytes(&live_events), live);

    {
        let mut current_delivery = delivery.lock().unwrap();
        let next_sequence = match &*current_delivery {
            SerialEventDelivery::Live { next_sequence } => *next_sequence,
            SerialEventDelivery::Buffering { .. } => panic!("delivery should be live"),
        };
        *current_delivery = SerialEventDelivery::Buffering {
            events: Vec::new(),
            buffered_bytes: 0,
            dropped_event_count: 0,
            next_sequence,
        };
    }

    let reload_gap = b"reload gap\n";
    pty.master.write_all(reload_gap).unwrap();
    wait_until(Duration::from_secs(1), || {
        received_bytes.load(Ordering::Acquire) >= startup.len() + live.len() + reload_gap.len()
    });
    let reload_replay = activate_serial_event_delivery(&mut delivery.lock().unwrap());
    assert_eq!(concat_event_bytes(&reload_replay.events), reload_gap);
    assert_eq!(
        reload_replay.events.first().unwrap().sequence,
        live_events.last().unwrap().sequence + 1
    );
    assert_contiguous_sequences(&reload_replay.events, reload_replay.events[0].sequence);

    let repeated_reload_activation = activate_serial_event_delivery(&mut delivery.lock().unwrap());
    assert!(repeated_reload_activation.events.is_empty());
    assert_eq!(
        repeated_reload_activation.next_sequence,
        reload_replay.next_sequence
    );

    let post_reload_live = b"post reload live\n";
    pty.master.write_all(post_reload_live).unwrap();
    let post_reload_events =
        recv_events_until(&live_rx, post_reload_live.len(), Duration::from_secs(1));
    assert_eq!(
        post_reload_events.first().unwrap().sequence,
        reload_replay.next_sequence
    );
    assert_contiguous_sequences(&post_reload_events, reload_replay.next_sequence);
    assert_eq!(concat_event_bytes(&post_reload_events), post_reload_live);

    stop.store(true, Ordering::Release);
    assert_eq!(
        finished_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        None
    );
    reader_thread.join().unwrap();

    let expected_capture = [
        startup.as_slice(),
        live.as_slice(),
        reload_gap.as_slice(),
        post_reload_live.as_slice(),
    ]
    .concat();
    assert_eq!(std::fs::read(&log_path).unwrap(), expected_capture);
}

#[test]
fn pty_quota_terminal_status_arrives_after_the_last_admitted_event() {
    let mut pty = PtyPair::new();
    let reader = open_serial(&pty, Duration::from_millis(50));
    let mut capture = capture_file("quota-status-order");
    let info = capture_info(&capture.path);
    let log_path = capture.path.clone();
    let log_file = capture.file.take().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let quota = Arc::new(Mutex::new(CaptureQuota {
        used_bytes: 6,
        limit_bytes: 10,
    }));
    let (event_tx, event_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();

    let reader_stop = Arc::clone(&stop);
    let reader_quota = Arc::clone(&quota);
    let reader_info = info.clone();
    let reader_thread = thread::spawn(move || {
        let terminal_status = run_serial_capture_loop(
            reader,
            log_file,
            &reader_info,
            reader_stop.as_ref(),
            &reader_quota,
            |event| event_tx.send((Instant::now(), event)).unwrap(),
        );
        finished_tx.send((Instant::now(), terminal_status)).unwrap();
    });

    let chunk = b"abcdef";
    let expected_prefix = &chunk[..4];
    pty.master.write_all(chunk).unwrap();

    let (event_time, event) = event_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let (status_time, status) = finished_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    reader_thread.join().unwrap();

    assert!(
        event_time <= status_time,
        "terminal status arrived before the last admitted bytes were published"
    );
    assert_eq!(event.sequence, 1);
    assert_eq!(event.bytes, expected_prefix);
    let (status, message) = status.expect("quota crossing should stop the capture");
    assert_eq!(status, "storage-limit");
    assert_eq!(
        message,
        "Storage limit reached; logging stopped before exceeding the configured capture-library limit."
    );
    assert_eq!(std::fs::read(&log_path).unwrap(), expected_prefix);
    assert_eq!(quota.lock().unwrap().used_bytes, 10);
}
