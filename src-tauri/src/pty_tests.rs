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
                reader_received_bytes.fetch_add(event.bytes.len(), Ordering::Release);
                assert!(buffer_serial_event(&reader_delivery, event).is_none());
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
                reader_received_bytes.fetch_add(event.bytes.len(), Ordering::Release);
                if let Some(live_event) = buffer_serial_event(&reader_delivery, event) {
                    live_tx.send(live_event).unwrap();
                }
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
