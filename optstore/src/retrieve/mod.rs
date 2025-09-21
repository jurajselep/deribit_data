use crate::progress::{Progress, ProgressKind, ProgressUpdate};
use clap::{Parser, ValueEnum};
use std::path::PathBuf;
use tracing::warn;

pub mod cache;
pub mod deribit;
pub mod normalize;

use async_trait::async_trait;
use bytes::Bytes;
pub use cache::{CacheManager, CacheWriteResult};
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
        resume_from: Option<String>,
    ) -> anyhow::Result<Vec<RawChunk>>;
    fn name(&self) -> &'static str;
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

    let chunks = match cmd.source.as_str() {
        "deribit" => {
            let source = DeribitSource::new(cmd.rate);
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            rt.block_on(source.fetch(&spec, None))?
        }
        other => {
            warn!(target: "optstore::retrieve", ?other, "unknown source");
            Vec::new()
        }
    };

    for (idx, chunk) in chunks.into_iter().enumerate() {
        let result = cache.write_chunk(&spec, idx as u32, &chunk)?;
        progress.update(
            &token,
            ProgressUpdate::Rows {
                rows: result.rows,
                bytes: result.bytes_written,
            },
        );
    }

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
