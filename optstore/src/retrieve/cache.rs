use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
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

    pub fn load_manifest(&self, spec: &RetrieveSpec) -> Result<Option<CacheManifest>> {
        let path = self.manifest_path(spec);
        match fs::read(&path) {
            Ok(bytes) => {
                let manifest: CacheManifest = serde_json::from_slice(&bytes)?;
                Ok(Some(manifest))
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    pub fn store_manifest(&self, spec: &RetrieveSpec, manifest: &CacheManifest) -> Result<()> {
        let path = self.manifest_path(spec);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_vec_pretty(manifest)?;
        fs::write(&path, data)?;
        Ok(())
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CacheManifest {
    pub version: u32,
    pub source: String,
    pub symbol: String,
    pub day_ymd: u32,
    pub parts: Vec<CacheManifestPart>,
    pub resume_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheManifestPart {
    pub part: u32,
    pub start_ns: u64,
    pub end_ns: u64,
    pub bytes: u64,
    pub rows: u64,
    pub resume_token: Option<String>,
}

impl CacheManifest {
    pub fn new(source: &str, spec: &RetrieveSpec) -> Self {
        Self {
            version: 1,
            source: source.to_string(),
            symbol: spec.symbol.clone(),
            day_ymd: spec.day_ymd,
            parts: Vec::new(),
            resume_token: None,
        }
    }

    pub fn append_part(&mut self, entry: CacheManifestPart) {
        self.resume_token = entry.resume_token.clone();
        self.parts.push(entry);
    }
}
