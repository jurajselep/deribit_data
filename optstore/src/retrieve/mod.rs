use crate::progress::{Progress, ProgressKind, ProgressUpdate};
use clap::{Parser, ValueEnum};
use fxhash::FxHashSet;
use std::path::PathBuf;
use std::time::Instant;
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
    pub start_ms: u64,
    pub end_ms: u64,
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

    let (start_ms, end_ms) = day_bounds_ms(spec.day_ymd)?;
    let started_at = Instant::now();
    let mut last_progress_ratio = progress_ratio_from_manifest(&manifest, start_ms, end_ms);

    let options = RetrieveOptions {
        resume_from: if cmd.resume {
            manifest.resume_token.clone()
        } else {
            None
        },
        max_pages: (cmd.max_pages > 0).then_some(cmd.max_pages),
        start_ms,
        end_ms,
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

        let unique_summary = normalize_and_dedup(
            &normalizer,
            &chunk,
            &mut dedup,
            options.start_ms * 1_000_000,
            options.end_ms * 1_000_000,
        )?;

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

        if let Some(ratio) = progress_ratio_for_chunk(&chunk, options.start_ms, options.end_ms) {
            if ratio >= last_progress_ratio + 0.01 || ratio >= 1.0 {
                last_progress_ratio = ratio;
                let elapsed = started_at.elapsed();
                let eta = if ratio > 0.0 && ratio < 1.0 {
                    let remaining = elapsed.as_secs_f64() * (1.0 - ratio) / ratio;
                    Some(human_duration(remaining))
                } else {
                    None
                };
                let message = match eta {
                    Some(eta) => format!("progress {:.1}% (eta {})", ratio * 100.0, eta),
                    None => format!("progress {:.1}%", ratio * 100.0),
                };
                progress.update(&token, ProgressUpdate::Message { message });
            }
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

fn day_bounds_ms(day: u32) -> anyhow::Result<(u64, u64)> {
    use chrono::{Duration, NaiveDate};
    let year = (day / 10_000) as i32;
    let month = ((day / 100) % 100) as u32;
    let day_of_month = (day % 100) as u32;
    let date = NaiveDate::from_ymd_opt(year, month, day_of_month)
        .ok_or_else(|| anyhow::anyhow!("invalid day code {day}"))?;
    let start = date.and_hms_opt(0, 0, 0).unwrap();
    let end = start + Duration::hours(24) - Duration::milliseconds(1);
    let start_ms = start.and_utc().timestamp_millis() as u64;
    let end_ms = end.and_utc().timestamp_millis() as u64;
    Ok((start_ms, end_ms))
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
    start_ns: u64,
    end_ns: u64,
) -> anyhow::Result<Option<(u64, u64)>> {
    let ticks = normalizer.to_ticks(chunk.clone())?;
    if ticks.is_empty() {
        return Ok(None);
    }
    let mut unique = 0u64;
    let mut duplicates = 0u64;
    for tick in ticks {
        if tick.ts_ns < start_ns || tick.ts_ns > end_ns {
            continue;
        }
        if seen.insert(tick.key()) {
            unique += 1;
        } else {
            duplicates += 1;
        }
    }
    Ok(Some((unique, duplicates)))
}

fn progress_ratio_for_chunk(chunk: &RawChunk, start_ms: u64, end_ms: u64) -> Option<f64> {
    if end_ms <= start_ms {
        return None;
    }
    let end_ms_clamped = (chunk.end_ns / 1_000_000).min(end_ms);
    if end_ms_clamped < start_ms {
        return Some(0.0);
    }
    let progress = end_ms_clamped - start_ms;
    Some(progress as f64 / (end_ms - start_ms) as f64)
}

fn progress_ratio_from_manifest(manifest: &CacheManifest, start_ms: u64, end_ms: u64) -> f64 {
    if let Some(token) = &manifest.resume_token {
        if let Ok(ms) = token.parse::<u64>() {
            if ms > start_ms && end_ms > start_ms {
                return ((ms.min(end_ms) - start_ms) as f64 / (end_ms - start_ms) as f64)
                    .clamp(0.0, 1.0);
            }
        }
    }
    if let Some(parts_last) = manifest.parts.last() {
        let end_ms_clamped = (parts_last.end_ns / 1_000_000).min(end_ms);
        if end_ms_clamped <= start_ms {
            return 0.0;
        }
        return ((end_ms_clamped - start_ms) as f64 / (end_ms - start_ms) as f64).clamp(0.0, 1.0);
    }
    0.0
}

fn human_duration(seconds: f64) -> String {
    if !seconds.is_finite() || seconds.is_sign_negative() {
        return "unknown".to_string();
    }
    let secs = seconds.round() as u64;
    let hours = secs / 3600;
    let minutes = (secs % 3600) / 60;
    let secs_rem = secs % 60;
    if hours > 0 {
        format!("{}h {}m {}s", hours, minutes, secs_rem)
    } else if minutes > 0 {
        format!("{}m {}s", minutes, secs_rem)
    } else {
        format!("{}s", secs_rem)
    }
}
