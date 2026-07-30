//! Linux-only integration coverage for the serial crate using pseudo-terminals.
//!
//! A PTY gives these tests a kernel-backed serial-like device without requiring
//! an Arduino, ESP32, USB adapter, or any `/dev/ttyUSB*` hardware.

use std::{
    ffi::CStr,
    fs::File,
    io::{self, Read, Write},
    os::fd::{AsRawFd, FromRawFd},
    time::{Duration, Instant},
};

use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};

struct PtyPair {
    master: File,
    slave_path: String,
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
    pty.master.read_exact(&mut received_by_device).unwrap();
    assert_eq!(received_by_device, host_to_device);
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
