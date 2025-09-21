use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use zstd::stream::write::Encoder as ZstdEncoder;

use super::{RawChunk, RetrieveSpec};

#[derive(Debug)]
pub struct CacheManager {
    root: PathBuf,
}

#[derive(Debug)]
pub struct CacheWriteResult {
    pub path: PathBuf,
    pub bytes_written: u64,
    pub rows: u64,
}

impl CacheManager {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn write_chunk(
        &self,
        spec: &RetrieveSpec,
        part: u32,
        chunk: &RawChunk,
    ) -> Result<CacheWriteResult> {
        let dir = self.partition_dir(spec);
        fs::create_dir_all(&dir).with_context(|| format!("create cache dir {dir:?}"))?;
        let filename = format!("part-{part:04}.jsonl.zst");
        let path = dir.join(filename);

        let file = File::create(&path).with_context(|| format!("create cache file {path:?}"))?;
        let mut encoder = ZstdEncoder::new(BufWriter::new(file), 3)?;
        encoder.write_all(&chunk.data)?;
        let mut writer = encoder.finish()?;
        writer.flush()?;

        let bytes_written = fs::metadata(&path)?.len();
        let rows = bytecount::count(&chunk.data, b'\n') as u64;

        Ok(CacheWriteResult {
            path,
            bytes_written,
            rows,
        })
    }

    pub fn manifest_path(&self, spec: &RetrieveSpec) -> PathBuf {
        self.partition_dir(spec).join("manifest.json")
    }

    fn partition_dir(&self, spec: &RetrieveSpec) -> PathBuf {
        let date = format!("{:08}", spec.day_ymd);
        let (year, month, day) = (&date[0..4], &date[4..6], &date[6..8]);
        self.root
            .join(&spec.symbol)
            .join(year)
            .join(month)
            .join(day)
    }
}
