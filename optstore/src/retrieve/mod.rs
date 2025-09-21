use crate::progress::{Progress, ProgressKind, ProgressUpdate};
use clap::{Parser, ValueEnum};
use fxhash::FxHashSet;
use std::path::PathBuf;
use tracing::warn;
use xxhash_rust::xxh3::xxh3_64;

pub mod cache;
pub mod deribit;
pub mod normalize;

use async_trait::async_trait;
use bytes::Bytes;
pub use cache::{CacheManager, CacheManifest, CacheManifestPart, CacheWriteResult};
pub use deribit::{DeribitKind, DeribitSource};
pub use normalize::{DeribitNormalizer, Normalizer};

#[derive(Clone, Debug)]
pub struct RawChunk {
    pub data: Bytes,
    pub start_ns: u64,
    pub end_ns: u64,
    pub resume: Option<String>,
}

#[derive(Clone, Debug)]
pub enum RetrieveKind {
    Trades,
    Quotes,
    Both,
}

#[derive(Clone, Debug)]
pub struct RetrieveSpec {
    pub symbol: String,
    pub day_ymd: u32,
    pub kind: RetrieveKind,
}

#[async_trait]
pub trait Source {
    async fn fetch(
        &self,
        spec: &RetrieveSpec,
        options: &RetrieveOptions,
    ) -> anyhow::Result<Vec<RawChunk>>;
    fn name(&self) -> &'static str;
}

#[derive(Clone, Debug, Default)]
pub struct RetrieveOptions {
    pub resume_from: Option<String>,
    pub max_pages: Option<u32>,
}

#[derive(Parser, Debug)]
pub struct RetrieveCommand {
    /// Upstream source name (currently only "deribit")
    #[arg(long = "source")]
    pub source: String,
    /// Symbol identifier
    #[arg(long = "symbol")]
    pub symbol: String,
    /// Day in YYYY-MM-DD
    #[arg(long = "day")]
    pub day: String,
    /// Output directory for cached parts
    #[arg(long = "out")]
    pub out: PathBuf,
    /// Resume previous run if partial data exists
    #[arg(long = "resume", default_value_t = false)]
    pub resume: bool,
    /// Maximum pages to fetch (0 = unlimited)
    #[arg(long = "max-pages", default_value_t = 0u32)]
    pub max_pages: u32,
    /// Rate limit (requests per second)
    #[arg(long = "rate", default_value_t = 4u32)]
    pub rate: u32,
    /// Fetch trades, quotes or both
    #[arg(long = "kind", default_value = "trades")]
    pub kind: RetrieveKindArg,
}

#[derive(Clone, Debug, Copy, PartialEq, Eq, ValueEnum)]
pub enum RetrieveKindArg {
    Trades,
    Quotes,
    Both,
}

impl From<RetrieveKindArg> for RetrieveKind {
    fn from(value: RetrieveKindArg) -> Self {
        match value {
            RetrieveKindArg::Trades => RetrieveKind::Trades,
            RetrieveKindArg::Quotes => RetrieveKind::Quotes,
            RetrieveKindArg::Both => RetrieveKind::Both,
        }
    }
}

pub fn run(cmd: RetrieveCommand, quiet: bool, json: bool) -> anyhow::Result<()> {
    let mut progress = Progress::new(quiet, json);
    let spec = RetrieveSpec {
        symbol: cmd.symbol.clone(),
        day_ymd: parse_day(&cmd.day)?,
        kind: cmd.kind.into(),
    };

    let token = progress.start(ProgressKind::Retrieve {
        symbol: spec.symbol.clone(),
        day: cmd.day.clone(),
        source: cmd.source.clone(),
    });

    let cache = CacheManager::new(cmd.out.clone());

    let mut manifest = if cmd.resume {
        cache
            .load_manifest(&spec)?
            .unwrap_or_else(|| CacheManifest::new(&cmd.source, &spec))
    } else {
        CacheManifest::new(&cmd.source, &spec)
    };

    let mut total_rows: u64 = manifest.parts.iter().map(|p| p.rows).sum();
    let mut total_bytes: u64 = manifest.parts.iter().map(|p| p.bytes).sum();

    let options = RetrieveOptions {
        resume_from: if cmd.resume {
            manifest.resume_token.clone()
        } else {
            None
        },
        max_pages: (cmd.max_pages > 0).then_some(cmd.max_pages),
    };

    let chunks = match cmd.source.as_str() {
        "deribit" => {
            let source = DeribitSource::new(cmd.rate);
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            rt.block_on(source.fetch(&spec, &options))?
        }
        other => {
            warn!(target: "optstore::retrieve", ?other, "unknown source");
            Vec::new()
        }
    };

    let normalizer = DeribitNormalizer {
        instrument_id: instrument_id_from_symbol(&spec.symbol),
    };
    let mut dedup = FxHashSet::default();

    let mut part_index = manifest.parts.len() as u32;
    for chunk in chunks.into_iter() {
        let result = cache.write_chunk(&spec, part_index, &chunk)?;

        let unique_summary = normalize_and_dedup(&normalizer, &chunk, &mut dedup)?;

        total_rows += result.rows;
        total_bytes += result.bytes_written;

        let manifest_part = CacheManifestPart {
            part: part_index,
            start_ns: chunk.start_ns,
            end_ns: chunk.end_ns,
            bytes: result.bytes_written,
            rows: result.rows,
            resume_token: chunk.resume.clone(),
        };
        manifest.append_part(manifest_part);

        if let Some((unique, duplicates)) = unique_summary {
            progress.update(
                &token,
                ProgressUpdate::Message {
                    message: format!(
                        "part {part_index:04} unique={} duplicates={} rows={}",
                        unique, duplicates, result.rows
                    ),
                },
            );
        }

        progress.update(
            &token,
            ProgressUpdate::Rows {
                rows: total_rows,
                bytes: total_bytes,
            },
        );

        part_index += 1;
    }

    cache.store_manifest(&spec, &manifest)?;

    progress.finish(
        token,
        Some(ProgressUpdate::Message {
            message: "retrieve complete".to_string(),
        }),
    );
    Ok(())
}

fn parse_day(day: &str) -> anyhow::Result<u32> {
    let without_dash: String = day.chars().filter(|c| c.is_ascii_digit()).collect();
    without_dash
        .parse::<u32>()
        .map_err(|err| anyhow::anyhow!("invalid day {day}: {err}"))
}

fn instrument_id_from_symbol(symbol: &str) -> u32 {
    (xxh3_64(symbol.as_bytes()) & 0xFFFF_FFFF) as u32
}

fn normalize_and_dedup(
    normalizer: &DeribitNormalizer,
    chunk: &RawChunk,
    seen: &mut FxHashSet<(u32, u64, i64, u32, u8)>,
) -> anyhow::Result<Option<(u64, u64)>> {
    let ticks = normalizer.to_ticks(chunk.clone())?;
    if ticks.is_empty() {
        return Ok(None);
    }
    let mut unique = 0u64;
    let mut duplicates = 0u64;
    for tick in ticks {
        if seen.insert(tick.key()) {
            unique += 1;
        } else {
            duplicates += 1;
        }
    }
    Ok(Some((unique, duplicates)))
}
