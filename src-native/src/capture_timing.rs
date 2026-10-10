//! Receive timing is optional companion data. The .log remains byte-for-byte raw.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
};

use serde::Serialize;

const MAGIC: &[u8; 8] = b"BTIME001";
pub const HEADER_BYTES: u64 = 8;
pub const RECORD_BYTES: u64 = 16;
const MAX_REPLAY_RECORDS: usize = 1_000_000;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReceiveTiming {
    pub end_offset: u64,
    pub timestamp_ms: i64,
}

pub fn companion_path(raw: &Path) -> PathBuf {
    let mut name = raw.as_os_str().to_os_string();
    name.push(".timing");
    name.into()
}

pub struct TimingWriter {
    file: BufWriter<File>,
    offset: u64,
}

impl TimingWriter {
    pub fn create(raw: &Path) -> io::Result<Self> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(companion_path(raw))?;
        let mut writer = Self {
            file: BufWriter::new(file),
            offset: 0,
        };
        writer.file.write_all(MAGIC)?;
        writer.file.flush()?;
        Ok(writer)
    }

    pub fn record(&mut self, byte_count: usize, timestamp_ms: i64) -> io::Result<()> {
        self.offset += byte_count as u64;
        self.file.write_all(&self.offset.to_le_bytes())?;
        self.file.write_all(&timestamp_ms.to_le_bytes())
    }

    pub fn flush(&mut self, durable: bool) -> io::Result<()> {
        self.file.flush()?;
        if durable {
            self.file.get_ref().sync_data()?;
        }
        Ok(())
    }
}

/// Refuse malformed/incomplete timing rather than presenting invented times as
/// recorded. A truncated raw preview may use the valid prefix of a larger index.
pub fn read(raw: &Path, loaded_bytes: u64, raw_size: u64) -> Option<Vec<ReceiveTiming>> {
    if loaded_bytes == 0 {
        return None;
    }
    let path = companion_path(raw);
    // Companion files must be regular siblings, never symlinks to other files.
    if !fs::symlink_metadata(&path).ok()?.file_type().is_file() {
        return None;
    }
    decode(
        &mut BufReader::new(File::open(path).ok()?),
        loaded_bytes,
        raw_size,
    )
    .ok()
}

fn decode(
    reader: &mut impl Read,
    loaded_bytes: u64,
    raw_size: u64,
) -> io::Result<Vec<ReceiveTiming>> {
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Incomplete or invalid capture timing",
        )
    };
    let mut header = [0; 8];
    reader.read_exact(&mut header)?;
    if &header != MAGIC {
        return Err(invalid());
    }
    let mut previous = 0;
    let mut records = Vec::new();
    loop {
        let mut bytes = [0; 16];
        reader.read_exact(&mut bytes)?;
        let end_offset = u64::from_le_bytes(bytes[..8].try_into().unwrap());
        let timestamp_ms = i64::from_le_bytes(bytes[8..].try_into().unwrap());
        if end_offset <= previous
            || end_offset > raw_size
            || chrono::DateTime::from_timestamp_millis(timestamp_ms).is_none()
            || records.len() >= MAX_REPLAY_RECORDS
        {
            return Err(invalid());
        }
        records.push(ReceiveTiming {
            end_offset: end_offset.min(loaded_bytes),
            timestamp_ms,
        });
        previous = end_offset;
        if end_offset >= loaded_bytes {
            return Ok(records);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(records: &[(u64, i64)]) -> Vec<u8> {
        let mut bytes = MAGIC.to_vec();
        for (offset, time) in records {
            bytes.extend(offset.to_le_bytes());
            bytes.extend(time.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn preserves_bursts_and_pauses_and_clips_a_preview_mid_chunk() {
        let data = encoded(&[(5, 1000), (8, 1001), (20, 9000)]);
        let timing = decode(&mut &data[..], 15, 20).unwrap();
        assert_eq!(
            timing,
            vec![
                ReceiveTiming {
                    end_offset: 5,
                    timestamp_ms: 1000
                },
                ReceiveTiming {
                    end_offset: 8,
                    timestamp_ms: 1001
                },
                ReceiveTiming {
                    end_offset: 15,
                    timestamp_ms: 9000
                }
            ]
        );
    }

    #[test]
    fn rejects_partial_records_missing_coverage_and_invalid_offsets() {
        for data in [
            encoded(&[(5, 1000)]),
            encoded(&[(5, 1000), (5, 2000)]),
            encoded(&[(21, 1000)]),
            b"wrong header".to_vec(),
        ] {
            assert!(decode(&mut &data[..], 20, 20).is_err());
        }
        let mut data = encoded(&[(20, 1000)]);
        data.pop();
        assert!(decode(&mut &data[..], 20, 20).is_err());
    }

    #[test]
    fn keeps_real_clock_adjustments_instead_of_rewriting_timestamps() {
        let data = encoded(&[(5, 2000), (10, 1000)]);
        assert_eq!(
            decode(&mut &data[..], 10, 10).unwrap()[1].timestamp_ms,
            1000
        );
    }
}
