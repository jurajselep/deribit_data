use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use serde::Serialize;
use tracing::info;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProgressKind {
    Ingest {
        symbol: String,
        day: String,
    },
    Retrieve {
        symbol: String,
        day: String,
        source: String,
    },
    CompressBlock {
        id: u64,
        rows: usize,
    },
    WriteBlock {
        id: u64,
        bytes: usize,
    },
    Verify {
        file: String,
    },
    Query {
        description: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum ProgressUpdate {
    Message {
        message: String,
    },
    Rows {
        rows: u64,
        bytes: u64,
    },
    QueryResult {
        blocks_scanned: u64,
        blocks_pruned: u64,
        bytes_read: u64,
        projected_columns: Vec<String>,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct ProgressEvent {
    pub id: u64,
    pub kind: ProgressKind,
    pub update: Option<ProgressUpdate>,
    pub done: bool,
}

#[derive(Clone)]
pub struct ProgressHandle {
    pub id: u64,
    kind: ProgressKind,
}

pub struct Progress {
    json: bool,
    multi: Option<MultiProgress>,
    bars: HashMap<u64, ProgressBar>,
    id_gen: Arc<AtomicU64>,
}

impl Progress {
    pub fn new(quiet: bool, json: bool) -> Self {
        Self {
            json,
            multi: if quiet {
                None
            } else {
                Some(MultiProgress::new())
            },
            bars: HashMap::new(),
            id_gen: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn start(&mut self, kind: ProgressKind) -> ProgressHandle {
        let id = self.id_gen.fetch_add(1, Ordering::Relaxed);
        if let Some(multi) = &self.multi {
            let pb = multi.add(ProgressBar::new_spinner());
            pb.set_message(match &kind {
                ProgressKind::Ingest { symbol, day } => format!("Ingest {symbol} {day}"),
                ProgressKind::Retrieve {
                    symbol,
                    day,
                    source,
                } => {
                    format!("Retrieve {symbol} {day} via {source}")
                }
                ProgressKind::CompressBlock { id, rows } => {
                    format!("Compress block #{id} ({rows} rows)")
                }
                ProgressKind::WriteBlock { id, bytes } => {
                    format!("Write block #{id} ({bytes} bytes)")
                }
                ProgressKind::Verify { file } => format!("Verify {file}"),
                ProgressKind::Query { description } => description.clone(),
            });
            pb.set_style(
                ProgressStyle::with_template("{spinner} {msg}")
                    .unwrap()
                    .tick_chars("⠁⠂⠄⡀⢀⠠⠐⠈ "),
            );
            self.bars.insert(id, pb.clone());
        }

        if self.json {
            emit_event(id, kind.clone(), None, false);
        }

        ProgressHandle { id, kind }
    }

    pub fn update(&mut self, token: &ProgressHandle, update: ProgressUpdate) {
        if let Some(bar) = self.bars.get(&token.id) {
            match &update {
                ProgressUpdate::Message { message } => bar.set_message(message.clone()),
                ProgressUpdate::Rows { rows, bytes } => {
                    bar.set_message(format!("{} rows={} bytes={}", bar.message(), rows, bytes));
                }
                ProgressUpdate::QueryResult { .. } => {}
            }
        }
        if self.json {
            emit_event(token.id, token.kind.clone(), Some(update), false);
        }
    }

    pub fn finish(&mut self, token: ProgressHandle, final_update: Option<ProgressUpdate>) {
        if let Some(bar) = self.bars.remove(&token.id) {
            bar.finish_and_clear();
        }
        if self.json {
            emit_event(token.id, token.kind.clone(), final_update, true);
        }
    }
}

fn emit_event(id: u64, kind: ProgressKind, update: Option<ProgressUpdate>, done: bool) {
    let event = ProgressEvent {
        id,
        kind,
        update,
        done,
    };
    match serde_json::to_string(&event) {
        Ok(line) => println!("{}", line),
        Err(err) => info!(target: "optstore::progress", ?err, "failed to serialize progress event"),
    }
}

#[derive(Clone)]
pub struct ProgressToken(pub ProgressHandle);

#[derive(Clone)]
pub enum ProgressKindWrapper {
    Ingest,
}
