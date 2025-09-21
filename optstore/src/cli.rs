use clap::{Parser, Subcommand};
use tracing::info;

use crate::{
    progress::ProgressKind,
    retrieve::{self, RetrieveCommand},
    writer,
};

#[derive(Parser, Debug)]
#[command(name = "optstore", version, about = "Options tick storage toolkit")]
pub struct OptStoreCli {
    #[command(subcommand)]
    command: Commands,

    /// Suppress human-readable progress output
    #[arg(global = true, long = "quiet", default_value_t = false)]
    pub quiet: bool,

    /// Emit machine readable JSON progress events
    #[arg(global = true, long = "json", default_value_t = false)]
    pub json: bool,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Retrieve raw data from an upstream source and cache locally
    Retrieve(RetrieveCommand),
    /// Ingest ticks from a cached/raw source into an optstore file
    Ingest(IngestCommand),
    /// Execute a query against stored data (placeholder)
    Query(QueryCommand),
}

#[derive(Parser, Debug)]
pub struct IngestCommand {
    /// Input path containing JSONL ticks (possibly cached)
    #[arg(long)]
    pub input: String,
    /// Output optstore file path
    #[arg(long)]
    pub out: String,
    /// Day (YYYY-MM-DD)
    #[arg(long)]
    pub day: String,
}

#[derive(Parser, Debug)]
pub struct QueryCommand {
    /// Path to optstore file
    #[arg(long)]
    pub file: String,
    /// Optional explain without executing
    #[arg(long = "explain", default_value_t = false)]
    pub explain: bool,
    /// Instrument filter
    #[arg(long)]
    pub instrument: Option<String>,
}

impl OptStoreCli {
    pub fn parse() -> Self {
        <OptStoreCli as Parser>::parse()
    }

    pub fn execute(self) -> anyhow::Result<()> {
        match self.command {
            Commands::Retrieve(cmd) => retrieve::run(cmd, self.quiet, self.json),
            Commands::Ingest(cmd) => run_ingest(cmd, self.quiet, self.json),
            Commands::Query(cmd) => run_query(cmd, self.quiet, self.json),
        }
    }
}

fn run_ingest(cmd: IngestCommand, quiet: bool, json: bool) -> anyhow::Result<()> {
    let mut progress = crate::progress::Progress::new(quiet, json);
    let token = progress.start(ProgressKind::Ingest {
        symbol: "local".to_string(),
        day: cmd.day.clone(),
    });
    info!(target: "optstore::ingest", input = %cmd.input, out = %cmd.out, "starting ingest placeholder");

    writer::ingest_jsonl(&cmd.input, &cmd.out, &mut progress, token.clone())?;

    progress.finish(token, None);
    Ok(())
}

fn run_query(cmd: QueryCommand, quiet: bool, json: bool) -> anyhow::Result<()> {
    let mut progress = crate::progress::Progress::new(quiet, json);
    let token = progress.start(ProgressKind::Query {
        description: format!(
            "file={} instrument={}",
            cmd.file,
            cmd.instrument.as_deref().unwrap_or("*")
        ),
    });
    if cmd.explain {
        info!(target: "optstore::query", "explain not yet implemented");
    } else {
        info!(target: "optstore::query", "query execution placeholder");
    }
    progress.finish(
        token,
        Some(crate::progress::ProgressUpdate::QueryResult {
            blocks_scanned: 0,
            blocks_pruned: 0,
            bytes_read: 0,
            projected_columns: vec![],
        }),
    );
    Ok(())
}
