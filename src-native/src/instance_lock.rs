use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
};

pub(crate) fn try_acquire(root: &Path) -> io::Result<Option<File>> {
    fs::create_dir_all(root)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(".sidecar.lock"))?;
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        // The open handle owns the advisory lock until the process exits or closes it.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(file));
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::WouldBlock {
            return Ok(None);
        }
        Err(error)
    }
    #[cfg(windows)]
    {
        use std::{ffi::c_void, os::windows::io::AsRawHandle};
        #[repr(C)]
        struct Overlapped {
            internal: usize,
            internal_high: usize,
            offset: u32,
            offset_high: u32,
            event: *mut c_void,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn LockFileEx(
                file: *mut c_void,
                flags: u32,
                reserved: u32,
                low: u32,
                high: u32,
                overlapped: *mut Overlapped,
            ) -> i32;
        }
        let mut overlapped = Overlapped {
            internal: 0,
            internal_high: 0,
            offset: 0,
            offset_high: 0,
            event: std::ptr::null_mut(),
        };
        // Lock one byte exclusively without waiting. The kernel releases it on handle close.
        if unsafe { LockFileEx(file.as_raw_handle(), 3, 0, 1, 0, &mut overlapped) } != 0 {
            return Ok(Some(file));
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(33) {
            return Ok(None);
        }
        Err(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ownership_is_exclusive_until_the_handle_is_closed() {
        let root = std::env::temp_dir().join(format!("baudtide-lock-{}", uuid::Uuid::new_v4()));
        let first = try_acquire(&root).unwrap().unwrap();
        assert!(try_acquire(&root).unwrap().is_none());
        drop(first);
        let next = try_acquire(&root).unwrap().unwrap();
        drop(next);
        fs::remove_dir_all(root).unwrap();
    }
}
