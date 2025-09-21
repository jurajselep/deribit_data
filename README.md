# deribit_data

This workspace now hosts the `optstore` prototype: a Rust-based options tick store focused on fast ingest and low-latency reads.

## Quick Start

```bash
cd optstore

# Discover available instruments (optional helper)
curl 'https://www.deribit.com/api/v2/public/get_instruments?currency=ETH&kind=option&expired=true' \
  | jq '.result[].instrument_name' | head

# Retrieve ETH option data (replace symbol/day with one returned above)
cargo run -- retrieve \
  --source deribit \
  --symbol ETH-21SEP25-4200-C \
  --day 2025-09-21 \
  --out raw_cache/ \
  --rate 6

# Retrieve BTC option data
cargo run -- retrieve \
  --source deribit \
  --symbol BTC-28MAR25-60000-C \
  --day 2025-03-28 \
  --out raw_cache/ \
  --rate 6

# Re-run with --resume to continue filling the same partition
cargo run -- retrieve \
  --source deribit \
  --symbol ETH-21SEP25-4200-C \
  --day 2025-09-21 \
  --out raw_cache/ \
  --resume
```


The CLI prints per-chunk progress (percentage and ETA) while pages stream in; ETA is derived from trade timestamps across the requested UTC day.

## Design Variations

- Retrieval now persists a manifest per (symbol, day) partition, including resume tokens and per-part statistics, but the on-disk block layout still mirrors the baseline specification; ADR-0001 remains unchanged until we adopt a substantive storage variation.
- ⚠️ Deribit requires using the full option instrument name (including expiry, strike, and call/put suffix). If you receive `Deribit rejected instrument...` ensure you pass values like `ETH-21MAR25-4100-C` or `BTC-28MAR25-60000-C`.



## Lean 4 Arbitrage-Free SVI Surface

The `svi_surface/` folder contains a small Lean 4 project that models an
arbitrage-free SVI volatility slice in a purely functional way. It checks
classic Gatheral butterfly conditions and prints diagnostics for a sample
set of log-moneyness points.

```bash
cd svi_surface
lake build                     # compile the Lean library
lake exe svi-surface-test      # run the CLI diagnostics output
```

Sample output:

```
Arbitrage free? true
Sample variance slice:
  k=-2.0, w=0.289654
  k=-1.0, w=0.179198
  k=0.0, w=0.079000
  k=1.0, w=0.108231
  k=2.0, w=0.227710
Wing diagnostics passed? true
```

## Roadmap

- **Storage engine**: implement columnar block builder and append-only writer with compression (lz4/zstd), anchors, footers, Bloom filters, and WAL-based recovery.
- **Query engine**: add block pruning, selective scans, VWAP examples, and `--explain` plans with real column projections.
- **Progress UX**: extend `progress.rs` with block-level compression/fwrite bars, fsync stages, and machine-friendly `--json` snapshots.
- **Retrieval**: auto-discover instruments, support quotes/both feeds, add resume manifests, dedup spill-to-disk, and configurable rate/backoff strategies.
- **Ingestion pipeline**: consume cached raw parts, normalize to `Tick`, deduplicate, and write optstore partitions with compression metrics.
- **Testing & benchmarks**: flesh out round-trip, corrosion, dedup, `progress_json` cases; add end-to-end retrieve→ingest→query benchmarks.
- **Prompt inversion ADR**: evaluate checksum/anchor stride adjustments or other performance variations and update ADR-0001 accordingly.
