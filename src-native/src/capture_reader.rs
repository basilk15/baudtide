//! Bounded, sequential snapshots for complete-capture analysis. Never modifies raw files.
use crate::capture_timing::{companion_path, ReceiveTiming};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::{self, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

const CHUNK_BYTES: u64 = 64 * 1024;
const CHUNK_RECORDS: usize = 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureChunk {
    pub offset: u64,
    pub next_offset: u64,
    pub total_bytes: u64,
    pub raw_base64: String,
    pub timing: Option<Vec<ReceiveTiming>>,
}

struct TimingStream {
    file: BufReader<File>,
    current: Option<ReceiveTiming>,
}

fn record(file: &mut impl Read) -> io::Result<ReceiveTiming> {
    let mut bytes = [0_u8; 16];
    file.read_exact(&mut bytes)?;
    Ok(ReceiveTiming {
        end_offset: u64::from_le_bytes(bytes[..8].try_into().unwrap()),
        timestamp_ms: i64::from_le_bytes(bytes[8..].try_into().unwrap()),
    })
}

impl TimingStream {
    fn open(path: &Path, size: u64) -> io::Result<Self> {
        let path = companion_path(path);
        if !fs::symlink_metadata(&path)?.file_type().is_file() {
            return Err(io::Error::other("Timing is not a regular companion file"));
        }
        let mut file = BufReader::new(File::open(path)?);
        let timing_size = file.get_ref().metadata()?.len();
        if timing_size < 24 || (timing_size - 8) % 16 != 0 {
            return Err(io::Error::other("Incomplete timing"));
        }
        let mut magic = [0_u8; 8];
        file.read_exact(&mut magic)?;
        if &magic != b"BTIME001" {
            return Err(io::Error::other("Invalid timing header"));
        }
        let mut previous = 0;
        // Validate the entire captured snapshot without retaining the index in RAM.
        // An actively growing capture may have additional records after our raw snapshot.
        while previous < size {
            let next = record(&mut file)?;
            if next.end_offset <= previous
                || next.end_offset > size
                || chrono::DateTime::from_timestamp_millis(next.timestamp_ms).is_none()
            {
                return Err(io::Error::other("Invalid timing coverage"));
            }
            previous = next.end_offset;
        }
        file.seek(SeekFrom::Start(8))?;
        Ok(Self {
            file,
            current: None,
        })
    }
}

pub struct CaptureReader {
    raw: File,
    size: u64,
    offset: u64,
    timing: Option<TimingStream>,
}

impl CaptureReader {
    pub fn open(path: &Path) -> io::Result<Self> {
        let raw = File::open(path)?;
        let size = raw.metadata()?.len();
        if size > 9_007_199_254_740_991 {
            return Err(io::Error::other("Capture is too large to analyze"));
        }
        let timing = if size > 0 {
            TimingStream::open(path, size).ok()
        } else {
            None
        };
        Ok(Self {
            raw,
            size,
            offset: 0,
            timing,
        })
    }

    pub fn size(&self) -> u64 {
        self.size
    }
    pub fn recorded_timing(&self) -> bool {
        self.timing.is_some()
    }

    pub fn next(&mut self, encode: impl FnOnce(&[u8]) -> String) -> io::Result<CaptureChunk> {
        let start = self.offset;
        let desired = (start + CHUNK_BYTES).min(self.size);
        let mut end = desired;
        let mut records = Vec::new();
        if let Some(stream) = &mut self.timing {
            let mut covered = start;
            while covered < desired && records.len() < CHUNK_RECORDS {
                if stream.current.is_none() {
                    stream.current = Some(record(&mut stream.file)?);
                }
                let current = stream.current.as_ref().unwrap();
                if current.end_offset <= covered || current.end_offset > self.size {
                    return Err(io::Error::other(
                        "Capture timing changed during analysis; reopen the capture",
                    ));
                }
                covered = current.end_offset.min(desired);
                records.push(ReceiveTiming {
                    end_offset: covered - start,
                    timestamp_ms: current.timestamp_ms,
                });
                if current.end_offset <= desired {
                    stream.current = None;
                }
            }
            end = covered;
        }
        let mut bytes = vec![0; (end - start) as usize];
        self.raw.read_exact(&mut bytes)?;
        self.offset = end;
        Ok(CaptureChunk {
            offset: start,
            next_offset: end,
            total_bytes: self.size,
            raw_base64: encode(&bytes),
            timing: self.timing.as_ref().map(|_| records),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture_timing::TimingWriter;
    #[test]
    fn streams_beyond_the_old_limit_and_preserves_chunk_timing() {
        let path =
            std::env::temp_dir().join(format!("baudtide-reader-{}.log", uuid::Uuid::new_v4()));
        let size = 17 * 1024 * 1024;
        fs::write(&path, vec![65; size]).unwrap();
        let mut timing = TimingWriter::create(&path).unwrap();
        timing.record(size, 1000).unwrap();
        timing.flush(false).unwrap();
        let mut reader = CaptureReader::open(&path).unwrap();
        let mut total = 0;
        while total < size as u64 {
            let chunk = reader
                .next(|bytes| {
                    assert!(bytes.len() <= CHUNK_BYTES as usize);
                    String::new()
                })
                .unwrap();
            assert_eq!(
                chunk.timing.unwrap().last().unwrap().end_offset,
                chunk.next_offset - chunk.offset
            );
            total = chunk.next_offset;
        }
        assert_eq!(total, size as u64);
        assert!(reader
            .next(|bytes| {
                assert!(bytes.is_empty());
                String::new()
            })
            .is_ok());
        // This test owns these randomly named temporary fixtures only.
        fs::remove_file(companion_path(&path)).unwrap();
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn bounds_tiny_reads_and_falls_back_for_incomplete_timing() {
        let path =
            std::env::temp_dir().join(format!("baudtide-reader-{}.log", uuid::Uuid::new_v4()));
        fs::write(&path, vec![65; 3000]).unwrap();
        let mut timing = TimingWriter::create(&path).unwrap();
        for _ in 0..3000 {
            timing.record(1, 1000).unwrap();
        }
        timing.flush(false).unwrap();
        let mut reader = CaptureReader::open(&path).unwrap();
        let first = reader.next(|_| String::new()).unwrap();
        assert_eq!(first.next_offset, CHUNK_RECORDS as u64);
        assert_eq!(first.timing.unwrap().len(), CHUNK_RECORDS);
        fs::write(&path, vec![65; 3001]).unwrap();
        assert!(!CaptureReader::open(&path).unwrap().recorded_timing());
        fs::remove_file(companion_path(&path)).unwrap();
        fs::remove_file(path).unwrap();
    }
}
