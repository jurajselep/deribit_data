use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use std::time::Instant;

use anyhow::{Context, Result};
use serde::Deserialize;
use tracing::{info, warn};

use crate::{
    progress::{Progress, ProgressHandle, ProgressUpdate},
    schema::Tick,
};

#[derive(Debug, Deserialize)]
struct InputTick {
    ts_ns: u64,
    instrument_id: u32,
    event: u8,
    price_fp: i64,
    size: u32,
}

pub fn ingest_jsonl(
    input: &str,
    out: &str,
    progress: &mut Progress,
    token: ProgressHandle,
) -> Result<()> {
    let file = File::open(input).with_context(|| format!("open input {input}"))?;
    let reader = BufReader::new(file);

    let out_path = Path::new(out);
    crate::util::ensure_parent_dir(out_path)?;
    let mut writer = BufWriter::new(File::create(out_path)?);

    let mut rows = 0_u64;
    let mut bytes = 0_u64;
    let start = Instant::now();

    for line_res in reader.lines() {
        let line = line_res?;
        bytes += line.len() as u64;
        match serde_json::from_str::<InputTick>(&line) {
            Ok(raw) => {
                let tick = Tick {
                    ts_ns: raw.ts_ns,
                    instrument_id: raw.instrument_id,
                    event: raw.event,
                    price_fp: raw.price_fp,
                    size: raw.size,
                    bid_px_fp: [0; 4],
                    ask_px_fp: [0; 4],
                    bid_sz: [0; 4],
                    ask_sz: [0; 4],
                    flags: 0,
                };
                writer.write_all(&tick.ts_ns.to_le_bytes())?;
                rows += 1;
                if rows % 10_000 == 0 {
                    progress.update(&token, ProgressUpdate::Rows { rows, bytes });
                }
            }
            Err(err) => {
                warn!(target: "optstore::ingest", ?err, "failed to parse tick; skipping");
            }
        }
    }

    writer.flush()?;
    info!(
        target: "optstore::ingest",
        rows,
        bytes,
        elapsed = ?start.elapsed(),
        "ingest placeholder complete"
    );

    progress.update(&token, ProgressUpdate::Rows { rows, bytes });
    Ok(())
}
